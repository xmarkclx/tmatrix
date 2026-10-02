import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CODEX_CHECK_INTERVAL_MS, CodexUpdateManager } from "../src/adapters/codex/update-manager.js";
import type { CodexRelease } from "../src/adapters/codex/release.js";
import { CodexProbeCleanupError } from "../src/adapters/codex/probe.js";
import { deferred } from "./helpers.js";

const directories: string[] = [];
const managers: CodexUpdateManager[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(managers.splice(0).map(manager => manager.close()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "tmatrix-codex-update-"));
  directories.push(directory);
  const bundle = join(directory, "bundle");
  await mkdir(bundle);
  await writeFile(join(bundle, "codex"), "original");
  await writeFile(join(bundle, "rg"), "helper");
  let version = "0.2.0";
  const latest = vi.fn(async () => ({ version }) as CodexRelease);
  const install = vi.fn(async (_release: CodexRelease, candidate: string) => {
    await mkdir(join(candidate, "bin"));
    const path = join(candidate, "bin", "codex");
    await writeFile(path, _release.version);
    return path;
  });
  const verify = vi.fn(async () => {});
  const options = {
    directory: join(directory, "store"), bundled: { version: "0.1.0", executablePath: join(bundle, "codex"), directory: bundle },
    environment: { CODEX_HOME: "/fictional/account" }, latest, install, verify
  };
  const manager = new CodexUpdateManager(options);
  managers.push(manager);
  await manager.initialize();
  return { manager, options, latest, install, verify, setVersion(value: string) { version = value; } };
}

