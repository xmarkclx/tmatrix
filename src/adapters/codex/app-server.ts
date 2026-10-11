import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { Logger } from "pino";
import type { Input } from "../../runtime-adapter.js";
import { startSecurityWarningMcp, type SecurityWarningMcpServer } from "../../security-warning-mcp.js";
import type { ReportSecurityWarning } from "../../security-warning.js";
import type {
  RuntimeLike,
  RuntimeThreadOptions,
  StreamedTurnLike,
  ThreadLike,
  WorkerThreadEvent,
  WorkerThreadItem
} from "../../runtime-adapter.js";

const CLIENT_INFO = Object.freeze({
  name: "tzu_do_ai_worker",
  title: "Tzu Do AI Worker",
  version: "0.1.0"
});
const SERVICE_NAME = "tzu_do_ai_worker";
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const INTERRUPT_GRACE_MS = 5_000;
const BACKGROUND_CLEAN_TIMEOUT_MS = 2_000;
const MAX_REPAIRED_PROTOCOL_RECORD_LENGTH = 8 * 1024 * 1024;
// App Server is supervised without a human approval channel. Keep its process
// default aligned with the explicit thread/turn policy below.
const UNATTENDED_APP_SERVER_ARGUMENTS = Object.freeze([
  "--dangerously-bypass-approvals-and-sandbox",
  "app-server"
] as const);

type ProtocolRecord = Record<string, unknown>;
type ProtocolLogger = Pick<Logger, "error" | "warn">;
type PendingRequest = {
  method: string;
  threadId?: string;
  resolve: (value: unknown) => void;
  reject: (cause: Error) => void;
  cleanup: () => void;
};

export type AppServerProcess = ChildProcessWithoutNullStreams;
export type AppServerSpawner = (
  environment: Record<string, string>,
  arguments_: readonly string[]
) => AppServerProcess;

export interface AppServerCodexOptions {
  environment: Record<string, string>;
  /** Immutable installation selected when this worker acquired its lease. */
  executablePath?: string;
  spawnProcess?: AppServerSpawner;
  closeTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Records raw protocol failures and repaired fragments for local diagnosis. */
  logger?: ProtocolLogger;
}

/**
 * A small adapter around Codex App Server's stable JSONL protocol. One adapter
 * owns one subprocess for an active ticket; its saved conversation can continue
 * across many tickets through thread/resume.
 */
export class AppServerCodex implements RuntimeLike {
  private readonly environment: Record<string, string>;
  private readonly spawnProcess: AppServerSpawner;
  private readonly closeTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly logger: ProtocolLogger | undefined;
  private transportPromise?: Promise<AppServerTransport>;
  private startupCloseFailure?: Error;
  private threadStarted = false;
  private threadId?: string;
  private warningServerPromise?: Promise<SecurityWarningMcpServer | undefined>;

  constructor(options: AppServerCodexOptions) {
    this.environment = options.environment;
    const executablePath = options.executablePath;
    this.spawnProcess = options.spawnProcess ?? ((environment, arguments_) =>
      spawnCodexAppServer(executablePath ?? resolveBundledCodexPath(), environment, arguments_));
    this.closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.logger = options.logger;
  }

  startThread(options: RuntimeThreadOptions): ThreadLike {
    return this.ownThread(options);
  }

  resumeThread(threadId: string, options: RuntimeThreadOptions): ThreadLike {
    return this.ownThread(options, threadId);
  }

  /** Keeps the warning capability private to this runtime and valid across its resumed turns. */
  async securityWarningServer(report: ReportSecurityWarning): Promise<SecurityWarningMcpServer | undefined> {
    this.warningServerPromise ??= startSecurityWarningMcp(report).catch(() => {
      this.logger?.warn({ event: "security.warning_action_unavailable" }, "Worker warning action unavailable; execution continues");
      return undefined;
    });
    return this.warningServerPromise;
  }

  private ownThread(options: RuntimeThreadOptions, threadId?: string): ThreadLike {
    if (this.threadStarted) {
      throw new Error("This Codex App Server client already owns a thread");
    }
    this.threadStarted = true;
    return new AppServerThread(this, options, threadId);
  }

  async transport(signal?: AbortSignal): Promise<AppServerTransport> {
    this.transportPromise ??= this.startTransport(signal);
    return this.transportPromise;
  }

  registerThread(threadId: string): void {
    this.threadId = threadId;
  }

