import { createSecurityWarningReporter, type AlertSecurityWarning } from "./security-warning.js";
import { LiveSteering, NotSentError } from "./helpers/live-steering.js";
import { conversationContext } from "./helpers/conversation-context.js";
import { buildCommentPrompt } from "./helpers/build-comment-prompt.js";
import { prepareTicketHistory } from "./helpers/ticket-history.js";
import { serializePromptHistory } from "./helpers/serialize-prompt-history.js";
import { workerTitle } from "./helpers/worker-title.js";
import { boundContext, stripConversationReference, type ConversationLease, type ConversationStore } from "./conversation-store.js";
import type { WorkerObservation } from "./local-worker-state.js";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Input, Usage, RuntimeFactory, RuntimeLike, RuntimeThreadOptions,
  ThreadLike, WorkerThreadEvent, WorkerThreadItem } from "./runtime-adapter.js";
// Compatibility aliases for existing embedders. New adapters use runtime-adapter.ts.
export type { DetailedFileChange, DetailedFileChangeItem, StreamedTurnLike,
  ThreadLike, WorkerThreadEvent, WorkerThreadItem } from "./runtime-adapter.js";
export type CodexFactory = RuntimeFactory;
export type CodexLike = RuntimeLike;
export type CodexThreadOptions = RuntimeThreadOptions;
import type { Logger } from "pino";
import type { TicketApi } from "./api-client.js";
import {
  cancellationReason,
  errorContext,
  toError,
  WorkerError
} from "./errors.js";
import type { Metrics } from "./metrics.js";
import { ProgressReporter } from "./progress.js";
import { deliverResult } from "./result-delivery.js";
import { prepareCodexInput } from "./adapters/codex/prepare-input.js";
import { conversationReferenceSchema } from "./types.js";
import { isProvider, providers, type Provider } from "./runtime-routing.js";
import type {
  ConversationReference,
  ExecutionProfile,
  ReasoningEffort,
  ServiceTier,
  SteeringEvent,
  Ticket,
  TicketResult,
  UsageSummary
} from "./types.js";
import { z } from "zod";

const HANDOFF_TEXT_LIMIT = 100_000;
const RESULT_ERROR_TEXT_LIMIT = 4_000;
const RESULT_ERROR_ID_LIMIT = 120;
const DEFAULT_WORKING_DIRECTORY = "/tmp";
const USER_MESSAGE_FORMAT_INSTRUCTION =
  "Keep user_message concise: explain what changed and why, and link the PR and preview when available. Rely on linked PR/CI evidence instead of repeating verification results, diffs, file inventories, or logs. Mention remaining limitations or failures that affect review. For work without a PR, include only the brief evidence needed to assess the result. Technical details are optional; do not add a mandatory accordion or a no-changes statement for routine read-only or follow-up work. Do not copy context_summary, secrets, or hidden reasoning into the visible message.";
const HANDOFF_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "context_summary", "user_message"],
  properties: {
    outcome: { type: "string", enum: ["AI_DONE", "AI_NEEDS_FEEDBACK"] },
    context_summary: {
      type: "string",
      minLength: 1,
      maxLength: HANDOFF_TEXT_LIMIT,
      description: "Private operational continuation state for the next fresh AI session: completed work, artifacts, decisions, verification, blockers, and next steps. Keep it as short as useful and normally under 8000 characters. Never include secrets or hidden chain-of-thought."
    },
    user_message: {
      type: "string",
      minLength: 1,
      maxLength: HANDOFF_TEXT_LIMIT,
      description: `Concise human-visible result or question. Do not repeat the continuation context. ${USER_MESSAGE_FORMAT_INSTRUCTION}`
    }
  }
} as const;

const handoffSchema = z.object({
  outcome: z.enum(["AI_DONE", "AI_NEEDS_FEEDBACK"]),
  context_summary: z.string().min(1).max(HANDOFF_TEXT_LIMIT),
  user_message: z.string().min(1).max(HANDOFF_TEXT_LIMIT)
}).strict();

type Handoff = z.infer<typeof handoffSchema>;

export interface RunOutcome {
  status: "completed" | "failed" | "cancelled";
  threadId?: string;
}

/** Keeps only the newest edit for one active worker while its current turn runs. */
export class SteeringMailbox {
  private latest?: SteeringEvent;
  private readonly local: { id: string; message: string }[] = [];
  private localClosed = false;
  private readonly localListeners = new Set<() => void>();

  enqueueLocal(id: string, message: string): boolean {
    if (this.localClosed || this.local.length >= 16) return false;
    this.local.push({ id, message });
    // Let the supervisor record the queued receipt before delivery can start.
    queueMicrotask(() => { for (const listener of this.localListeners) listener(); });
    return true;
  }

  takeLocal(): { id: string; message: string } | undefined {
    return this.local.shift();
  }

  returnLocal(message: { id: string; message: string }): void {
    this.local.unshift(message);
  }

  hasLocal(): boolean { return this.local.length > 0; }

  subscribeLocal(listener: () => void): () => void {
    this.localListeners.add(listener);
    return () => { this.localListeners.delete(listener); };
  }

  closeLocal(): void {
    this.localClosed = true;
  }

  enqueue(event: SteeringEvent): boolean {
    if (event.input_revision <= (this.latest?.input_revision ?? -1)) return false;
    this.latest = event;
    return true;
  }

  takeLatestAfter(inputRevision: number): SteeringEvent | undefined {
    const latest = this.latest;
    if (!latest) return undefined;
    delete this.latest;
    return latest.input_revision > inputRevision ? latest : undefined;
  }

  get latestRevision(): number | undefined {
    return this.latest?.input_revision;
  }
}

export interface RuntimeSelection {
  id: string;
  account?: string;
  rebuild?: boolean;
  runtimeFactory: RuntimeFactory;
  conversationStore: ConversationStore;
  model?: (requested: string) => string;
  label?: string;
}