describe("Codex update lifecycle", () => {
  it("keeps startup and worker admission independent of a pending network check, and coalesces manual checks", async () => {
    const { manager, latest, options } = await setup();
    const pending = deferred<CodexRelease>();
    latest.mockImplementationOnce(() => pending.promise);
    manager.start();
    expect(manager.snapshot().status).toBe("checking");
    expect(manager.acquire().executablePath).toBe(options.bundled.executablePath);
    const manual = manager.checkNow();
    expect(latest).toHaveBeenCalledTimes(1);
    pending.resolve({ version: "0.1.0" } as CodexRelease);
    await manual;
    expect(manager.snapshot().status).toBe("up_to_date");
  });

  it("checks on startup and every 24 hours, including after failed checks", async () => {
    const { manager, latest } = await setup();
    latest.mockRejectedValue(new Error("private network error"));
    vi.useFakeTimers();
    manager.start();
    await manager.checkNow();
    expect(latest).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CODEX_CHECK_INTERVAL_MS - 1);
    expect(latest).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(latest).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(manager.snapshot())).not.toContain("private network error");
    await manager.close();
    await vi.advanceTimersByTimeAsync(CODEX_CHECK_INTERVAL_MS);
    expect(latest).toHaveBeenCalledTimes(2);
  });

  it("activates only after verification, preserving bundled helpers and authentication context", async () => {
    const { manager, verify, options } = await setup();
    const gate = deferred<void>();
    verify.mockImplementationOnce(() => gate.promise);
    const check = manager.checkNow();
    await vi.waitFor(() => expect(verify).toHaveBeenCalled());
    expect(manager.snapshot().status).toBe("verifying");
    expect(manager.acquire().executablePath).toBe(options.bundled.executablePath);
    expect(verify).toHaveBeenCalledWith(expect.stringContaining(".candidate-"), "0.2.0", options.environment, expect.any(AbortSignal));
    gate.resolve();
    await check;
    const lease = manager.acquire();
    expect(await readFile(lease.executablePath, "utf8")).toBe("0.2.0");
    expect(manager.snapshot()).toMatchObject({ current_version: "0.2.0", previous_version: "0.1.0", status: "updated" });
    const manifest = JSON.parse(await readFile(join(options.directory, "current.json"), "utf8"));
    expect(await readFile(join(options.directory, manifest.previous.directory, "rg"), "utf8")).toBe("helper");
    expect(JSON.stringify(manifest)).not.toContain("account");
    lease.release();
  });

  it.each(["download", "probe"])("retains the current version when %s fails", async stage => {
    const { manager, install, verify, options } = await setup();
    const failure = new Error("private-token-should-not-leak");
    if (stage === "download") install.mockRejectedValueOnce(failure);
    else verify.mockRejectedValueOnce(failure);
    await manager.checkNow();
    expect(manager.acquire().executablePath).toBe(options.bundled.executablePath);
    expect(manager.snapshot().status).toBe("failed");
    expect(JSON.stringify(manager.snapshot())).not.toContain(failure.message);
    expect((await readdir(options.directory)).filter(name => name.startsWith(".candidate"))).toEqual([]);
    await manager.checkNow();
    expect(manager.snapshot().current_version).toBe("0.2.0");
  });

  it("never deletes a failed probe candidate when exit could not be verified", async () => {
    const { manager, verify, options } = await setup();
    verify.mockRejectedValueOnce(new CodexProbeCleanupError());
    await manager.checkNow();
    expect(manager.snapshot().status).toBe("failed");
    expect((await readdir(options.directory)).filter(name => name.startsWith(".candidate"))).toHaveLength(1);
  });

  it.each(["0.3.0-beta.1", "0.2.0+test", "../other", "0.0.9"])("never installs unstable, invalid or older release %s", async version => {
    const { manager, setVersion, install } = await setup();
    setVersion(version);
    await manager.checkNow();
    expect(install).not.toHaveBeenCalled();
    expect(manager.snapshot().current_version).toBe("0.1.0");
  });

  it("retains current, previous and all worker-pinned versions; collects only after confirmed release", async () => {
    const { manager, setVersion, options } = await setup();
    await manager.checkNow();
    const firstWorker = manager.acquire();
    const anotherWorker = manager.acquire();
    setVersion("0.3.0"); await manager.checkNow();
    setVersion("0.4.0"); await manager.checkNow();
    expect(await readFile(firstWorker.executablePath, "utf8")).toBe("0.2.0");
    expect(manager.snapshot()).toMatchObject({ current_version: "0.4.0", previous_version: "0.3.0" });
    firstWorker.release(); firstWorker.release();
    await access(anotherWorker.executablePath);
    anotherWorker.release();
    await vi.waitFor(async () => { await expect(access(firstWorker.executablePath)).rejects.toThrow(); });
    await vi.waitFor(async () => {
      expect((await readdir(options.directory)).filter(name => name.startsWith("v-"))).toHaveLength(2);
    });
  });

  it("restores the current version after restart and retains durable pins from an uncertain old worker", async () => {
    const { manager, options, setVersion } = await setup();
    await manager.checkNow();
    const oldWorker = manager.acquire();
    await manager.close();
    const replacement = new CodexUpdateManager(options);
    managers.push(replacement);
    await replacement.initialize();
    expect(replacement.snapshot().current_version).toBe("0.2.0");
    setVersion("0.3.0"); await replacement.checkNow();
    setVersion("0.4.0"); await replacement.checkNow();
    await access(oldWorker.executablePath);
    expect((await readdir(join(dirname(dirname(oldWorker.executablePath)), ".pins")))).toHaveLength(1);
  });

  it("rolls back for new workers and skips the rejected release across restart", async () => {
    const { manager, options, setVersion, install } = await setup();
    await manager.checkNow();
    const worker = manager.acquire();
    await manager.rollback();
    expect(manager.snapshot()).toMatchObject({ current_version: "0.1.0", previous_version: "0.2.0" });
    expect(await readFile(worker.executablePath, "utf8")).toBe("0.2.0");
    await manager.close();
    const replacement = new CodexUpdateManager(options); managers.push(replacement);
    await replacement.initialize();
    await replacement.checkNow();
    expect(install).toHaveBeenCalledTimes(1);
    setVersion("0.3.0"); await replacement.checkNow();
    expect(replacement.snapshot().current_version).toBe("0.3.0");
    worker.release();
  });

  it("does not activate a rollback that fails verification", async () => {
    const { manager, verify } = await setup();
    await manager.checkNow();
    verify.mockRejectedValueOnce(new Error("incompatible"));
    await manager.rollback();
    expect(manager.snapshot()).toMatchObject({ status: "failed", current_version: "0.2.0" });
  });

  it("refuses concurrent store ownership without preventing bundled workers", async () => {
    const { manager, options } = await setup();
    await manager.checkNow();
    const other = new CodexUpdateManager(options); managers.push(other);
    await other.initialize();
    expect(other.snapshot().status).toBe("disabled");
    expect(other.acquire().executablePath).toBe(options.bundled.executablePath);
    await other.checkNow();
    expect(manager.snapshot().current_version).toBe("0.2.0");
  });

  it("preserves invalid state and falls back to bundled workers", async () => {
    const { manager, options } = await setup();
    await manager.close();
    await writeFile(join(options.directory, "current.json"), '{"private":"invalid"}');
    const other = new CodexUpdateManager(options); managers.push(other);
    await other.initialize();
    expect(other.snapshot().status).toBe("disabled");
    expect(other.acquire().executablePath).toBe(options.bundled.executablePath);
    expect(await readFile(join(options.directory, "current.json"), "utf8")).toBe('{"private":"invalid"}');
  });

  it("aborts a check on shutdown without activating or stopping workers", async () => {
    const { manager, latest, options } = await setup();
    latest.mockImplementationOnce((signal?: AbortSignal) => new Promise((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    manager.start();
    const worker = manager.acquire();
    await manager.close();
    expect(worker.executablePath).toBe(options.bundled.executablePath);
    expect(manager.snapshot().current_version).toBe("0.1.0");
    await manager.checkNow();
    expect(latest).toHaveBeenCalledTimes(1);
  });
});