  async close(): Promise<void> {
    try {
      if (!this.transportPromise) return;
      let transport: AppServerTransport;
      try {
        transport = await this.transportPromise;
      } catch {
        if (this.startupCloseFailure) throw this.startupCloseFailure;
        return;
      }
      if (this.threadId) {
        const backgroundCleaned = await transport.request(
          "thread/backgroundTerminals/clean",
          { threadId: this.threadId },
          { timeoutMs: BACKGROUND_CLEAN_TIMEOUT_MS }
        ).then(() => true, () => false);
        await transport.request("thread/unsubscribe", {
          threadId: this.threadId
        }, { timeoutMs: this.closeTimeoutMs }).catch(() => undefined);
        await transport.close({ forceDescendants: !backgroundCleaned });
        return;
      }
      await transport.close();
    } finally {
      try { await (await this.warningServerPromise)?.close(); }
      catch { this.logger?.warn({ event: "security.warning_action_shutdown_unconfirmed" }, "Warning action shutdown unconfirmed"); }
      delete this.warningServerPromise;
    }
  }

  private async startTransport(signal?: AbortSignal): Promise<AppServerTransport> {
    let child: AppServerProcess;
    try {
      child = this.spawnProcess(
        this.environment,
        UNATTENDED_APP_SERVER_ARGUMENTS
      );
    } catch (cause) {
      throw new Error("Unable to start Codex App Server", { cause });
    }
    const transport = new AppServerTransport(
      child,
      this.closeTimeoutMs,
      this.requestTimeoutMs,
      this.logger
    );
    try {
      await transport.request("initialize", {
        clientInfo: CLIENT_INFO,
        capabilities: { experimentalApi: true }
      }, signal ? { signal } : {});
      transport.notify("initialized");
      return transport;
    } catch (cause) {
      try {
        await transport.close();
      } catch (closeFailure) {
        // The runner must retain its conversation lease and withhold a stop
        // acknowledgement when initialization failed but the child did not exit.
        this.startupCloseFailure = closeFailure instanceof Error
          ? closeFailure : new Error("Codex App Server startup teardown failed");
        throw this.startupCloseFailure;
      }
      throw new Error("Unable to initialize Codex App Server", { cause });
    }
  }
}

class AppServerThread implements ThreadLike {
  private readonly codex: AppServerCodex;
  private readonly options: RuntimeThreadOptions;
  private threadId?: string;
  private emittedThreadStarted = false;
  private replacedMissingThread = false;
  private activeTurn: { transport: AppServerTransport; threadId: string; turnId: string } | undefined;

  constructor(codex: AppServerCodex, options: RuntimeThreadOptions, private readonly resumeId?: string) {
    this.codex = codex;
    this.options = options;
  }

  async runStreamed(input: Input, options: {
    outputSchema?: unknown;
    signal?: AbortSignal;
    missingConversationInput?: () => Promise<Input>;
  } = {}): Promise<StreamedTurnLike> {
    return { events: this.run(input, options) };
  }

  async steer(input: Input, options: { signal?: AbortSignal } = {}): Promise<boolean> {
    throwIfAborted(options.signal);
    const active = this.activeTurn;
    if (!active) return false;
    try {
      const response = asRecord(await active.transport.request("turn/steer", {
        threadId: active.threadId, expectedTurnId: active.turnId,
        input: appServerInput(input)
      }, options));
      if (response.turnId !== active.turnId) throw new Error("Codex App Server returned an unexpected steering receipt");
      return true;
    } catch (cause) {
      if (cause instanceof SteeringRejectedError) return false;
      throw cause;
    }
  }