export interface RuntimeSelectionContext {
  ticket: Ticket;
  history: unknown;
  active: RuntimeSelection | undefined;
  reference: ConversationReference | undefined;
  recovering: boolean;
}

/** Selects the runtime for the ticket's exact model. */
type SelectRuntime = (signal: AbortSignal | undefined, workingDirectory: string, model: string,
  context: RuntimeSelectionContext) => Promise<RuntimeSelection | undefined>;

interface TurnOutcome {
  finalResponse: string;
  threadId?: string;
  usage?: UsageSummary;
}

export class TicketRunner {
  private readonly alertSecurityWarning: AlertSecurityWarning | undefined;
  private readonly runtimeFactory: RuntimeFactory;
  private readonly selectRuntime: SelectRuntime | undefined;
  private readonly api: TicketApi;
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  private readonly fallbackWorkingDirectory: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly conversationStore: ConversationStore | undefined;

  constructor(options: {
    alertSecurityWarning?: AlertSecurityWarning;
    runtimeFactory?: RuntimeFactory;
    selectRuntime?: SelectRuntime;
    /** @deprecated Use runtimeFactory. */
    codexFactory?: RuntimeFactory;
    api: TicketApi;
    logger: Logger;
    metrics: Metrics;
    workingDirectory?: string;
    fetch?: typeof globalThis.fetch;
    conversationStore?: ConversationStore;
  }) {
    const factory = options.runtimeFactory ?? options.codexFactory;
    if (!factory) throw new Error("A runtime factory is required");
    if (options.selectRuntime && !options.conversationStore) throw new Error("Runtime selection requires a shared conversation lease");
    this.alertSecurityWarning = options.alertSecurityWarning;
    this.runtimeFactory = factory;
    this.selectRuntime = options.selectRuntime;
    this.api = options.api;
    this.logger = options.logger.child({ component: "ticket_runner" });
    this.metrics = options.metrics;
    this.fallbackWorkingDirectory = options.workingDirectory ?? DEFAULT_WORKING_DIRECTORY;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.conversationStore = options.conversationStore;
  }

