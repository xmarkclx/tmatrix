import { constants } from "node:fs";
import { access, mkdir, readFile, readdir, realpath, rmdir, statfs, writeFile } from "node:fs/promises";
import { basename, join, normalize } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const CGROUP_ENV = "TMATRIX_CONVERSATION_CGROUP";
const root = "/sys/fs/cgroup";
const cgroup2Magic = 0x63677270;

export function validLeaseCgroup(path: string, token: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(token) &&
    path.startsWith(`${root}/`) && !path.endsWith("/") && normalize(path) === path &&
    !path.includes("\0") && basename(path) === `tmatrix-lease-${token}`;
}

function code(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

export async function createLeaseCgroup(token: string): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  let created: string | undefined;
  try {
    if ((await statfs(root)).type !== cgroup2Magic) return undefined;
    const membership = /^0::(\/[^\n]*)$/m.exec(await readFile("/proc/self/cgroup", "utf8"))?.[1];
    if (!membership) return undefined;
    const path = `${root}${membership === "/" ? "" : membership}/tmatrix-lease-${token}`;
    if (!validLeaseCgroup(path, token) || await realpath(join(path, "..")) !== join(path, "..")) return undefined;
    await mkdir(path);
    created = path;
    await access(join(path, "cgroup.kill"), constants.W_OK);
    await access(join(path, "cgroup.procs"), constants.W_OK);
    return path;
  } catch {
    if (created) await rmdir(created);
    return undefined;
  }
}

async function removeEmptyTree(path: string): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) await removeEmptyTree(join(path, entry.name));
  }
  await rmdir(path);
}

/** Removal closes the launch race: an empty group alone can still accept a process. */
export async function stopLeaseCgroup(path: string, token: string, signal?: AbortSignal): Promise<boolean> {
  if (process.platform !== "linux" || !validLeaseCgroup(path, token)) return false;
  try {
    signal?.throwIfAborted();
    if ((await statfs(root)).type !== cgroup2Magic) return false;
    const deadline = performance.now() + 5000;
    for (;;) {
      signal?.throwIfAborted();
      try {
        if (await realpath(path) !== path) return false;
        await writeFile(join(path, "cgroup.kill"), "1");
        await removeEmptyTree(path);
        return true;
      } catch (error) {
        if (code(error) === "ENOENT") {
          try { await realpath(path); } catch (missing) {
            if (code(missing) === "ENOENT") return true;
            throw missing;
          }
        } else if (code(error) !== "EBUSY" && code(error) !== "ENOTEMPTY") throw error;
      }
      if (performance.now() >= deadline) return false;
      await delay(50, undefined, signal ? { signal } : {});
    }
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}
