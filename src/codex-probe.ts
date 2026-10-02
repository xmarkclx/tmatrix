import { AppServerCodex, spawnCodexAppServer, type AppServerProcess } from "./app-server-codex.js";

const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
const MAX_VERSION_OUTPUT_BYTES = 4_096;

/** The update directory must remain intact until this process is known to exit. */
export class CodexProbeCleanupError extends Error {
  constructor() {
    super("Codex verification process did not confirm shutdown");
    this.name = "CodexProbeCleanupError";
  }
}

/**
 * Check the candidate without starting/resuming a conversation or modifying
 * authentication. All output stays local and errors contain no CLI payloads.
 */
export async function verifyCodexInstallation(
  executablePath: string,
  expectedVersion: string,
  environment: Record<string, string>,
  signal?: AbortSignal,
  options: { timeoutMs?: number; closeTimeoutMs?: number } = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  if (signal?.aborted) throw new Error("Codex verification cancelled");
  await verifyVersion(executablePath, expectedVersion, environment, timeoutMs, closeTimeoutMs, signal);

  let probeProcess: AppServerProcess | undefined;
  const codex = new AppServerCodex({
    environment,
    executablePath,
    spawnProcess: (childEnvironment, arguments_) => {
      probeProcess = spawnCodexAppServer(executablePath, childEnvironment, arguments_);
      return probeProcess;
    },
    requestTimeoutMs: timeoutMs,
    closeTimeoutMs
  });
  try {
    if (signal?.aborted) throw new Error("Codex verification cancelled");
    const transport = await codex.transport(signal);
    const response = await transport.request("model/list", { limit: 100, includeHidden: false },
      signal ? { signal } : {});
    if (!isModelList(response)) throw new Error("Codex verification returned no valid models");
  } finally {
    // Never activate a version with an orphaned verification process. The
    // caller also uses this distinct failure to preserve its staging directory.
    let closeFailed = false;
    await codex.close().catch(() => { closeFailed = true; });
    await stopProbeGroup(probeProcess, closeTimeoutMs);
    if (closeFailed) throw new CodexProbeCleanupError();
  }
}

function isModelList(value: unknown): boolean {
  if (!value || typeof value !== "object" || !("data" in value) || !Array.isArray(value.data)) {
    return false;
  }
  return value.data.length > 0 && value.data.every((model: unknown) =>
    model !== null && typeof model === "object" &&
    "id" in model && typeof model.id === "string" && model.id.trim() !== "" &&
    "model" in model && typeof model.model === "string" && model.model.trim() !== "");
}

function verifyVersion(
  executablePath: string,
  expectedVersion: string,
  environment: Record<string, string>,
  timeoutMs: number,
  closeTimeoutMs: number,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnCodexAppServer(executablePath, environment, ["--version"]);
    } catch {
      reject(new Error("Unable to execute Codex verification"));
      return;
    }
    let output = "";
    let outputBytes = 0;
    let failure: Error | undefined;
    let closed = false;
    let closeTimer: NodeJS.Timeout | undefined;
    const finish = (cause?: Error) => {
      clearTimeout(timer);
      if (closeTimer) clearTimeout(closeTimer);
      signal?.removeEventListener("abort", abort);
      if (cause) reject(cause);
      else resolve();
    };
    const stop = (cause: Error) => {
      if (closed || failure) return;
      failure = cause;
      // Match the worker's dedicated process group, including a JS launcher's
      // native child, so a timeout cannot leave verification running forever.
      if (process.platform !== "win32" && child.pid !== undefined) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ }
      }
      try { child.kill("SIGKILL"); } catch { /* Await the close receipt below. */ }
      closeTimer = setTimeout(() => finish(new CodexProbeCleanupError()), closeTimeoutMs);
      closeTimer.unref();
    };
    const abort = () => stop(new Error("Codex verification cancelled"));
    const timer = setTimeout(() => stop(new Error("Codex version verification timed out")), timeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      outputBytes += chunk.length;
      if (outputBytes > MAX_VERSION_OUTPUT_BYTES) {
        stop(new Error("Codex version verification returned excessive output"));
        return;
      }
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", () => undefined);
    child.stdin.on("error", () => stop(new Error("Codex verification input stream failed")));
    child.stdout.on("error", () => stop(new Error("Codex verification output stream failed")));
    child.stderr.on("error", () => stop(new Error("Codex verification error stream failed")));
    child.once("error", () => stop(new Error("Unable to execute Codex verification")));
    child.once("close", (code) => {
      closed = true;
      clearTimeout(timer);
      if (closeTimer) clearTimeout(closeTimer);
      void stopProbeGroup(child, closeTimeoutMs).then(() => {
        if (failure) finish(failure);
        else if (code !== 0) finish(new Error("Codex version verification failed"));
        else if (output.trim() !== `codex-cli ${expectedVersion}`) {
          finish(new Error("Codex version verification did not match the requested version"));
        } else finish();
      }, () => finish(new CodexProbeCleanupError()));
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdin.end();
  });
}

/**
 * Probes never create user work: terminate any remaining helper in their own
 * detached group even after the root exits with its stdio already closed.
 * A group that cannot be proven absent retains the candidate for later repair.
 */
async function stopProbeGroup(child: AppServerProcess | undefined, timeoutMs: number): Promise<void> {
  if (process.platform === "win32" || child?.pid === undefined) return;
  const group = -child.pid;
  const alive = () => {
    try { process.kill(group, 0); return true; }
    catch (cause) {
      if (cause && typeof cause === "object" && "code" in cause && cause.code === "ESRCH") return false;
      throw new CodexProbeCleanupError();
    }
  };
  if (!alive()) return;
  try { process.kill(group, "SIGKILL"); }
  catch (cause) {
    if (!cause || typeof cause !== "object" || !("code" in cause) || cause.code !== "ESRCH") {
      throw new CodexProbeCleanupError();
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (alive()) {
    if (Date.now() >= deadline) throw new CodexProbeCleanupError();
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}