  async run(ticket: Ticket, options: {
    runId: string;
    recovered: boolean;
    steering?: SteeringMailbox;
    observe?: (event: WorkerObservation) => void;
    signal?: AbortSignal;
  }): Promise<RunOutcome> {
    const profile = executionProfile(ticket);
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const steering = options.steering ?? new SteeringMailbox();
    let processedInputRevision = ticket.input_revision ?? 0;
    const log = this.logger.child({
      ticket_id: ticket.ticket_id,
      worker_id: ticket.worker_id,
      run_id: options.runId,
      recovered: options.recovered,
      execution_mode: profile.execution_mode,
      model: profile.model,
      reasoning_effort: profile.reasoning_effort,
      service_tier: profile.service_tier
    });
    const warning = this.alertSecurityWarning ? createSecurityWarningReporter({
      ticket, alert: this.alertSecurityWarning, logger: log,
      ...(options.signal ? { signal: options.signal } : {})
    }) : undefined;
    const reporter = new ProgressReporter({
      api: this.api,
      ticket,
      logger: log,
      metrics: this.metrics,
      inputRevision: processedInputRevision,
      ...(options.signal ? { signal: options.signal } : {})
    });

    let threadId: string | undefined;
    let usage: UsageSummary | undefined;
    let handoff: Handoff | undefined;
    let result: TicketResult | undefined;
    let runtime: RuntimeLike | undefined;
    let runtimeCloseFailure: unknown;
    let cancelled = cancellationReason(options.signal);
    let releaseConversation: ConversationLease | undefined;
    let conversationStore = this.conversationStore;
    let lastCompletedRoute: { store: ConversationStore | undefined; threadId: string | undefined } | undefined;
    let pendingLocalMessage: string | undefined;

    const completedResult = (response: Handoff, contextNote?: string): TicketResult => ({
      status: "completed",
      input_revision: processedInputRevision,
      outcome: response.outcome,
      context_summary: conversationStore && threadId
        ? conversationStore.attachContext(ticket, threadId, response.context_summary, contextNote)
        : boundContext(response.context_summary, contextNote),
      user_message: response.user_message,
      final_response: response.user_message,
      ...(threadId ? { thread_id: threadId, ...(conversationStore ? { conversation: conversationStore.reference(threadId) } : {}) } : {}),
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAtMs,
      ...(usage ? { usage } : {})
    });

    const closeRuntime = async () => {
      const closing = runtime;
      runtime = undefined;
      try {
        await closing?.close?.();
      } catch (cause) {
        runtimeCloseFailure = toError(cause);
        throw cause;
      }
    };

    try {
      log.info({ event: "worker.run_started", stage: "claim" }, "Ticket run started");

      try {
        await this.stage(log, "claim", () => this.api.markTaken(ticket, options.signal));
        const history = await this.stage(log, "history", () => this.api.getHistory(ticket, options.signal));
        releaseConversation = await this.conversationStore?.acquire(ticket, options.signal);
        const recoveredAttempt = releaseConversation?.recoveredAttempt;
        if (releaseConversation?.recovered) {
          const text = this.selectRuntime && recoveredAttempt
            ? "Recovered the interrupted ticket's conversation lock. Checking its saved runtime and session."
            : "Recovered the previous worker's conversation lock automatically. Resuming saved context; a missing conversation will be rebuilt from the durable handoff.";
          options.observe?.({ kind: "conversation.recovered", text });
        }
        const workingDirectory = await resolveWorkingDirectory(ticket.project_path, this.fallbackWorkingDirectory);
        const context = conversationContext(history);
        const recoveredReference = options.recovered ? savedConversation(ticket, history) : undefined;
        const recoveredRuntime = recoveredAttempt?.runtime ?? recoveredReference?.runtime;
        let activeSelection: RuntimeSelection | undefined;
        let activeThread: { thread: ThreadLike; observe: (event: WorkerObservation) => Promise<void> } | undefined;
        let turnInput = "";
        let missingConversationText: string | undefined;
        let localSteeringId: string | undefined;
        const reference = savedConversation(ticket, history);
        const savedRuntime = recoveredRuntime ?? reference?.runtime;

        while (true) {
          const selected = await this.selectRuntime?.(options.signal, workingDirectory, profile.model, {
            ticket, history, active: activeSelection,
            reference: recoveredAttempt ? recoveredAttempt.conversation : reference,
            recovering: !!(recoveredAttempt || recoveredReference)
          });
          options.signal?.throwIfAborted();
          const switching = !!activeThread && selected !== undefined &&
            (activeSelection ? selected.id !== activeSelection.id || selected.account !== activeSelection.account
              : selected.conversationStore !== conversationStore);
          const model = selected?.model?.(profile.model) ?? profile.model;
          let runtimeInput = turnInput;
          if (!activeThread || switching) {
            if (switching) {
              await closeRuntime();
              options.signal?.throwIfAborted();
              try {
                await releaseConversation?.prepareRuntimeReplacement?.();
              } catch (cause) {
                if (!(cause instanceof WorkerError) || cause.code !== "CONVERSATION_GROUP_UNAVAILABLE") runtimeCloseFailure = toError(cause);
                throw cause;
              }
              threadId = undefined;
            } else if (selected && recoveredRuntime && selected.id !== recoveredRuntime) {
              throw new WorkerError({
                message: "The recovered ticket used a different runtime. Inspect the interrupted work before retrying.",
                code: "RUNTIME_RECOVERY_PROVIDER_CHANGED", stage: "runtime.select"
              });
            }

            conversationStore = selected?.conversationStore ?? conversationStore;
            const previousAttempt = selected && !switching ? recoveredAttempt : undefined;
            const priorConversation = previousAttempt?.conversation;
            const expectedReference = switching || !selected ? undefined
              : previousAttempt ? priorConversation : recoveredReference;
            if ((previousAttempt && !priorConversation) ||
                (expectedReference && (expectedReference.runtime !== selected?.id ||
                  conversationStore?.reference(expectedReference.thread_id).scope !== expectedReference.scope))) {
              throw unverifiedRuntimeRecovery();
            }
            let resumeId = switching || selected?.rebuild ? undefined
              : priorConversation?.thread_id ?? await conversationStore?.resolve(ticket, history);
            if (selected) await releaseConversation?.rememberRuntime?.(selected.id,
              resumeId ? selected.conversationStore.reference(resumeId) : undefined);
            options.signal?.throwIfAborted();
            if (selected?.rebuild) {
              options.observe?.({ kind: "conversation.unlinked", text: "Starting a fresh conversation on another account from the task history and saved handoff." });
            } else if (conversationStore && !switching && !resumeId && hasReplyAncestry(ticket, history)) {
              options.observe?.({ kind: "conversation.unlinked", text: "Earlier conversation has no saved link on this engine. Starting a fresh conversation from the task history and saved handoff." });
            }
            const runtimeProfile = model === profile.model ? profile : Object.freeze({ ...profile, model });
            runtime = (selected?.runtimeFactory ?? this.runtimeFactory)(runtimeProfile, releaseConversation?.environment);
            if (selected && !runtime.close) throw new WorkerError({
              message: "The selected runtime cannot confirm teardown.",
              code: "RUNTIME_CLOSE_UNSUPPORTED", stage: "runtime.select"
            });
            const ticketHistory = runtime.prepareTicketHistory ? prepareTicketHistory(ticket, history) : undefined;
            const deferred = ticketHistory && await runtime.prepareTicketHistory?.(ticketHistory.read)
              ? ticketHistory.deferred : undefined;
            const fullPrompt = buildPrompt(ticket, deferred?.history ?? history, deferred?.instructions);
            const commentPrompt = resumeId && runtime.resumeThread ? buildCommentPrompt(ticket, history) : undefined;
            const changes = commentPrompt !== undefined && resumeId
              ? await conversationStore?.contextChanges(ticket, resumeId, context) ?? {}
              : {};
            const updates = Object.keys(changes).length ? `# Updated task context\n${JSON.stringify(changes, null, 2)}\n\n` : "";
            runtimeInput = switching && handoff ? continueOnNewRuntime(fullPrompt, handoff, turnInput)
              : previousAttempt ? recoverInterruptedRuntime(fullPrompt)
                : commentPrompt === undefined ? fullPrompt : resumedCommentPrompt(updates, commentPrompt);
            // Tell the runtime, and through its reply the person, why the task moved providers.
            const previousRuntime = switching ? activeSelection?.id : savedRuntime;
            if (selected && previousRuntime && previousRuntime !== selected.id && isProvider(previousRuntime) && isProvider(selected.id)) {
              runtimeInput = `${providerChangeNote(previousRuntime, selected.id, selected.label)}\n\n${runtimeInput}`;
              options.observe?.({ kind: "runtime.switched", text: providerChangeSummary(previousRuntime, selected.id) });
            }
            missingConversationText = previousAttempt || commentPrompt === undefined ? undefined : fullPrompt;

            log.info({
              event: resumeId ? "codex.thread_resuming" : "codex.thread_starting",
              stage: "codex.start",
              instruction_chars: ticket.instructions.length,
              prompt_chars: runtimeInput.length,
              working_directory: workingDirectory,
              used_project_path: workingDirectory === ticket.project_path,
              ...(selected ? { runtime_adapter: selected.id } : {})
            }, resumeId ? "Resuming runtime conversation" : "Starting runtime conversation");

            const threadOptions = runtimeThreadOptions(runtimeProfile, workingDirectory, workerTitle(ticket));
            if (warning) threadOptions.reportSecurityWarning = warning.report;
            if (!switching && !previousAttempt && releaseConversation?.recovered) threadOptions.rebuildOnResumeRejection = true;
            if (previousAttempt && !runtime.resumeThread) throw unverifiedRuntimeRecovery();
            if (resumeId && !runtime.resumeThread) {
              options.observe?.({ kind: "conversation.unlinked", text: "This runtime cannot resume conversations. Starting a fresh conversation from the task history and saved handoff." });
            }
            const requestedResumeId = runtime.resumeThread ? resumeId : undefined;
            const thread = resumeId && runtime.resumeThread
              ? runtime.resumeThread(resumeId, threadOptions)
              : runtime.startThread(threadOptions);
            const sessionStore = conversationStore;
            let rebuiltCodexThread: string | undefined;
            activeThread = { thread, observe: async event => {
              if (event.thread_id) {
                if (priorConversation && priorConversation.thread_id !== event.thread_id) throw unverifiedRuntimeRecovery();
                const openedThread = event.thread_id;
                if (selected?.id === "codex" && requestedResumeId && requestedResumeId !== openedThread) {
                  rebuiltCodexThread = openedThread;
                } else {
                  threadId = openedThread;
                  await sessionStore?.remember(ticket, openedThread, resumeId);
                  resumeId = openedThread;
                }
                if (selected) await releaseConversation?.rememberRuntime?.(selected.id, selected.conversationStore.reference(openedThread));
              }
              if (event.kind === "turn.started" && rebuiltCodexThread) {
                await sessionStore?.remember(ticket, rebuiltCodexThread, resumeId);
                threadId = rebuiltCodexThread;
                resumeId = rebuiltCodexThread;
                rebuiltCodexThread = undefined;
              }
              options.observe?.(event.kind === "thread.started" ? {
                ...event,
                run_kind: requestedResumeId && event.thread_id === requestedResumeId ? "resumed" : "initial"
              } : event);
            } };
          }
          if (selected && (selected.id !== activeSelection?.id || selected.label !== activeSelection?.label)) {
            options.observe?.({
              kind: "runtime.selected", text: selected.label ?? selected.id, runtime_adapter: selected.id, model,
              ...(selected.account ? { account: selected.account } : {})
            });
          }
          activeSelection = selected;
          if (!handoff) {
            options.observe?.({ kind: "prompt.prepared", text: runtimeInput, input_revision: processedInputRevision });
          }
          reporter.setInputRevision(processedInputRevision);
          const turn = await this.runPreparedTurn(
              activeThread.thread,
              runtimeInput,
              ticket,
              log,
              reporter,
              options.signal,
              activeThread.observe,
              localSteeringId,
              missingConversationText,
              steering,
              warning
            );
          missingConversationText = undefined;
          threadId = turn.threadId ?? threadId;
          usage = mergeUsage(usage, turn.usage);
          handoff = parseHandoff(turn.finalResponse);
          lastCompletedRoute = { store: conversationStore, threadId };
          pendingLocalMessage = undefined;
          if (threadId) await conversationStore?.rememberContext(ticket, threadId, context);

          if (localSteeringId) options.observe?.({ kind: "steering.response_observed", text: "A response was observed after the local message", steering_id: localSteeringId });
          localSteeringId = undefined;
          const nextSteering = steering.takeLatestAfter(processedInputRevision);
          if (!nextSteering) {
            const local = steering.takeLocal();
            if (!local) {
              // Close synchronously before final delivery so no accepted message
              // can disappear in the gap between the last turn and teardown.
              steering.closeLocal();
              break;
            }
            localSteeringId = local.id;
            pendingLocalMessage = local.message;
            turnInput = localSteeringPrompt(local.message);
            continue;
          }

          processedInputRevision = nextSteering.input_revision;
          reporter.setInputRevision(processedInputRevision);
          reporter.enqueue("steering.applied", {
            input_revision: processedInputRevision,
            ...(nextSteering.trigger_comment_id !== undefined
              ? { trigger_comment_id: nextSteering.trigger_comment_id }
              : {})
          });
          log.info({
            event: "worker.steering_applied",
            input_revision: processedInputRevision
          }, "Queued steering input will continue in the current runtime conversation");
          options.observe?.({ kind: "revision.delivering", text: "Task update queued for the next runtime turn", input_revision: processedInputRevision });
          turnInput = buildSteeringPrompt(nextSteering);
        }

        if (!handoff) {
          throw new WorkerError({
            message: "Runtime completed without a handoff",
            code: "CODEX_OUTPUT_MISSING",
            stage: "codex.output"
          });
        }

        await reporter.flush();
        result = completedResult(handoff);
      } catch (cause) {
        await reporter.flush();
        cancelled = cancellationReason(options.signal);
        if (cancelled) {
          log.info({
            event: "worker.run_cancelled",
            stage: "codex.run",
            cancellation_kind: cancelled.kind,
            ...(cancelled.eventId ? { event_id: cancelled.eventId } : {}),
            duration_ms: Date.now() - startedAtMs
          }, "Ticket run cancellation reached the runner");
        } else if (handoff && lastCompletedRoute && cause instanceof WorkerError && cause.stage === "runtime.route") {
          conversationStore = lastCompletedRoute.store;
          threadId = lastCompletedRoute.threadId;
          const note = `TMatrix saved the completed work. The queued follow-up did not start. ${cause.message}`;
          const pending = pendingLocalMessage === undefined ? "" : `\nQueued local message: ${pendingLocalMessage}`;
          result = completedResult({
            outcome: "AI_NEEDS_FEEDBACK",
            context_summary: handoff.context_summary,
            user_message: boundContext(handoff.user_message, note)
          }, `Input revision ${processedInputRevision} is pending. ${cause.message}${pending}`);
        } else {
          const failure = normalizeRunFailure(cause, options.signal);
          log.error({
            event: "worker.run_failed",
            stage: failure.stage,
            duration_ms: Date.now() - startedAtMs,
            ...errorContext(failure)
          }, "Ticket run failed");
          result = {
            status: "failed",
            input_revision: Math.max(
              processedInputRevision,
              steering.latestRevision ?? processedInputRevision
            ),
            error: {
              code: failure.code.slice(0, RESULT_ERROR_ID_LIMIT),
              message:
                failure.message.trim().slice(0, RESULT_ERROR_TEXT_LIMIT) ||
                "Unknown worker failure.",
              stage: failure.stage.slice(0, RESULT_ERROR_ID_LIMIT),
              retryable: failure.retryable
            },
            ...(threadId ? { thread_id: threadId } : {}),
            started_at: startedAt,
            completed_at: new Date().toISOString(),
            duration_ms: Date.now() - startedAtMs,
            ...(usage ? { usage } : {})
          };
        }
      }

      steering.closeLocal();
      if (runtime?.close) {
        try {
          await closeRuntime();
        } catch (cause) {
          if (cancellationReason(options.signal)) {
            throw new WorkerError({
              message: "Runtime teardown failed during cancellation",
              code: "CODEX_CANCEL_CLOSE_FAILED",
              stage: "codex.close",
              retryable: true,
              cause
            });
          }
          log.warn({
            event: "codex.app_server_close_failed",
            stage: "codex.close",
            ...errorContext(cause)
          }, "Runtime did not close cleanly after the ticket run");
        }
      }

      cancelled = cancellationReason(options.signal) ?? cancelled;
      if (cancelled) {
        // Cancellation may race with a close failure that happened just before
        // the signal arrived. Never let that timing window produce a false ACK.
        if (runtimeCloseFailure !== undefined) {
          throw new WorkerError({
            message: "Runtime teardown failed during cancellation",
            code: "CODEX_CANCEL_CLOSE_FAILED",
            stage: "codex.close",
            retryable: true,
            cause: runtimeCloseFailure
          });
        }
        return { status: "cancelled", ...(threadId ? { threadId } : {}) };
      }
      if (!result) {
        throw new WorkerError({
          message: "Ticket run ended without a result",
          code: "WORKER_RESULT_MISSING",
          stage: "result"
        });
      }

      const reportStartedAt = Date.now();
      const reportController = new AbortController();
      const cancelResultReport = () => {
        const reason = cancellationReason(options.signal);
        if (reason) reportController.abort(reason);
      };
      options.signal?.addEventListener("abort", cancelResultReport, { once: true });
      cancelResultReport();
      try {
        // Shutdown failures still report independently; a user cancellation aborts
        // this request and is acknowledged through the cancellation endpoint.
        const receipt = await deliverResult({ api: this.api, ticket, result, signal: reportController.signal, logger: log });
        if (threadId && result.status === "completed") {
          try {
            await conversationStore?.bindResult(ticket, threadId, receipt);
          } catch (cause) {
            // Tzu Do already accepted the handoff. A local indexing failure must
            // not turn completed work into a failed run or repeat its side effects.
            // The signed reference in the private handoff can restore this link.
            log.warn({ event: "conversation.result_link_failed", ...errorContext(cause) }, "Result saved but its local conversation link could not be indexed");
            options.observe?.({ kind: "conversation.link_warning", text: "Result saved. Its local conversation link could not be saved; the private handoff retains recovery context." });
          }
        }
        this.metrics.increment("results_sent");
        this.metrics.observeDuration("result.report", Date.now() - reportStartedAt);
        log.info({
          event: "worker.result_reported",
          stage: "result",
          outcome: result.outcome ?? result.status,
          input_revision: result.input_revision,
          thread_id: threadId,
          duration_ms: Date.now() - startedAtMs,
          report_duration_ms: Date.now() - reportStartedAt,
          usage
        }, "Ticket result reported");
      } catch (cause) {
        cancelled = cancellationReason(options.signal);
        if (cancelled) {
          return { status: "cancelled", ...(threadId ? { threadId } : {}) };
        }
        this.metrics.increment("results_failed");
        throw new WorkerError({
          message: "Ticket run ended but the final result could not be reported",
          code: "RESULT_REPORT_FAILED",
          stage: "result",
          retryable: true,
          details: {
            ticket_id: ticket.ticket_id,
            worker_id: ticket.worker_id,
            outcome: result.status,
            original_error: errorContext(cause)
          },
          cause
        });
      } finally {
        options.signal?.removeEventListener("abort", cancelResultReport);
      }

      cancelled = cancellationReason(options.signal);
      if (cancelled) {
        return { status: "cancelled", ...(threadId ? { threadId } : {}) };
      }

      return { status: result.status, ...(threadId ? { threadId } : {}) };
    } finally {
      // Keep the local lease if teardown is unverified: another ticket must
      // not append turns while the prior runtime may still be executing.
      if (runtimeCloseFailure === undefined) await releaseConversation?.();
    }
  }

