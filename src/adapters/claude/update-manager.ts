import { execFile } from "node:child_process";
import { constants, copyFileSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { access, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { AdapterUpdates, AdapterUpdateState } from "../../runtime-adapter.js";

const run = promisify(execFile);
const packageName = "@anthropic-ai/claude-code";
const versionPattern = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/;
const minimumVersion = "2.1.220";
export const CLAUDE_INSTALL_REQUIRED = `Install Claude Code ${minimumVersion} or newer and make it available on PATH or set TMATRIX_CLAUDE_PATH to its executable.`;
const interval = 24 * 60 * 60 * 1000;
const executableName = process.platform === "win32" ? "claude.exe" : "claude";
type Environment = Record<string, string>;
interface Installation { executable: string; version: string }

function compareVersions(left: string, right: string): number {
  const other = right.split(".").map(Number);
  return left.split(".").reduce((order, part, index) => order || Number(part) - other[index]!, 0);
}

function cliEnvironment(environment: Environment): Environment {
  const env: Environment = { ...environment, DISABLE_AUTOUPDATER: "1" };
  delete env.CLAUDECODE;
  return env;
}

async function probe(executable: string, environment: Environment, signal?: AbortSignal): Promise<Installation | undefined> {
  try {
    const { stdout } = await run(executable, ["--version"], {
      env: cliEnvironment(environment), signal, timeout: 5000, maxBuffer: 8192, windowsHide: true
    });
    const version = /^([\d.]+) \(Claude Code\)$/.exec(stdout.trim())?.[1] ?? "";
    if (versionPattern.test(version) && compareVersions(version, minimumVersion) >= 0) return { executable, version };
  } catch { return undefined; }
}

function environmentPath(environment: Environment): string[] {
  const key = Object.keys(environment).find(key => key.toUpperCase() === "PATH");
  return (key ? environment[key] : "")?.split(delimiter).filter(isAbsolute) ?? [];
}

async function hostInstallation(environment: Environment): Promise<Installation | undefined> {
  const override = environment.TMATRIX_CLAUDE_PATH;
  if (override) return isAbsolute(override) ? probe(override, environment) : undefined;
  const home = environment.HOME || environment.USERPROFILE || homedir();
  const candidates = [...environmentPath(environment).map(dir => join(dir, executableName)), join(home, ".local", "bin", executableName)];
  if (process.platform === "win32") {
    candidates.push(...environmentPath(environment).map(dir => join(dir, "node_modules", packageName, "bin", "claude.exe")));
  }
  for (const candidate of new Set(candidates)) {
    const installation = await probe(candidate, environment);
    if (installation) return installation;
  }
}

async function platformPackage(): Promise<string | undefined> {
  if (!["x64", "arm64"].includes(process.arch) || !["darwin", "win32", "linux"].includes(process.platform)) return;
  let suffix = "";
  if (process.platform === "linux") {
    try {
      await access("/etc/alpine-release");
      suffix = "-musl";
    } catch {
      const libraries = await readdir("/lib").catch(() => []);
      if (libraries.some(name => name.startsWith("ld-musl-"))) suffix = "-musl";
    }
  }
  return `${packageName}-${process.platform}-${process.arch}${suffix}`;
}

async function npmCommand(environment: Environment): Promise<[string, ...string[]] | undefined> {
  const executable = process.platform === "win32" ? "npm.cmd" : "npm";
  for (const dir of new Set([...environmentPath(environment), dirname(process.execPath)])) {
    try {
      await access(join(dir, executable), constants.X_OK);
      if (process.platform !== "win32") return [join(dir, executable)];
      const entry = join(dir, "node_modules", "npm", "bin", "npm-cli.js");
      await access(entry, constants.R_OK);
      return [process.execPath, entry];
    } catch { continue; }
  }
}

export class ClaudeUpdateManager implements AdapterUpdates {
  readonly displayName = "Claude Code";
  private installation: Installation | undefined;
  private state: AdapterUpdateState = { status: "idle", current_version: "unknown" };
  private readonly closing = new AbortController();
  private timer?: NodeJS.Timeout;
  private checking: Promise<void> | undefined;

  constructor(private readonly directory: string, private readonly environment: Environment) {}

  async initialize(): Promise<void> {
    const entries = await readdir(this.directory).catch(() => []);
    for (const version of entries.filter(entry => versionPattern.test(entry)).sort((a, b) => compareVersions(b, a))) {
      const installation = await probe(join(this.directory, version, executableName), this.environment);
      if (installation?.version === version) {
        this.installation = installation;
        break;
      }
    }
    const host = await hostInstallation(this.environment);
    if (host && (!this.installation || compareVersions(host.version, this.installation.version) > 0)) this.installation = host;
    this.state.current_version = this.installation?.version ?? "unknown";
    if (this.environment.DISABLE_UPDATES === "1") this.state.status = "disabled";
  }

  executable(): string {
    if (!this.installation) throw new Error(CLAUDE_INSTALL_REQUIRED);
    return this.installation.executable;
  }

  acquire(): { executable: string; release(): void } {
    const executable = this.executable();
    const pins = join(this.directory, "workers");
    mkdirSync(pins, { mode: 0o700, recursive: true });
    const directory = mkdtempSync(join(pins, "worker-"));
    const pinned = join(directory, executableName);
    const release = () => { rmSync(directory, { recursive: true, force: true }); };
    try {
      const target = realpathSync(executable);
      try {
        linkSync(target, pinned);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
        copyFileSync(target, pinned, constants.COPYFILE_EXCL);
      }
      return { executable: pinned, release };
    } catch {
      release();
      throw new Error("Could not pin the Claude Code executable for this worker");
    }
  }

  snapshot(): AdapterUpdateState { return { ...this.state }; }

  start(): void {
    if (this.timer || this.state.status === "disabled" || this.closing.signal.aborted) return;
    this.timer = setInterval(() => this.scheduleCheck(), interval);
    this.timer.unref();
    this.scheduleCheck();
  }

  private scheduleCheck(): void {
    this.state.next_check_at = new Date(Date.now() + interval).toISOString();
    void this.checkNow();
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    this.closing.abort();
    await this.checking;
  }

  checkNow(): Promise<void> {
    if (this.closing.signal.aborted || this.environment.DISABLE_UPDATES === "1") return Promise.resolve();
    this.checking ??= this.update().finally(() => { this.checking = undefined; });
    return this.checking;
  }

  private async update(): Promise<void> {
    const signal = this.closing.signal;
    delete this.state.error;
    this.state.last_checked_at = new Date().toISOString();
    this.state.status = "checking";
    try {
      const npm = await npmCommand(this.environment);
      const platform = await platformPackage();
      if (!npm || !platform) {
        this.state.status = "disabled";
        this.state.error = npm ? "Automatic updates are unavailable on this platform." : "Install npm to enable Claude Code updates.";
        return;
      }
      const version = await this.runNpm(npm, ["view", `${packageName}@stable`, "version", "--json"], 30_000);
      const latest: unknown = JSON.parse(version);
      if (typeof latest !== "string" || !versionPattern.test(latest) || compareVersions(latest, minimumVersion) < 0) {
        throw new Error("Invalid Claude Code stable version");
      }
      this.state.latest_version = latest;
      if (this.installation && compareVersions(latest, this.installation.version) <= 0) {
        this.state.status = "up_to_date";
        return;
      }
      this.state.status = "installing";
      const installation = await this.install(npm, platform, latest, signal);
      signal.throwIfAborted();
      if (this.installation) this.state.previous_version = this.installation.version;
      this.installation = installation;
      this.state.current_version = installation.version;
      this.state.status = "updated";
      await this.prune(installation.version).catch(() => undefined);
    } catch {
      if (signal.aborted) return;
      this.state.status = "failed";
      this.state.error = "Could not install or verify the Claude Code update. The current version is still selected.";
    }
  }

  private async install(npm: [string, ...string[]], platform: string, version: string, signal: AbortSignal): Promise<Installation> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stage = await mkdtemp(join(this.directory, ".install-"));
    const destination = join(this.directory, version);
    try {
      await this.runNpm(npm, ["install", "--prefix", stage, "--no-save", "--no-package-lock", "--no-audit", "--no-fund",
        "--ignore-scripts", "--cache", join(stage, ".npm-cache"), `${platform}@${version}`], 5 * 60_000);
      this.state.status = "verifying";
      const executable = join(stage, "node_modules", platform, executableName);
      if ((await probe(executable, this.environment, signal))?.version !== version) throw new Error("Claude Code version probe failed");
      signal.throwIfAborted();
      const ready = join(stage, "ready");
      await mkdir(ready);
      await rename(executable, join(ready, executableName));
      const published = join(destination, executableName);
      try {
        await rename(ready, destination);
      } catch {
        if ((await probe(published, this.environment, signal))?.version !== version) throw new Error("Could not publish Claude Code update");
      }
      return { version, executable: published };
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  private async prune(current: string): Promise<void> {
    const entries = await readdir(this.directory, { withFileTypes: true });
    const versions = entries.filter(entry => entry.isDirectory() && entry.name !== current && versionPattern.test(entry.name))
      .map(entry => entry.name).sort((a, b) => compareVersions(b, a));
    for (const version of versions.slice(1)) await rm(join(this.directory, version), { recursive: true, force: true });
  }

  private async runNpm([command, ...prefix]: [string, ...string[]], args: string[], timeout: number): Promise<string> {
    const attempt = run(command, [...prefix, ...args, "--registry=https://registry.npmjs.org/",
      "--@anthropic-ai:registry=https://registry.npmjs.org/"], {
      env: this.environment, cwd: dirname(process.execPath), signal: this.closing.signal, timeout,
      killSignal: "SIGKILL", maxBuffer: 256 * 1024, windowsHide: true
    });
    const closed = new Promise<void>(resolve => attempt.child.once("close", resolve));
    try {
      return (await attempt).stdout;
    } finally {
      await closed;
    }
  }
}