  private async *run(input: Input, turnOptions: {
    outputSchema?: unknown;
    signal?: AbortSignal;
    missingConversationInput?: () => Promise<Input>;
  }): AsyncGenerator<WorkerThreadEvent> {
    throwIfAborted(turnOptions.signal);
    const transport = await this.codex.transport(turnOptions.signal);
    const threadId = await this.ensureThread(transport, turnOptions.signal);
    throwIfAborted(turnOptions.signal);
    if (this.replacedMissingThread && !this.emittedThreadStarted && turnOptions.missingConversationInput) {
      input = await turnOptions.missingConversationInput();
      throwIfAborted(turnOptions.signal);
    }

    if (!this.emittedThreadStarted) {
      this.emittedThreadStarted = true;
      if (this.replacedMissingThread) {
        yield { type: "local.activity", kind: "conversation.rebuilt", text: "Saved conversation could not be resumed. Rebuilding from task context, comments and the saved handoff." };
      } else if (this.resumeId) {
        yield { type: "local.activity", kind: "conversation.resumed", text: "Continuing the saved conversation with its existing context." };
      }
      yield { type: "thread.started", thread_id: threadId };
    }

    const notifications = new NotificationQueue();
    let completedTurnId: string | undefined;
    const unsubscribe = transport.subscribe(
      (notification) => {
        const params = asRecord(notification.params);
        if (notification.method === "turn/completed" && params.threadId === threadId) {
          completedTurnId = optionalString(asRecord(params.turn).id);
          if (this.activeTurn?.turnId === completedTurnId) this.activeTurn = undefined;
        }
        notifications.push(notification);
      },
      (cause) => notifications.fail(cause)
    );
    let turnId: string | undefined;
    let interruptRequested = false;
    let interruptTimer: NodeJS.Timeout | undefined;
    const closeSafely = () => {
      // Abort is a hard ownership boundary. If turn/interrupt cannot complete,
      // the fallback must include command/background descendants as well as
      // the App Server wrapper itself.
      void transport.close({ forceDescendants: true }).catch(() => undefined);
    };
    const interrupt = () => {
      interruptRequested = true;
      // Before turn/start returns there is no targetable turn id, so closing
      // this ticket's dedicated process is the only immediate safe stop.
      if (!turnId) {
        closeSafely();
        return;
      }
      interruptTimer ??= setTimeout(closeSafely, INTERRUPT_GRACE_MS);
      interruptTimer.unref();
      void transport.request("turn/interrupt", {
        threadId,
        turnId
      }, { timeoutMs: INTERRUPT_GRACE_MS }).catch(closeSafely);
    };
    turnOptions.signal?.addEventListener("abort", interrupt, { once: true });
    if (turnOptions.signal?.aborted) interrupt();

    try {
      const response = asRecord(await transport.request("turn/start", {
        threadId,
        input: appServerInput(input),
        cwd: this.options.workingDirectory,
        approvalPolicy: this.options.approvalPolicy,
        sandboxPolicy: { type: "dangerFullAccess" },
        model: this.options.model,
        serviceTier: this.options.serviceTier,
        effort: this.options.modelReasoningEffort,
        summary: "auto",
        ...(turnOptions.outputSchema !== undefined
          ? { outputSchema: turnOptions.outputSchema }
          : {})
      }));
      turnId = stringField(asRecord(response.turn), "id");
      if (!turnId) throw new Error("Codex App Server returned no turn id");
      if (completedTurnId !== turnId) this.activeTurn = { transport, threadId, turnId };
      if (interruptRequested) interrupt();

      yield { type: "turn.started" };
      let usage = emptyUsage();

      for await (const notification of notifications) {
        const params = asRecord(notification.params);
        if (params.threadId !== threadId) continue;
        const notificationTurnId = optionalString(params.turnId);
        if (notificationTurnId && notificationTurnId !== turnId) continue;

        if (notification.method === "thread/tokenUsage/updated") {
          usage = mapUsage(asRecord(asRecord(params.tokenUsage).last));
          continue;
        }

        if (notification.method === "item/commandExecution/outputDelta") {
          yield { type: "local.activity", kind: "command.output", text: optionalString(params.delta) ?? "" };
          continue;
        }
        if (notification.method === "item/started") {
          const item = asRecord(params.item);
          const text = item.type === "commandExecution" ? `$ ${optionalString(item.command) ?? ""}`
            : item.type === "mcpToolCall" ? `${optionalString(item.server) ?? "MCP"} / ${optionalString(item.tool) ?? "tool"}`
            : item.type === "reasoning" ? "Working through the next step"
            : `Started ${optionalString(item.type) ?? "activity"}`;
          yield { type: "local.activity", kind: "activity.started", text };
          continue;
        }

        if (notification.method === "item/completed") {
          const item = mapCompletedItem(params.item);
          if (item) yield { type: "item.completed", item };
          continue;
        }

        if (notification.method === "error") {
          if (params.willRetry === true) continue;
          const message = optionalString(asRecord(params.error).message) ??
            "Codex App Server reported an unrecoverable stream error";
          yield { type: "error", message };
          return;
        }

        if (notification.method !== "turn/completed") continue;
        const turn = asRecord(params.turn);
        if (optionalString(turn.id) !== turnId) continue;
        const status = optionalString(turn.status);
        if (status === "completed") {
          yield { type: "turn.completed", usage };
        } else {
          const message = optionalString(asRecord(turn.error).message) ??
            (status === "interrupted"
              ? "Codex turn was interrupted"
              : "Codex turn failed");
          yield { type: "turn.failed", error: { message } };
        }
        return;
      }
    } finally {
      this.activeTurn = undefined;
      turnOptions.signal?.removeEventListener("abort", interrupt);
      if (interruptTimer) clearTimeout(interruptTimer);
      unsubscribe();
      notifications.end();
    }
  }