  /** Runs one structured runtime turn and relays its safe progress events. */
  private async runPreparedTurn(
    thread: ThreadLike,
    text: string,
    ticket: Ticket,
    log: Logger,
    reporter: ProgressReporter,
    signal?: AbortSignal,
    observe?: (event: WorkerObservation) => void | Promise<void>,
    localSteeringId?: string,
    missingConversationText?: string,
    steering?: SteeringMailbox,
    warning?: ReturnType<typeof createSecurityWarningReporter>
  ): Promise<TurnOutcome> {
    const endpoint = ticket.endpoints.history.replace(/^GET\s+/i, "");
    const prepared = await prepareCodexInput(text, {
      origin: new URL(endpoint).origin,
      fetch: this.fetch,
      ...(signal ? { signal } : {})
    });
    log.info({
      event: "codex.images_prepared",
      attached_images: prepared.attachedImages,
      skipped_images: prepared.skippedImages
    }, "Prepared Markdown image inputs for the runtime");

    let fallback: Awaited<ReturnType<typeof prepareCodexInput>> | undefined;
    const missingConversationInput = missingConversationText === undefined ? undefined : async () => {
      fallback = await prepareCodexInput(missingConversationText, {
        origin: new URL(endpoint).origin, fetch: this.fetch, ...(signal ? { signal } : {})
      });
      await observe?.({ kind: "prompt.prepared", text: missingConversationText, input_revision: ticket.input_revision ?? 0 });
      warning?.submitInput(missingConversationText);
      return fallback.input;
    };
    try {
      warning?.submitInput(text);
      return await this.runTurn(
        thread,
        prepared.input,
        log,
        reporter,
        signal,
        observe,
        localSteeringId,
        missingConversationInput,
        steering,
        ticket,
        warning
      );
    } finally {
      await prepared.cleanup();
      await fallback?.cleanup();
    }
  }

