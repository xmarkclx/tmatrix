import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import { mkdtemp, readdir, readlink, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationStore } from "../src/conversation-store.js";
import { LEASE_ENV, processStart } from "../src/conversation-recovery.js";
import { makeTicket } from "./helpers.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

const children: ChildProcess[] = [];
const detached: number[] = [];
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const pid of detached.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch {} }
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    }
  }
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe.skipIf(process.platform !== "linux")("real orphan runtime recovery", () => {
  it("stops tagged orphan descendants, leaves other runs alive, and preserves conversation routing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tmatrix-recovery-process-"));
    directories.push(directory);
    const store = new ConversationStore({ directory, namespace: "https://fictional.example.test", trackRuntime: true });
    const ticket = makeTicket({ task_id: "fictional-orphan-task" });
    await store.remember(ticket, "original-thread");
    const lease = await store.acquire(ticket);
    expect(lease.environment?.[LEASE_ENV]).toBeDefined();
    const folder = join(directory, (await readdir(directory))[0]!);
    const lock = join(folder, (await readdir(folder)).find(name => name.endsWith(".lock"))!);
    const owner = JSON.parse(await readlink(lock));
    await lease();
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      env: { ...process.env, [LEASE_ENV]: randomUUID() }, stdio: "ignore"
    });
    children.push(unrelated);
    await once(unrelated, "spawn");
    const orphan = spawn(process.execPath, ["-e", `
      const {spawn} = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {detached: true, stdio: 'ignore'});
      child.unref();
      console.log(child.pid);
    `], { env: { ...process.env, ...lease.environment }, stdio: ["ignore", "pipe", "ignore"] });
    children.push(orphan);
    const finished = once(orphan, "exit");
    const [output] = await once(orphan.stdout!, "data");
    const orphanPid = Number(String(output).trim());
    detached.push(orphanPid);
    await finished;
    expect(await processStart(orphanPid)).toBeDefined();
    await symlink(JSON.stringify({ ...owner, pid: 2147483647 }), lock);
    // Exercise real process inspection/signalling against fixture processes.
    // Unrelated user services can make /proc/environ inaccessible, correctly
    // blocking production recovery but making this success-path test flaky.
    // Denied inspection is covered separately by conversation-recovery.test.ts.
    const readDirectory = vi.mocked(fs.readdir).getMockImplementation()!;
    vi.spyOn(fs, "readdir").mockImplementation(async (...args) => String(args[0]) === "/proc"
      ? [String(orphanPid), String(unrelated.pid)] as never
      : readDirectory(...args));
    const recovered = await store.acquire(ticket);
    expect(recovered.recovered).toBe(true);
    expect(await processStart(orphanPid)).toBeUndefined();
    expect(await processStart(unrelated.pid!)).toBeDefined();
    expect(await store.resolve(ticket, {})).toBe("original-thread");
    expect(recovered.environment?.[LEASE_ENV]).not.toBe(lease.environment?.[LEASE_ENV]);
    await recovered();
  }, 15_000);
});