  private async ensureThread(
    transport: AppServerTransport,
    signal?: AbortSignal
  ): Promise<string> {
    if (this.threadId) return this.threadId;
    const warning = this.options.reportSecurityWarning
      ? await this.codex.securityWarningServer(this.options.reportSecurityWarning) : undefined;
    const configuration = {
      model: this.options.model,
      serviceTier: this.options.serviceTier,
      cwd: this.options.workingDirectory,
      approvalPolicy: this.options.approvalPolicy,
      sandbox: this.options.sandboxMode,
      config: {
        model_reasoning_effort: this.options.modelReasoningEffort,
        sandbox_workspace_write: {
          network_access: this.options.networkAccessEnabled
        },
        ...(warning ? { mcp_servers: { tmatrix_security_warning: {
          url: warning.url, http_headers: warning.headers, enabled: true
        } } } : {})
      }
    };
    let response: ProtocolRecord;
    if (this.resumeId) {
      try {
        response = asRecord(await transport.request("thread/resume", {
          ...configuration,
          threadId: this.resumeId,
          excludeTurns: true
        }, signal ? { signal } : {}));
      } catch (cause) {
        // Crash recovery may rebuild after an explicit server refusal, before
        // any turn input was sent. A timeout/disconnection is ambiguous and must
        // not start another conversation. Ordinary resumes still require loss.
        if (!(cause instanceof MissingConversationError) &&
            !(this.options.rebuildOnResumeRejection && cause instanceof ResumeRejectedError)) throw cause;
        this.replacedMissingThread = true;
        response = asRecord(await transport.request("thread/start", {
          ...configuration, serviceName: SERVICE_NAME, ephemeral: false
        }, signal ? { signal } : {}));
      }
    } else {
      response = asRecord(await transport.request("thread/start", {
        ...configuration, serviceName: SERVICE_NAME, ephemeral: false
      }, signal ? { signal } : {}));
    }
    const threadId = stringField(asRecord(response.thread), "id");
    if (!threadId) throw new Error("Codex App Server returned no thread id");
    if (this.resumeId && !this.replacedMissingThread && threadId !== this.resumeId) {
      throw new Error("Codex App Server resumed an unexpected conversation");
    }
    this.threadId = threadId;
    this.codex.registerThread(threadId);
    await transport.request("thread/name/set", {
      threadId,
      name: this.options.threadName
    }, signal ? { signal } : {});
    return threadId;
  }
}

/** Convert SDK input to App Server's separate text and camel-case localImage entries. */
function appServerInput(input: Input): ProtocolRecord[] {
  const entries = typeof input === "string" ? [{ type: "text" as const, text: input }] : input;
  return entries.map(entry => entry.type === "text"
    ? { type: "text", text: entry.text, text_elements: [] }
    : { type: "localImage", path: entry.path });
}

class AppServerTransport {
  private readonly child: AppServerProcess;
  private readonly closeTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationListeners = new Set<(value: ProtocolRecord) => void>();
  private readonly failureListeners = new Set<(cause: Error) => void>();
  private readonly lineReader;
  private readonly exitPromise: Promise<void>;
  private nextRequestId = 1;
  private closing = false;
  private closed = false;
  private failure?: Error;
  private closePromise?: Promise<void>;
  private protocolFragments: string[] = [];

