import { z } from "zod";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { CGROUP_ENV, stopLeaseCgroup, validLeaseCgroup } from "../conversation-cgroup.js";
import { LEASE_ENV, processStart, stopLeaseProcesses } from "../conversation-recovery.js";

const STOP_TIMEOUT_MS = 2_000;
const PIPE_DRAIN_TIMEOUT_MS = 2_000;

type Exit = { kind: "exited"; code: number | null } | { kind: "unavailable" };

export class RuntimeProcess {
  readonly exit: Promise<Exit>;
  readonly lines: Interface;
  private readonly child: ChildProcessWithoutNullStreams;
  private exitStatus?: Exit;
  private stopping?: Promise<void>;
  private transportError = false;
  private readonly tracked: boolean;

  constructor(executable: string, args: string[], cwd: string, environment: Record<string, string>,
    private readonly runtimeName: string) {
    const cgroup = environment[CGROUP_ENV];
    this.tracked = process.platform === "linux" && !!environment[LEASE_ENV];
    if (cgroup && !validLeaseCgroup(cgroup, environment[LEASE_ENV] ?? "")) {
      throw new Error(`Invalid ${runtimeName} runtime cgroup`);
    }

    this.child = spawn(cgroup ? "/bin/sh" : executable, cgroup
      ? ["-c", 'printf %s "$$" > "$1/cgroup.procs" && shift && exec "$@"', "tmatrix-runtime", cgroup, executable, ...args]
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
        // A detached descendant can keep the inherited pipe open after the runtime exits.
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

  /** Writes a message and keeps stdin open so later messages can join the conversation. */
  write(input: string): void {
    this.child.stdin.write(input);
  }

  endInput(): void {
    this.child.stdin.end();
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
      throw new Error(`${this.runtimeName} process tree shutdown could not be confirmed`);
    }

    const stopped = () => this.exitStatus !== undefined && (this.tracked || !signalGroup(this.runtimeName, pid, 0));
    signalGroup(this.runtimeName, pid, "SIGTERM");
    if (await waitFor(stopped)) return;

    signalGroup(this.runtimeName, pid, "SIGKILL");
    if (await waitFor(stopped)) return;
    throw new Error(`${this.runtimeName} process group shutdown could not be confirmed`);
  }
}

function signalGroup(runtimeName: string, pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw new Error(`Unable to signal the ${runtimeName} process group`);
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

const leaseId = z.uuid();

/** Rejects unless every process in the worker's lease or cgroup is confirmed stopped. */
export async function confirmLeaseStopped(cgroup: string | undefined, ownerToken: string, runtimeName: string): Promise<void> {
  if (cgroup && !await stopLeaseCgroup(cgroup, ownerToken)) {
    throw new Error(`${runtimeName} runtime cgroup shutdown could not be confirmed`);
  }
  if (!cgroup && ownerToken && process.platform === "linux") {
    const startedAfter = await processStart(process.pid);
    if (!leaseId.safeParse(ownerToken).success || !startedAfter ||
        !await stopLeaseProcesses(ownerToken, undefined, startedAfter)) {
      throw new Error(`${runtimeName} runtime lease shutdown could not be confirmed`);
    }
  }
}
