import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { CGROUP_ENV, validLeaseCgroup } from "../../conversation-cgroup.js";
import { LEASE_ENV } from "../../conversation-recovery.js";

const STOP_TIMEOUT_MS = 2_000;
const PIPE_DRAIN_TIMEOUT_MS = 2_000;

type Exit = { kind: "exited"; code: number | null } | { kind: "unavailable" };

export class ClaudeProcess {
  readonly exit: Promise<Exit>;
  readonly lines: Interface;
  private readonly child: ChildProcessWithoutNullStreams;
  private exitStatus?: Exit;
  private stopping?: Promise<void>;
  private transportError = false;
  private readonly tracked: boolean;

  constructor(executable: string, args: string[], cwd: string, environment: Record<string, string>) {
    const cgroup = environment[CGROUP_ENV];
    this.tracked = process.platform === "linux" && !!environment[LEASE_ENV];
    if (cgroup && !validLeaseCgroup(cgroup, environment[LEASE_ENV] ?? "")) {
      throw new Error("Invalid Claude Code runtime cgroup");
    }

    this.child = spawn(cgroup ? "/bin/sh" : executable, cgroup
      ? ["-c", 'printf %s "$$" > "$1/cgroup.procs" && shift && exec "$@"', "tmatrix-claude", cgroup, executable, ...args]
      : args, {
      cwd,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true
    });
    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.exit = new Promise<Exit>((resolve) => {
      this.child.once("exit", (code) => {
        resolve(this.exitStatus = { kind: "exited", code });
        if (this.child.stdout.readableEnded || this.child.stdout.destroyed) return;
        // A detached descendant can keep the inherited pipe open after Claude exits.
        const timer = setTimeout(() => {
          this.lines.close();
          this.child.stdout.destroy();
        }, PIPE_DRAIN_TIMEOUT_MS).unref();
        this.lines.once("close", () => clearTimeout(timer));
      });
      this.child.on("error", () => {
        if (this.child.pid === undefined) resolve(this.exitStatus = { kind: "unavailable" });
        else this.transportError = true;
      });
    });
    this.child.stdin.on("error", () => { this.transportError = true; });
    this.child.stderr.resume();
  }

  send(input: string): void {
    this.child.stdin.end(input);
  }

  get inputFailed(): boolean {
    return this.transportError;
  }

  stop(): Promise<void> {
    return this.stopping ??= this.terminate();
  }

  private async terminate(): Promise<void> {
    this.lines.close();
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();

    const pid = this.child.pid;
    if (pid === undefined) {
      await this.exit;
      return;
    }

    if (process.platform === "win32") {
      if (this.exitStatus) return;
      const killed = await new Promise<boolean>((resolve) => {
        execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { timeout: STOP_TIMEOUT_MS, windowsHide: true },
          (error) => resolve(error === null));
      });
      if (killed && await waitFor(() => this.exitStatus !== undefined)) return;
      this.child.kill();
      throw new Error("Claude Code process tree shutdown could not be confirmed");
    }

    const stopped = () => this.exitStatus !== undefined && (this.tracked || !signalGroup(pid, 0));
    signalGroup(pid, "SIGTERM");
    if (await waitFor(stopped)) return;

    signalGroup(pid, "SIGKILL");
    if (await waitFor(stopped)) return;
    throw new Error("Claude Code process group shutdown could not be confirmed");
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw new Error("Unable to signal the Claude Code process group");
  }
}

async function waitFor(stopped: () => boolean): Promise<boolean> {
  const expires = performance.now() + STOP_TIMEOUT_MS;
  while (!stopped()) {
    if (performance.now() >= expires) return false;
    await delay(25);
  }
  return true;
}