  /** Runs one structured runtime turn and relays its safe progress events. */
  private async runTurn(
    thread: ThreadLike,
    input: Input,
    log: Logger,
    reporter: ProgressReporter,
    signal?: AbortSignal,
    observe?: (event: WorkerObservation) => void | Promise<void>,
    localSteeringId?: string,
    missingConversationInput?: () => Promise<Input>,
    steering?: SteeringMailbox,
    ticket?: Ticket,
    warning?: ReturnType<typeof createSecurityWarningReporter>
  ): Promise<TurnOutcome> {
    let finalResponse: string | undefined;
    let threadId: string | undefined;
    let usage: UsageSummary | undefined;
    let turnCompleted = false;
    const live = thread.steer && steering && ticket ? new LiveSteering({
      mailbox: steering,
      observe: async (event) => { await observe?.(event); },
      deliver: async (message) => {
        const text = localSteeringPrompt(message);
        const preparationOptions = {
          origin: new URL(ticket.endpoints.history.replace(/^GET\s+/i, "")).origin,
          fetch: this.fetch, ...(signal ? { signal } : {})
        };
        let prepared: Awaited<ReturnType<typeof prepareCodexInput>>;
        try {
          prepared = await prepareCodexInput(text, preparationOptions);
        } catch (cause) {
          throw new NotSentError("Local message was not sent", { cause });
        }
        const restoreInput = warning?.submitInput(text);
        try {
          const accepted = await thread.steer!(prepared.input, signal ? { signal } : {});
          if (!accepted) restoreInput?.();
          return accepted;
        } catch (cause) {
          if (cause instanceof NotSentError) restoreInput?.();
          throw cause;
        } finally { await prepared.cleanup(); }
      }
    }) : undefined;
    try {
      const streamed = await thread.runStreamed(input, {
        outputSchema: HANDOFF_OUTPUT_SCHEMA,
        ...(missingConversationInput ? { missingConversationInput } : {}),
        ...(signal ? { signal } : {})
      });

      for await (const event of streamed.events) {
        log.debug({
          event: "codex.event_received",
          stage: "codex.stream",
          codex_event_type: event.type,
          ...("item" in event ? { item_type: event.item.type, item_id: event.item.id } : {})
        }, "Runtime stream event received");

        await observe?.(observeRuntimeEvent(event));
        if (event.type === "turn.started") live?.start();
        if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "error") live?.end();
        if (event.type === "item.completed" && event.item.type === "agent_message") await live?.responseObserved();
        if (event.type === "turn.started" && localSteeringId) {
          await observe?.({ kind: "steering.runtime_received", text: "Runtime started a turn containing the local message", steering_id: localSteeringId });
        }
        if (event.type === "thread.started") {
          threadId = event.thread_id;
          reporter.enqueue(event.type, { thread_id: threadId });
        } else if (event.type === "turn.started") {
          reporter.enqueue(event.type, {});
        } else if (event.type === "item.completed") {
          const summary = summarizeCompletedItem(event.item);
          reporter.enqueue(`item.${event.item.type}.completed`, summary);
          if (event.item.type === "agent_message") finalResponse = event.item.text;
        } else if (event.type === "turn.completed") {
          usage = usageSummary(event.usage);
          turnCompleted = true;
          reporter.enqueue(event.type, { usage });
        } else if (event.type === "turn.failed") {
          throw new WorkerError({
            message: event.error.message,
            code: "CODEX_TURN_FAILED",
            stage: "codex.turn"
          });
        } else if (event.type === "error") {
          throw new WorkerError({
            message: event.message,
            code: "CODEX_STREAM_ERROR",
            stage: "codex.stream"
          });
        }
      }
    } finally {
      await live?.close();
    }