  constructor(
    child: AppServerProcess,
    closeTimeoutMs: number,
    requestTimeoutMs: number,
    private readonly logger: ProtocolLogger | undefined
  ) {
    this.child = child;
    this.closeTimeoutMs = closeTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    // Drain stderr but never store or replay it: it can contain tool output.
    child.stderr.on("data", () => undefined);
    child.stdin.on("error", () => this.fail(
      new Error("Codex App Server input stream failed")
    ));
    child.stdout.on("error", () => this.fail(
      new Error("Codex App Server output stream failed")
    ));
    child.stderr.on("error", () => this.fail(
      new Error("Codex App Server error stream failed")
    ));
    this.lineReader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lineReader.on("line", (line) => this.receive(line));
    child.once("error", () => this.fail(new Error("Codex App Server process failed")));
    this.exitPromise = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        this.closed = true;
        if (!this.closing) {
          const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
          this.fail(new Error(`Codex App Server exited unexpectedly with ${detail}`));
        }
        resolve();
      });
    });
  }

  request(method: string, params: unknown, options: {
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {}): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closing || this.closed) {
      return Promise.reject(new Error("Codex App Server is closed"));
    }
    if (options.signal?.aborted) {
      return Promise.reject(abortError(options.signal));
    }
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const abort = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.cleanup();
        reject(abortError(options.signal));
      };
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
      };
      const threadId = optionalString(asRecord(params).threadId);
      this.pending.set(id, { method, ...(threadId ? { threadId } : {}), resolve, reject, cleanup });
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) {
        abort();
        return;
      }
      timer = setTimeout(() => {
        this.fail(new Error(`Codex App Server request ${method} timed out`));
      }, options.timeoutMs ?? this.requestTimeoutMs);
      timer.unref();
      const payload = `${JSON.stringify({ method, id, params })}\n`;
      this.child.stdin.write(payload, (cause) => {
        if (!cause) return;
        this.fail(new Error(`Unable to send Codex App Server request ${method}`));
      });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.failure) throw this.failure;
    if (this.closing || this.closed) {
      throw new Error("Codex App Server is closed");
    }
    const payload = params === undefined ? { method } : { method, params };
    this.child.stdin.write(`${JSON.stringify(payload)}\n`, (cause) => {
      if (cause) this.fail(new Error(`Unable to send Codex App Server notification ${method}`));
    });
  }

  subscribe(
    notification: (value: ProtocolRecord) => void,
    failure: (cause: Error) => void
  ): () => void {
    this.notificationListeners.add(notification);
    this.failureListeners.add(failure);
    if (this.failure) failure(this.failure);
    return () => {
      this.notificationListeners.delete(notification);
      this.failureListeners.delete(failure);
    };
  }

  close(options: { forceDescendants?: boolean } = {}): Promise<void> {
    this.closePromise ??= this.performClose(options.forceDescendants === true);
    return this.closePromise;
  }

  private async performClose(forceDescendants: boolean): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    this.fail(new Error("Codex App Server closed"));
    const knownDescendants = await descendantProcessIds(this.child.pid);
    this.child.stdin.end();
    if (await settlesWithin(this.exitPromise, this.closeTimeoutMs)) {
      if (forceDescendants) {
        await terminateRemainingProcesses(
          this.child,
          knownDescendants,
          this.closeTimeoutMs
        );
      }
      this.lineReader.close();
      return;
    }
    const termTargets = uniqueProcessIds([
      ...knownDescendants,
      ...await descendantProcessIds(this.child.pid)
    ]);
    await signalProcessTree(this.child, termTargets, "SIGTERM");
    if (await processTreeSettlesWithin(
      this.exitPromise,
      termTargets,
      this.closeTimeoutMs
    )) {
      this.lineReader.close();
      return;
    }
    const killTargets = uniqueProcessIds([
      ...termTargets,
      ...await descendantProcessIds(this.child.pid)
    ]);
    await signalProcessTree(this.child, killTargets, "SIGKILL");
    if (!await processTreeSettlesWithin(
      this.exitPromise,
      killTargets,
      this.closeTimeoutMs
    )) {
      throw new Error("Codex App Server did not exit after forced termination");
    }
    this.lineReader.close();
  }

  private receive(line: string): void {
    const protocolFragments = [...this.protocolFragments, line];
    // Codex 0.146 can emit a literal newline inside an MCP result string. JSONL
    // sees each section as a separate line; escaping only those proven string
    // boundaries restores the record without accepting arbitrary non-JSON text.
    const serializedRecord = protocolFragments.join("\\n");
    let value: unknown;
    try {
      value = JSON.parse(serializedRecord);
    } catch {
      if (isRecoverableSplitProtocolRecord(serializedRecord)) {
        this.protocolFragments = protocolFragments;
        return;
      }
      this.protocolFragments = [];
      this.logger?.error({
        event: "codex.protocol_invalid_json",
        ...(protocolFragments.length === 1
          ? {
              protocol_line: line,
              protocol_line_length: line.length
            }
          : {
              protocol_fragments: protocolFragments,
              protocol_fragment_lengths: protocolFragments.map(
                (fragment) => fragment.length
              ),
              protocol_record_length: serializedRecord.length
            })
      }, "Codex App Server returned invalid protocol JSON");
      this.fail(new Error("Codex App Server returned invalid protocol JSON"));
      return;
    }
    const message = asRecord(value);
    if (this.protocolFragments.length > 0) {
      this.logger?.warn({
        event: "codex.protocol_json_repaired",
        protocol_fragments: protocolFragments,
        protocol_fragment_lengths: protocolFragments.map(
          (fragment) => fragment.length
        ),
        protocol_record_length: serializedRecord.length,
        ...(typeof message.method === "string"
          ? { protocol_method: message.method }
          : {}),
        ...(typeof message.id === "number" ? { protocol_id: message.id } : {})
      }, "Repaired Codex App Server JSON split by literal string newlines");
    }
    this.protocolFragments = [];
    const id = typeof message.id === "number" ? message.id : undefined;
    if (id !== undefined && ("result" in message || "error" in message)) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      pending.cleanup();
      if ("error" in message) {
        const error = asRecord(message.error);
        const code = error.code;
        // Only explicit protocol rejection permits a next-turn retry. Never
        // replay a timeout, disconnect, malformed receipt or unknown failure.
        if (pending.method === "turn/steer" && (code === -32601 ||
            (code === -32600 && typeof error.message === "string" &&
             /^(?:no active turn|expected turn id .* does not match|turn id mismatch)/i.test(error.message)))) {
          pending.reject(new SteeringRejectedError());
          return;
        }
        if (pending.method === "thread/resume" && pending.threadId && code === -32600 &&
            error.message === `no rollout found for thread id ${pending.threadId}`) {
          pending.reject(new MissingConversationError());
          return;
        }
        const suffix = typeof code === "number" ? ` (${code})` : "";
        const failure = `Codex App Server request ${pending.method} failed${suffix}`;
        pending.reject(pending.method === "thread/resume"
          ? new ResumeRejectedError(failure) : new Error(failure));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method !== "string") return;
    if (id !== undefined) {
      // The unattended worker cannot safely answer interactive requests.
      this.child.stdin.write(`${JSON.stringify({
        id,
        error: { code: -32601, message: "Unsupported worker-side request" }
      })}\n`);
      this.fail(new Error("Codex App Server requested unsupported interactive input"));
      return;
    }
    for (const listener of this.notificationListeners) listener(message);
  }

  private fail(cause: Error): void {
    if (this.failure) return;
    this.failure = cause;
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(cause);
    }
    this.pending.clear();
    for (const listener of this.failureListeners) listener(cause);
  }
}

