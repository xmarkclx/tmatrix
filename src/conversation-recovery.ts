import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export const LEASE_ENV = "TMATRIX_CONVERSATION_LEASE";

/** Compare inode creation/change time to the kernel's boot epoch, not lock age.
 * This migration path is only for same-host legacy locks without boot metadata.
 * Reject unsupported filesystems and inconsistent wall clocks rather than guess.
 */
export async function legacyLockPredatesBoot(path: string): Promise<boolean> {
  if (process.platform !== "linux") return false;
  try {
    const [lock, system, uptime] = await Promise.all([
      lstat(path), readFile("/proc/stat", "utf8"), readFile("/proc/uptime", "utf8")
    ]);
    const boot = Number(/^btime (\d+)$/m.exec(system)?.[1]) * 1000;
    const elapsed = Number(uptime.split(" ")[0]) * 1000;
    const now = Date.now();
    if (!lock.isSymbolicLink() || !Number.isFinite(boot) || !Number.isFinite(elapsed) ||
        boot <= 0 || Math.abs(now - boot - elapsed) > 2000) return false;
    // birthtime cannot be set with touch; ctime also rejects copies/rewrites.
    return lock.birthtimeMs > 0 && lock.birthtimeMs < boot - 2000 && lock.ctimeMs < boot - 2000;
  } catch { return false; }
}

type ProcessIdentity = { pid: number; start: string };

async function identity(pid: number): Promise<ProcessIdentity | undefined> {
  try {
    const contents = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = contents.slice(contents.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z" || fields[0] === "X") return undefined;
    const start = fields[19];
    if (!start || !/^\d+$/.test(start)) throw new Error("Invalid process identity");
    return { pid, start };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function processStart(pid: number): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  try { return (await identity(pid))?.start; } catch { return undefined; }
}

/** Private environment inspection: never return/log process environments. */
async function leaseProcesses(token: string, startedAfter: string): Promise<ProcessIdentity[]> {
  const result: ProcessIdentity[] = [];
  const uid = process.getuid?.();
  if (process.platform !== "linux" || uid === undefined) throw new Error("Runtime recovery needs Linux process inspection");
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    try {
      if ((await stat(`/proc/${pid}`)).uid !== uid) continue;
      const before = await identity(pid);
      // Processes older than the owning daemon cannot have inherited its tag.
      // This also avoids inspecting unrelated privileged user services.
      if (!before || BigInt(before.start) < BigInt(startedAfter)) continue;
      const environment = await readFile(`/proc/${pid}/environ`);
      const matches = environment.toString().split("\0").includes(`${LEASE_ENV}=${token}`);
      const after = await identity(pid);
      if (matches && after?.start === before.start) result.push(before);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH") continue;
      // /proc may deny environ while a process is exiting. Only ignore that
      // failure when a new stat read confirms it is gone or already a zombie.
      if (!await identity(pid)) continue;
      throw error;
    }
  }
  return result;
}

/** Only leases explicitly tagged at runtime creation are eligible. The caller
 * must establish that their daemon is dead and hold the recovery guard first.
 * Recheck PID birth identity before each signal; rescan for inherited children.
 */
export async function stopLeaseProcesses(token: string, signal?: AbortSignal, startedAfter = "0"): Promise<boolean> {
  if (process.platform !== "linux") return false;
  try {
    const deadline = performance.now() + 5000;
    let empty = false;
    for (;;) {
      signal?.throwIfAborted();
      const targets = await leaseProcesses(token, startedAfter);
      if (targets.length === 0) {
        if (empty) return true;
        empty = true;
      } else {
        empty = false;
        for (const target of targets) {
          signal?.throwIfAborted();
          if ((await identity(target.pid))?.start !== target.start) continue;
          try { process.kill(target.pid, performance.now() < deadline - 3500 ? "SIGTERM" : "SIGKILL"); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
      }
      if (performance.now() >= deadline) return false;
      await delay(50, undefined, signal ? { signal } : {});
    }
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}