    if (!turnCompleted) {
      throw new WorkerError({
        message: "Runtime event stream ended before turn.completed",
        code: "CODEX_STREAM_INCOMPLETE",
        stage: "codex.stream"
      });
    }
    if (finalResponse === undefined) {
      throw new WorkerError({
        message: "Runtime completed without a structured handoff response",
        code: "CODEX_OUTPUT_MISSING",
        stage: "codex.output"
      });
    }

    return {
      finalResponse,
      ...(threadId ? { threadId } : {}),
      ...(usage ? { usage } : {})
    };
  }

  private async stage<T>(log: Logger, name: string, operation: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    log.debug({ event: "worker.stage_started", stage: name }, "Worker stage started");
    try {
      const result = await operation();
      this.metrics.observeDuration(`worker.stage.${name}`, Date.now() - startedAt);
      log.debug({
        event: "worker.stage_succeeded",
        stage: name,
        duration_ms: Date.now() - startedAt
      }, "Worker stage succeeded");
      return result;
    } catch (cause) {
      log.error({
        event: "worker.stage_failed",
        stage: name,
        duration_ms: Date.now() - startedAt,
        ...errorContext(cause)
      }, "Worker stage failed");
      throw cause;
    }
  }
}

function executionProfile(ticket: Ticket): ExecutionProfile {
  return Object.freeze({
    execution_mode: ticket.execution_mode,
    model: ticket.model,
    reasoning_effort: ticket.reasoning_effort,
    service_tier: ticket.service_tier
  });
}

