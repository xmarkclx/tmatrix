import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexUpdateManager } from "../src/adapters/codex/update-manager.js";
import type { CodexRelease } from "../src/adapters/codex/release.js";
import { deferred } from "./helpers.js";

const faults = vi.hoisted(() => ({ rejectManifestRename: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    rename: async (from: string, to: string) => {
      if (faults.rejectManifestRename && from.includes(".manifest-")) throw new Error("Simulated publication failure");
      return original.rename(from, to);
    }
  };
});

const directories: string[] = [];
const managers: CodexUpdateManager[] = [];
afterEach(async () => {
  faults.rejectManifestRename = false;
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(initialize = true) {
  const directory = await mkdtemp(join(tmpdir(), "tmatrix-update-failure-"));
  directories.push(directory);
  const bundle = join(directory, "bundle");
  await mkdir(bundle);
  await writeFile(join(bundle, "codex"), "0.1.0");
  let version = "0.2.0";
  const latest = vi.fn(async () => ({ version }) as CodexRelease);
  const verify = vi.fn(async (executable: string) => { await access(executable); });
  const options = {
    directory: join(directory, "store"),
    bundled: { version: "0.1.0", directory: bundle, executablePath: join(bundle, "codex") },
    environment: {},
    latest,
    install: async (release: CodexRelease, candidate: string) => {
      const path = join(candidate, "codex");
      await writeFile(path, release.version);
      return path;
    },
    verify
  };
  const manager = new CodexUpdateManager(options);
  managers.push(manager);
  if (initialize) await manager.initialize();
  return { manager, options, latest, verify, setVersion(value: string) { version = value; } };
}

describe("Codex updater recovery and operation boundaries", () => {
  it("keeps the previous durable pointer and worker version when atomic publication fails", async () => {
    const { manager, options, setVersion } = await fixture();
    await manager.checkNow();
    const worker = manager.acquire();
    const before = await readFile(join(options.directory, "current.json"), "utf8");
    faults.rejectManifestRename = true;
    setVersion("0.3.0");
    await manager.checkNow();
    expect(manager.snapshot()).toMatchObject({ status: "failed", current_version: "0.2.0", previous_version: "0.1.0" });
    expect(await readFile(join(options.directory, "current.json"), "utf8")).toBe(before);
    const nextWorker = manager.acquire();
    expect(nextWorker.executablePath).toBe(worker.executablePath);
    expect(await readFile(worker.executablePath, "utf8")).toBe("0.2.0");
    expect((await readdir(options.directory)).filter(name => name.startsWith(".manifest-"))).toEqual([]);
    worker.release();
    nextWorker.release();
  });

  it("does not collect a new installation while an old worker releases its pin during verification", async () => {
    const { manager, options, setVersion, verify } = await fixture();
    await manager.checkNow();
    const oldWorker = manager.acquire();
    setVersion("0.3.0");
    await manager.checkNow();
    const verification = deferred<void>();
    let candidate = "";
    verify.mockImplementationOnce(async (path) => { candidate = path; await verification.promise; });
    setVersion("0.4.0");
    const check = manager.checkNow();
    await vi.waitFor(() => expect(candidate).not.toBe(""));
    oldWorker.release();
    await access(candidate);
    expect(manager.snapshot().current_version).toBe("0.3.0");
    verification.resolve();
    await check;
    expect(manager.snapshot()).toMatchObject({ status: "updated", current_version: "0.4.0", previous_version: "0.3.0" });
    const worker = manager.acquire();
    expect(await readFile(worker.executablePath, "utf8")).toBe("0.4.0");
    await vi.waitFor(async () => {
      expect((await readdir(options.directory)).filter(name => name.startsWith("v-"))).toHaveLength(2);
    });
    worker.release();
  });

  it("rejects a rollback arriving during a check instead of acknowledging an action it never performs", async () => {
    const { manager, latest } = await fixture();
    await manager.checkNow();
    const lookup = deferred<CodexRelease>();
    latest.mockImplementationOnce(() => lookup.promise);
    const check = manager.checkNow();
    await expect(manager.rollback()).rejects.toThrow("already in progress");
    lookup.resolve({ version: "0.2.0" } as CodexRelease);
    await check;
    expect(manager.snapshot().current_version).toBe("0.2.0");
    await manager.rollback();
    expect(manager.snapshot().current_version).toBe("0.1.0");
  });

  it("loads a healthy current installation when the previous directory is missing and rejects the unavailable rollback", async () => {
    const { manager, options } = await fixture();
    await manager.checkNow();
    const manifest = JSON.parse(await readFile(join(options.directory, "current.json"), "utf8"));
    await manager.close();
    await rm(join(options.directory, manifest.previous.directory), { recursive: true });
    const replacement = new CodexUpdateManager(options);
    managers.push(replacement);
    await replacement.initialize();
    expect(replacement.snapshot()).toMatchObject({ status: "idle", current_version: "0.2.0" });
    await replacement.rollback();
    expect(replacement.snapshot()).toMatchObject({ status: "failed", current_version: "0.2.0" });
    const worker = replacement.acquire();
    expect(await readFile(worker.executablePath, "utf8")).toBe("0.2.0");
    worker.release();
  });

  it("recovers an updater owner only after its process has exited and publishes a complete replacement", async () => {
    const { manager, options } = await fixture(false);
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    await once(child, "exit");
    expect(child.pid).toBeDefined();
    const lock = join(options.directory, ".owner");
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: child.pid, token: "old-owner" }));
    await manager.initialize();
    expect(manager.snapshot().status).toBe("idle");
    const owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8"));
    expect(owner.pid).toBe(process.pid);
    expect(owner.token).not.toBe("old-owner");
    expect((await readdir(options.directory)).filter(name => name.startsWith(".owner-") || name === ".owner.recovery"))
      .toEqual([]);
    await manager.checkNow();
    expect(manager.snapshot().current_version).toBe("0.2.0");
  });
});