/** Carries no raw protocol message, which could otherwise leak credentials. */
class ResumeRejectedError extends Error {}
class SteeringRejectedError extends Error {}

class MissingConversationError extends Error {
  constructor() {
    super("Saved Codex conversation no longer exists");
  }
}

/**
 * Returns true only when a JSON object is unfinished inside a quoted string.
 * That is the observed App Server framing defect; structurally closed invalid
 * JSON and unrelated stdout still fail immediately.
 */
function isRecoverableSplitProtocolRecord(value: string): boolean {
  if (
    value.length > MAX_REPAIRED_PROTOCOL_RECORD_LENGTH ||
    !value.trimStart().startsWith("{")
  ) {
    return false;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const character of value) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === "{" || character === "[") {
      depth += 1;
    } else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return inString && depth > 0;
}

class NotificationQueue implements AsyncIterable<ProtocolRecord> {
  private readonly values: ProtocolRecord[] = [];
  private readonly waiters: Array<{
    resolve: (value: IteratorResult<ProtocolRecord>) => void;
    reject: (cause: Error) => void;
  }> = [];
  private ended = false;
  private failure?: Error;

  push(value: ProtocolRecord): void {
    if (this.ended || this.failure) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ done: false, value });
    else this.values.push(value);
  }

  fail(cause: Error): void {
    if (this.ended || this.failure) return;
    this.failure = cause;
    for (const waiter of this.waiters.splice(0)) waiter.reject(cause);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<ProtocolRecord> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ done: false, value });
        if (this.failure) return Promise.reject(this.failure);
        if (this.ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
      }
    };
  }
}