/** A missing local mapping is not evidence that an older conversation is lost. */
function hasReplyAncestry(ticket: Ticket, history: unknown): boolean {
  if (ticket.thread_anchor_comment_id != null) return true;
  if (!history || typeof history !== "object") return false;
  const record = history as Record<string, unknown>;
  if (record.thread_anchor_comment_id != null) return true;
  const inherited = record.inherited_context;
  if (inherited && typeof inherited === "object" &&
      (inherited as Record<string, unknown>).sourceCommentId != null) return true;
  const trigger = record.trigger_comment;
  return !!trigger && typeof trigger === "object" &&
    (trigger as Record<string, unknown>).replyToCommentId != null;
}

function runtimeThreadOptions(
  profile: ExecutionProfile,
  workingDirectory: string,
  threadName: string
): RuntimeThreadOptions {
  return {
    model: profile.model,
    modelReasoningEffort: profile.reasoning_effort,
    serviceTier: profile.service_tier,
    workingDirectory,
    sandboxMode: "danger-full-access",
    approvalPolicy: "never",
    networkAccessEnabled: true,
    threadName
  };
}


function buildPrompt(ticket: Ticket, history: unknown, instructions = ticket.instructions): string {
  const serializedHistory = serializePromptHistory(ticket.instructions, history);
  const ticketContext = Object.fromEntries(
    Object.entries(ticket).filter(([key]) => !["ticket_id", "worker_id", "instructions", "endpoints"].includes(key))
  );
  const contextSection = Object.keys(ticketContext).length === 0
    ? []
    : ["", "## Additional ticket data", JSON.stringify(ticketContext, null, 2)];

  return [
    "# AI Worker ticket",
    `Ticket ID: ${ticket.ticket_id}`,
    "",
    "Follow the ticket instructions exactly. The ticket decides how and where to deliver the work. Continue from the durable history when it shows prior progress; do not repeat completed side effects.",
    "",
    "## Ticket instructions",
    instructions,
    ...contextSection,
    "",
    "## Durable ticket history",
    serializedHistory,
    "",
    "Return the required structured handoff. Use outcome AI_DONE when the work is ready for user review, or AI_NEEDS_FEEDBACK when a specific human answer is required. Any inherited_context in durable history is branch-specific prior-session evidence; the current ticket and latest human revision override it, and important claims should be verified against the workspace. context_summary is private rolling operational memory attached to the same comment as user_message: record completed work, artifacts, decisions, verification, blockers, and next steps for a fresh worker; keep it as short as useful and normally under 8000 characters, and never include secrets or hidden chain-of-thought. Keep user_message concise and human-facing, and do not duplicate the context summary in it.",
    USER_MESSAGE_FORMAT_INSTRUCTION
  ].join("\n");
}

function savedConversation(ticket: Ticket, history: unknown) {
  const route = typeof history === "object" && history !== null && Object.hasOwn(history, "conversation") && "conversation" in history
    ? history.conversation : ticket.conversation;
  return conversationReferenceSchema.safeParse(route).data;
}

function unverifiedRuntimeRecovery(): WorkerError {
  return new WorkerError({
    message: "The interrupted ticket's conversation could not be verified. Inspect the interrupted work before retrying.",
    code: "RUNTIME_RECOVERY_UNVERIFIED", stage: "runtime.select"
  });
}

function recoverInterruptedRuntime(fullPrompt: string): string {
  return [
    "# Resume an interrupted ticket",
    "Inspect this conversation and the workspace to find the last completed step. Verify earlier side effects before acting and do not repeat completed work.",
    fullPrompt
  ].join("\n\n");
}

function providerChangeSummary(from: Provider, to: Provider): string {
  return `Continued on ${providers[to].label} because the task's selected model runs there; the earlier conversation was on ${providers[from].label}.`;
}

export function providerChangeNote(from: Provider, to: Provider, label: string | undefined): string {
  return [
    "# Provider change",
    `${providerChangeSummary(from, to)}${label ? ` Current route: ${label}.` : ""}`,
    `The earlier ${providers[from].label} conversation's turns are not available here. Rely on the durable ticket history, AI comments and saved handoff in this message, and verify the workspace before acting.`,
    `Start user_message with one short sentence telling the person that this reply continued on ${providers[to].label} and why.`
  ].join("\n");
}

/** Frames a new comment on a resumed conversation so the runtime treats earlier turns as this task's context. */
export function resumedCommentPrompt(updates: string, comment: string): string {
  return [
    "# New human comment on this task",
    "This continues the same conversation for this task. The earlier turns in this conversation (the ticket, its durable history and AI comments, and your previous handoffs) are this task's context: use them, and do not treat this as a new or unrelated request.",
    "",
    updates + comment,
    "",
    "Return the required structured handoff for this comment.",
    "",
    USER_MESSAGE_FORMAT_INSTRUCTION
  ].join("\n");
}

function continueOnNewRuntime(fullPrompt: string, handoff: Handoff, nextInput: string): string {
  return [
    fullPrompt,
    "# Handoff from the previous runtime",
    "Continue the work recorded below in this workspace. Verify the current state before acting, preserve completed work, and do not repeat completed side effects.",
    JSON.stringify({ ...handoff, context_summary: stripConversationReference(handoff.context_summary) }, null, 2),
    nextInput
  ].join("\n\n");
}

