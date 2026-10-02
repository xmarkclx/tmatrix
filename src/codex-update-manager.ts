import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { access, cp, mkdir, mkdtemp, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { latestStableCodexRelease, installCodexRelease, type CodexRelease } from "./codex-release.js";
import { CodexProbeCleanupError, verifyCodexInstallation } from "./codex-probe.js";

export const CODEX_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const installationSchema = z.object({
  version: z.string().regex(stableVersion),
  directory: z.string().regex(/^v-[0-9a-f-]{36}$/),
  executable: z.string().min(1).refine(value => !isAbsolute(value) && !value.split(/[\\/]/).includes(".."))
}).strict();
const manifestSchema = z.object({
  schema: z.literal(1), current: installationSchema, previous: installationSchema.optional(),
  blocked_version: z.string().regex(stableVersion).optional()
}).strict();
type Installation = z.infer<typeof installationSchema>;
type Manifest = z.infer<typeof manifestSchema>;
export interface CodexUpdateStatus {
  status: "idle" | "checking" | "installing" | "verifying" | "updated" | "up_to_date" | "failed" | "disabled";
  current_version: string;
  previous_version?: string;
  latest_version?: string;
  blocked_version?: string;
  last_checked_at?: string;
  next_check_at?: string;
  error?: string;
}
export interface CodexExecutableLease { executablePath: string; release(): void }
export interface CodexUpdateControl {
  snapshot(): CodexUpdateStatus;
  checkNow(): Promise<void>;
  rollback(): Promise<void>;
}
interface Options {
  directory: string;
  bundled: { version: string; executablePath: string; directory: string };
  environment: Record<string, string>;
  latest?: (signal: AbortSignal) => Promise<CodexRelease>;
  install?: (release: CodexRelease, directory: string, signal: AbortSignal) => Promise<string>;
  verify?: (path: string, version: string, environment: Record<string, string>, signal: AbortSignal) => Promise<void>;
}

/** Owns only CLI files. Authentication, task leases and conversation routes stay outside this store. */
export class CodexUpdateManager implements CodexUpdateControl {
  private manifest?: Manifest;
  private state: CodexUpdateStatus;
  private owned = false;
  private readonly owner = randomUUID();
  private timer?: NodeJS.Timeout;
  private operation: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private stopped = false;

  constructor(private readonly options: Options) {
    this.state = { status: "idle", current_version: options.bundled.version };
  }

  /** Local recovery only; startup never waits for a network check or installation. */
  async initialize(): Promise<void> {
    try {
      await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
      this.takeOwnership();
      let encoded: string;
      try { encoded = await readFile(join(this.options.directory, "current.json"), "utf8"); }
      catch (error) { if (isMissing(error)) return; throw error; }
      const manifest = manifestSchema.parse(JSON.parse(encoded));
      await access(this.executable(manifest.current));
      this.manifest = manifest;
      this.refreshVersions();
    } catch {
      // Invalid state is preserved for repair; never erase a last-known-good pointer.
      this.state = { ...this.state, status: "disabled", error: "Codex update storage is unavailable; using the bundled CLI." };
    }
  }

  start(): void {
    if (this.timer || this.stopped || this.state.status === "disabled") return;
    this.timer = setInterval(() => {
      this.state.next_check_at = new Date(Date.now() + CODEX_CHECK_INTERVAL_MS).toISOString();
      void this.checkNow();
    }, CODEX_CHECK_INTERVAL_MS);
    this.timer.unref();
    this.state.next_check_at = new Date(Date.now() + CODEX_CHECK_INTERVAL_MS).toISOString();
    void this.checkNow();
  }

  snapshot(): CodexUpdateStatus { return { ...this.state }; }

  /** Pin before the runtime can spawn. Pin removal requires confirmed runtime.close(). */
  acquire(): CodexExecutableLease {
    const current = this.manifest?.current;
    if (!current) return { executablePath: this.options.bundled.executablePath, release() {} };
    const pins = join(this.options.directory, current.directory, ".pins");
    const pin = join(pins, randomUUID());
    try {
      mkdirSync(pins, { recursive: true, mode: 0o700 });
      writeFileSync(pin, "", { flag: "wx", mode: 0o600 });
    } catch {
      // A read-only/full store must not stop workers. The release bundle is never collected.
      return { executablePath: this.options.bundled.executablePath, release() {} };
    }
    let released = false;
    return {
      executablePath: this.executable(current),
      release: () => {
        if (released) return;
        released = true;
        try { unlinkSync(pin); } catch { return; }
        void this.collect().catch(() => undefined);
      }
    };
  }

  checkNow(): Promise<void> {
    return this.runOperation(async signal => {
      this.state.status = "checking";
      delete this.state.error;
      this.state.last_checked_at = new Date().toISOString();
      const release = await (this.options.latest ?? latestStableCodexRelease)(signal);
      if (!stableVersion.test(release.version)) throw new Error("Invalid stable release");
      this.state.latest_version = release.version;
      const current = this.manifest?.current.version ?? this.options.bundled.version;
      if (compareVersions(release.version, current) <= 0 || release.version === this.manifest?.blocked_version) {
        this.state.status = "up_to_date";
        return;
      }
      this.state.status = "installing";
      const candidate = await mkdtemp(join(this.options.directory, ".candidate-"));
      let retainCandidate = false;
      try {
        const path = await (this.options.install ?? installCodexRelease)(release, candidate, signal);
        const executable = relative(candidate, path);
        if (!executable || executable.startsWith(`..${sep}`) || isAbsolute(executable)) throw new Error("Invalid installation path");
        this.state.status = "verifying";
        try { await this.verify(path, release.version, signal); }
        catch (error) { retainCandidate = error instanceof CodexProbeCleanupError; throw error; }
        signal.throwIfAborted();
        // Preserve the initial bundled distribution for rollback even after a TMatrix upgrade.
        const previous = this.manifest?.current ?? await this.snapshotBundle(signal);
        const directory = `v-${randomUUID()}`;
        await rename(candidate, join(this.options.directory, directory));
        const next: Manifest = { schema: 1, current: { version: release.version, directory, executable }, previous };
        await this.activate(next, signal);
        this.state.status = "updated";
      } finally {
        if (!retainCandidate) await rm(candidate, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }

  rollback(): Promise<void> {
    if (this.operation) return Promise.reject(new Error("Codex update already in progress"));
    return this.runOperation(async signal => {
      const previous = this.manifest?.previous;
      if (!previous || !this.manifest) throw new Error("No rollback version");
      this.state.status = "verifying";
      delete this.state.error;
      await this.verify(this.executable(previous), previous.version, signal);
      const next: Manifest = {
        schema: 1, current: previous, previous: this.manifest.current,
        blocked_version: this.manifest.current.version
      };
      await this.activate(next, signal);
      this.state.status = "updated";
    });
  }

  /** Stop the updater independently; this does not stop any worker or release any pin. */
  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    delete this.state.next_check_at;
    this.controller?.abort();
    await this.operation;
    if (this.owned) {
      try {
        const path = join(this.options.directory, ".owner", "owner.json");
        if (JSON.parse(readFileSync(path, "utf8")).token === this.owner) rmSync(dirname(path), { recursive: true });
      } catch { /* A stale owner is recovered only when its process is demonstrably gone. */ }
      this.owned = false;
    }
  }

  private runOperation(action: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.operation) return this.operation;
    if (this.stopped || !this.owned || this.state.status === "disabled") return Promise.resolve();
    this.controller = new AbortController();
    // Dependencies impose individual deadlines; a total deadline also bounds a complete check.
    const timeout = setTimeout(() => this.controller?.abort(), 5 * 60_000);
    timeout.unref();
    this.operation = action(this.controller.signal).catch(() => {
      this.state.status = "failed";
      this.state.error = "Codex update failed; the current version remains available. Try Check now again.";
    }).finally(() => {
      clearTimeout(timeout);
      this.operation = undefined;
      this.controller = undefined;
      void this.collect().catch(() => undefined);
    });
    return this.operation;
  }

  private verify(path: string, version: string, signal: AbortSignal): Promise<void> {
    return (this.options.verify ?? verifyCodexInstallation)(path, version, this.options.environment, signal);
  }

  private async snapshotBundle(signal: AbortSignal): Promise<Installation> {
    const temporary = await mkdtemp(join(this.options.directory, ".bundle-"));
    try {
      await cp(this.options.bundled.directory, join(temporary, "distribution"), { recursive: true, errorOnExist: true, force: false });
      signal.throwIfAborted();
      const executable = relative(this.options.bundled.directory, this.options.bundled.executablePath);
      const directory = `v-${randomUUID()}`;
      await rename(join(temporary, "distribution"), join(this.options.directory, directory));
      return installationSchema.parse({ version: this.options.bundled.version, directory, executable });
    } finally { await rm(temporary, { recursive: true, force: true }).catch(() => undefined); }
  }

  private async activate(next: Manifest, signal: AbortSignal): Promise<void> {
    const temporary = join(this.options.directory, `.manifest-${randomUUID()}`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(next) + "\n");
        await file.sync();
      } finally { await file.close(); }
      signal.throwIfAborted();
      await rename(temporary, join(this.options.directory, "current.json"));
      this.manifest = next;
      this.refreshVersions();
    } finally { await rm(temporary, { force: true }).catch(() => undefined); }
  }

  private refreshVersions(): void {
    this.state.current_version = this.manifest!.current.version;
    if (this.manifest!.blocked_version) this.state.blocked_version = this.manifest!.blocked_version;
    else delete this.state.blocked_version;
    if (this.manifest!.previous) this.state.previous_version = this.manifest!.previous.version;
    else delete this.state.previous_version;
  }

  private executable(installation: Installation): string {
    return join(this.options.directory, installation.directory, installation.executable);
  }

  private async collect(): Promise<void> {
    if (!this.owned || !this.manifest || this.stopped || this.operation) return;
    for (const directory of await readdir(this.options.directory)) {
      if (!this.owned || this.stopped || this.operation) return;
      if (!/^v-[0-9a-f-]{36}$/.test(directory)) continue;
      // No await between testing current/pins and renaming: acquire() cannot race collection.
      if (directory === this.manifest.current.directory || directory === this.manifest.previous?.directory) continue;
      const path = join(this.options.directory, directory);
      try {
        if (existsSync(join(path, ".pins")) && readdirSync(join(path, ".pins")).length > 0) continue;
        const garbage = join(this.options.directory, `.garbage-${randomUUID()}`);
        renameSync(path, garbage);
        await rm(garbage, { recursive: true, force: true });
      } catch { /* Keep files whenever ownership or deletion is uncertain. */ }
    }
  }

  private takeOwnership(): void {
    const lock = join(this.options.directory, ".owner");
    const claim = () => {
      const pending = join(this.options.directory, `.owner-${randomUUID()}`);
      mkdirSync(pending, { mode: 0o700 });
      try {
        writeFileSync(join(pending, "owner.json"), JSON.stringify({ pid: process.pid, token: this.owner }), { flag: "wx", mode: 0o600 });
        // Publish a complete owner atomically; an interrupted write cannot leave an owner-less lock.
        renameSync(pending, lock);
        this.owned = true;
      } finally { rmSync(pending, { recursive: true, force: true }); }
    };
    if (!existsSync(lock)) { claim(); return; }
    const old = readFileSync(join(lock, "owner.json"), "utf8");
    const pid: unknown = JSON.parse(old).pid;
    if (!Number.isSafeInteger(pid) || (pid as number) <= 0) throw new Error("Invalid update owner");
    try { process.kill(pid as number, 0); throw new Error("Update store in use"); }
    catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH") throw error; }
    const guard = `${lock}.recovery`;
    mkdirSync(guard, { mode: 0o700 });
    try {
      if (readFileSync(join(lock, "owner.json"), "utf8") !== old) throw new Error("Update owner changed");
      rmSync(lock, { recursive: true });
      claim();
    } finally { rmSync(guard, { recursive: true }); }
  }
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number), right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) { const diff = left[i]! - right[i]!; if (diff) return diff; }
  return 0;
}