/** The complete native distribution, including resources and bundled tools. */
export function resolveBundledCodexInstallation(): {
  version: string;
  executablePath: string;
  directory: string;
} {
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve("@openai/codex/package.json");
  const metadata = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
  if (typeof metadata.version !== "string" || !/^\d+\.\d+\.\d+$/.test(metadata.version)) {
    throw new Error("The bundled Codex package has no stable version");
  }
  const platforms: Record<string, string> = {
    "linux-x64": "x86_64-unknown-linux-musl",
    "linux-arm64": "aarch64-unknown-linux-musl",
    "darwin-x64": "x86_64-apple-darwin",
    "darwin-arm64": "aarch64-apple-darwin",
    "win32-x64": "x86_64-pc-windows-msvc",
    "win32-arm64": "aarch64-pc-windows-msvc"
  };
  const platform = `${process.platform}-${process.arch}`;
  const target = platforms[platform];
  if (!target) throw new Error("Unsupported bundled Codex platform");
  let vendorDirectory = join(dirname(packagePath), "vendor");
  try {
    vendorDirectory = join(dirname(require.resolve(`@openai/codex-${platform}/package.json`)), "vendor");
  } catch {
    // Older packages shipped the native distribution inside @openai/codex.
  }
  const directory = join(vendorDirectory, target);
  const binaryName = process.platform === "win32" ? "codex.exe" : "codex";
  const executablePath = [join(directory, "bin", binaryName), join(directory, "codex", binaryName)]
    .find((path) => existsSync(path));
  if (!executablePath) throw new Error("The bundled Codex executable is not installed");
  return { version: metadata.version, executablePath, directory };
}

export function resolveBundledCodexPath(): string {
  try {
    return resolveBundledCodexInstallation().executablePath;
  } catch {
    // Preserve the package launcher's diagnostics on an unfamiliar packaging
    // layout while automatic updates remain disabled for that installation.
  }
  try {
    return createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js");
  } catch (cause) {
    throw new Error("The pinned @openai/codex CLI is not installed", { cause });
  }
}

export function spawnCodexAppServer(
  executablePath: string,
  environment: Record<string, string>,
  arguments_: readonly string[],
  workingDirectory?: string
): AppServerProcess {
  const launcher = /\.[cm]?js$/i.test(executablePath);
  const distribution = dirname(dirname(executablePath));
  const toolDirectories = launcher ? [] : ["codex-path", "path"]
    .map((name) => join(distribution, name)).filter((path) => existsSync(path));
  const childEnvironment = { ...environment };
  if (!launcher) {
    // This native distribution belongs to TMatrix. Parent npm/bun ownership
    // would otherwise point Codex's update behavior at an unrelated install.
    for (const name of ["CODEX_MANAGED_PACKAGE_ROOT", "CODEX_MANAGED_BY_NPM", "CODEX_MANAGED_BY_BUN",
      "CODEX_MANAGED_BY_PNPM", "CODEX_MANAGED_BY_VITE_PLUS"]) delete childEnvironment[name];
  }
  if (toolDirectories.length > 0) {
    childEnvironment.PATH = [...toolDirectories, environment.PATH ?? ""].filter(Boolean).join(delimiter);
  }
  return spawn(launcher ? process.execPath : executablePath,
    launcher ? [executablePath, ...arguments_] : [...arguments_], {
    env: childEnvironment,
    ...(workingDirectory ? { cwd: workingDirectory } : {}),
    stdio: ["pipe", "pipe", "pipe"],
    // One process group per ticket allows a hard fallback to target this App
    // Server without signalling the daemon or its other concurrent tickets.
    detached: process.platform !== "win32"
  });
}

function mapCompletedItem(
  value: unknown
): WorkerThreadItem | undefined {
  const item = asRecord(value);
  const id = optionalString(item.id) ?? "unknown";
  switch (item.type) {
    case "agentMessage":
      return { id, type: "agent_message", text: optionalString(item.text) ?? "" };
    case "reasoning": {
      // Only provider-authored summaries belong in the local activity feed.
      // Raw reasoning content must never be used as a display fallback.
      const text = stringArray(item.summary).join("\n");
      return { id, type: "reasoning", text };
    }
    case "commandExecution":
      return {
        id,
        type: "command_execution",
        command: optionalString(item.command) ?? "",
        aggregated_output: optionalString(item.aggregatedOutput) ?? "",
        ...(typeof item.exitCode === "number" ? { exit_code: item.exitCode } : {}),
        status: terminalStatus(item.status)
      };
    case "fileChange":
      return {
        id,
        type: "file_change",
        changes: Array.isArray(item.changes)
          ? item.changes.flatMap((change) => {
            const record = asRecord(change);
            const path = optionalString(record.path);
            const kind = patchKind(record.kind);
            const diff = optionalString(record.diff);
            return path && kind
              ? [{ path, kind, ...(diff ? { diff } : {}) }]
              : [];
          })
          : [],
        status: item.status === "completed" ? "completed" : "failed"
      };
    case "mcpToolCall": {
      const error = asRecord(item.error);
      const message = optionalString(error.message);
      return {
        id,
        type: "mcp_tool_call",
        server: optionalString(item.server) ?? "unknown",
        tool: optionalString(item.tool) ?? "unknown",
        arguments: item.arguments,
        ...(message ? { error: { message } } : {}),
        status: terminalStatus(item.status)
      };
    }
    case "webSearch":
      return { id, type: "web_search", query: optionalString(item.query) ?? "" };
    default:
      return undefined;
  }
}