/** Converts a human edit into a follow-up turn without exposing it to logs. */
function buildSteeringPrompt(event: SteeringEvent): string {
  return [
    `# Updated human input (revision ${event.input_revision})`,
    "",
    "This edit supersedes the earlier human input for this work item. Apply it before finalizing, preserve completed work that remains valid, and do not repeat completed side effects.",
    "",
    event.content,
    "",
    "Return a fresh structured handoff for this latest revision.",
    "",
    USER_MESSAGE_FORMAT_INSTRUCTION
  ].join("\n");
}

/** Uses a host-valid absolute project path and otherwise falls back safely. */
async function resolveWorkingDirectory(
  projectPath: string | undefined,
  fallback: string
): Promise<string> {
  if (!projectPath || !isAbsolute(projectPath)) return fallback;
  try {
    const details = await stat(projectPath);
    return details.isDirectory() ? projectPath : fallback;
  } catch {
    return fallback;
  }
}

/** Validates the runtime's schema-constrained JSON without including its content in errors. */
function parseHandoff(value: string): Handoff {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new WorkerError({
      message: "Runtime returned invalid JSON for the structured handoff",
      code: "CODEX_OUTPUT_INVALID",
      stage: "codex.output",
      cause
    });
  }

  const result = handoffSchema.safeParse(parsed);
  if (!result.success) {
    throw new WorkerError({
      message: "Runtime handoff did not match the required output schema",
      code: "CODEX_OUTPUT_INVALID",
      stage: "codex.output",
      details: {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message
        }))
      }
    });
  }
  return result.data;
}

function usageSummary(usage: Usage): UsageSummary {
  return {
    input_tokens: usage.input_tokens,
    cached_input_tokens: usage.cached_input_tokens,
    cache_write_input_tokens: usage.cache_write_input_tokens,
    output_tokens: usage.output_tokens,
    reasoning_output_tokens: usage.reasoning_output_tokens
  };
}

/** Accumulates usage across an initial turn and any steering turns. */
function mergeUsage(
  current: UsageSummary | undefined,
  next: UsageSummary | undefined
): UsageSummary | undefined {
  if (!current) return next;
  if (!next) return current;
  return {
    input_tokens: current.input_tokens + next.input_tokens,
    cached_input_tokens: current.cached_input_tokens + next.cached_input_tokens,
    cache_write_input_tokens:
      current.cache_write_input_tokens + next.cache_write_input_tokens,
    output_tokens: current.output_tokens + next.output_tokens,
    reasoning_output_tokens:
      current.reasoning_output_tokens + next.reasoning_output_tokens
  };
}

/** Emits recovery-safe metadata without persisting prompts, output, or tool text. */
function summarizeCompletedItem(item: WorkerThreadItem): Record<string, unknown> {
  switch (item.type) {
    case "agent_message":
      return { characters: item.text.length };
    case "reasoning":
      return { characters: item.text.length };
    case "command_execution":
      return {
        status: item.status,
        exit_code: item.exit_code,
        output_characters: item.aggregated_output.length
      };
    case "file_change":
      return {
        status: item.status,
        changes: item.changes.map(({ path, kind }) => ({ path, kind }))
      };
    case "mcp_tool_call":
      return {
        server: item.server,
        tool: item.tool,
        status: item.status,
        failed: item.error !== undefined
      };
    case "web_search":
      return { query_characters: item.query.length };
    case "todo_list":
      return {
        items: item.items.length,
        completed: item.items.filter((entry) => entry.completed).length
      };
    case "error":
      return { message_characters: item.message.length };
  }
}

function normalizeRunFailure(cause: unknown, signal?: AbortSignal): WorkerError {
  const error = toError(cause);
  if (signal?.aborted) {
    return new WorkerError({
      message: "Runtime run was aborted",
      code: "CODEX_RUN_ABORTED",
      stage: "codex.run",
      retryable: true,
      cause: error
    });
  }
  if (cause instanceof WorkerError) return cause;
  return new WorkerError({
    message: error.message,
    code: "CODEX_RUN_FAILED",
    stage: "codex.run",
    cause: error
  });
}

/** Local console text is separate from the metadata-only task progress path. */
function observeRuntimeEvent(event: WorkerThreadEvent): WorkerObservation {
  if (event.type === "local.activity") return { kind: event.kind, text: event.text };
  if (event.type === "local.terminal") {
    return { kind: "terminal.attached", text: "Claude Code is running in a terminal. Press v to view it or a to attach.",
      terminal: { socket: event.socket, session: event.session } };
  }
  if (event.type === "thread.started") return { kind: event.type, text: "Conversation connected", thread_id: event.thread_id };
  if ("item" in event) {
    const item = event.item;
    const kind = `${event.type}.${item.type}`;
    switch (item.type) {
      case "command_execution": return { kind, text: `$ ${item.command}\n${item.aggregated_output}` };
      case "agent_message": {
        // The final JSON contains the private handoff. Show its public response
        // when available; ordinary commentary remains local console activity.
        try { return { kind, text: parseHandoff(item.text).user_message }; } catch { return { kind, text: item.text }; }
      }
      case "file_change": return { kind, text: item.changes.map((change) => `${change.kind}: ${change.path}`).join("\n") };
      case "mcp_tool_call": return { kind, text: `${item.server} / ${item.tool} (${item.status})` };
      case "web_search": return { kind, text: `Searching: ${item.query}` };
      case "reasoning": return { kind, text: item.text.trim() || "No reasoning summary provided" };
      case "todo_list": return { kind, text: item.items.map((entry) => `${entry.completed ? "[x]" : "[ ]"} ${entry.text}`).join("\n") };
      case "error": return { kind, text: item.message };
    }
  }
  return { kind: event.type, text: event.type.replaceAll(".", " ") };
}

function localSteeringPrompt(message: string): string {
  return `The user sent this local TMatrix message. Continue the same conversation and preserve the current task revision. Return the required structured handoff.\n\n${message}`;
}