function terminalStatus(value: unknown): "in_progress" | "completed" | "failed" {
  if (value === "completed") return "completed";
  if (value === "inProgress") return "in_progress";
  return "failed";
}

function patchKind(value: unknown): "add" | "delete" | "update" | undefined {
  const type = typeof value === "string" ? value : asRecord(value).type;
  return type === "add" || type === "delete" || type === "update"
    ? type
    : undefined;
}

function emptyUsage(): Extract<WorkerThreadEvent, { type: "turn.completed" }>["usage"] {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0
  };
}

function mapUsage(
  value: ProtocolRecord
): Extract<WorkerThreadEvent, { type: "turn.completed" }>["usage"] {
  return {
    input_tokens: numberField(value.inputTokens),
    cached_input_tokens: numberField(value.cachedInputTokens),
    cache_write_input_tokens: numberField(value.cacheWriteInputTokens),
    output_tokens: numberField(value.outputTokens),
    reasoning_output_tokens: numberField(value.reasoningOutputTokens)
  };
}

function asRecord(value: unknown): ProtocolRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as ProtocolRecord
    : {};
}

function stringField(value: ProtocolRecord, key: string): string | undefined {
  return optionalString(value[key]);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw abortError(signal);
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error("Codex run aborted");
}

async function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = await Promise.race([
    promise.then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), timeoutMs);
      timer.unref();
    })
  ]);
  if (timer) clearTimeout(timer);
  return !timedOut;
}

/** Returns Linux descendants leaf-first; other platforms use the process group. */
async function descendantProcessIds(
  pid: number | undefined,
  visited = new Set<number>()
): Promise<number[]> {
  if (process.platform !== "linux" || pid === undefined || visited.has(pid)) {
    return [];
  }
  visited.add(pid);
  let contents: string;
  try {
    contents = await readFile(`/proc/${pid}/task/${pid}/children`, "utf8");
  } catch {
    return [];
  }
  const children = contents.trim() === ""
    ? []
    : contents.trim().split(/\s+/).map(Number).filter(Number.isInteger);
  const result: number[] = [];
  for (const child of children) {
    result.push(...await descendantProcessIds(child, visited), child);
  }
  return result;
}

function uniqueProcessIds(values: number[]): number[] {
  return [...new Set(values.filter((value) => value > 0))];
}

/** Signals captured descendants plus the dedicated POSIX process group. */
async function signalProcessTree(
  child: AppServerProcess,
  descendants: number[],
  signal: NodeJS.Signals
): Promise<void> {
  for (const pid of descendants) {
    try {
      process.kill(pid, signal);
    } catch {
      // A descendant that already exited is successfully stopped.
    }
  }
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // A custom spawner may not make its child a process-group leader.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The wrapper may have exited while descendants were being signalled.
  }
}

async function terminateRemainingProcesses(
  child: AppServerProcess,
  descendants: number[],
  timeoutMs: number
): Promise<void> {
  if (descendants.length === 0) return;
  await signalProcessTree(child, descendants, "SIGTERM");
  if (await processIdsExitWithin(descendants, timeoutMs)) return;
  await signalProcessTree(child, descendants, "SIGKILL");
  if (!await processIdsExitWithin(descendants, timeoutMs)) {
    throw new Error("Codex App Server descendants did not exit after forced termination");
  }
}

async function processTreeSettlesWithin(
  exitPromise: Promise<void>,
  descendants: number[],
  timeoutMs: number
): Promise<boolean> {
  const [rootExited, descendantsExited] = await Promise.all([
    settlesWithin(exitPromise, timeoutMs),
    processIdsExitWithin(descendants, timeoutMs)
  ]);
  return rootExited && descendantsExited;
}

async function processIdsExitWithin(
  pids: number[],
  timeoutMs: number
): Promise<boolean> {
  if (pids.length === 0) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !processExists(pid))) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return pids.every((pid) => !processExists(pid));
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
