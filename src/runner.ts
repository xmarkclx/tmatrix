import { conversationContext } from "./helpers/conversation-context.js";
import { buildCommentPrompt } from "./helpers/build-comment-prompt.js";
import { workerTitle } from "./helpers/worker-title.js";
import type { ConversationStore } from "./conversation-store.js";
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
import type {
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

  enqueueLocal(id: string, message: string): boolean {
    if (this.localClosed || this.local.length >= 16) return false;
    this.local.push({ id, message });
    return true;
  }

  takeLocal(): { id: string; message: string } | undefined {
    return this.local.shift();
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

interface TurnOutcome {
  finalResponse: string;
  threadId?: string;
  usage?: UsageSummary;
}

export class TicketRunner {
  private readonly runtimeFactory: RuntimeFactory;
  private readonly api: TicketApi;
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  private readonly fallbackWorkingDirectory: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly conversationStore: ConversationStore | undefined;

  constructor(options: {
    runtimeFactory?: RuntimeFactory;
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
    this.runtimeFactory = factory;
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
    let releaseConversation: import("./conversation-store.js").ConversationLease | undefined;

    try {
      log.info({ event: "worker.run_started", stage: "claim" }, "Ticket run started");

      try {
        await this.stage(log, "claim", () => this.api.markTaken(ticket, options.signal));
        const history = await this.stage(log, "history", () => this.api.getHistory(ticket, options.signal));
        releaseConversation = await this.conversationStore?.acquire(ticket, options.signal);
        if (releaseConversation?.recovered) {
          options.observe?.({ kind: "conversation.recovered", text: "Recovered the previous worker's conversation lock automatically. Resuming saved context; a missing conversation will be rebuilt from the durable handoff." });
        }
        let resumeId = await this.conversationStore?.resolve(ticket, history);
        if (this.conversationStore && !resumeId && hasReplyAncestry(ticket, history)) {
          options.observe?.({ kind: "conversation.unlinked", text: "Earlier conversation has no saved link on this engine. Starting a fresh conversation from the task history and saved handoff." });
        }
        const fullPrompt = buildPrompt(ticket, history);
        const workingDirectory = await resolveWorkingDirectory(
          ticket.project_path,
          this.fallbackWorkingDirectory
        );
        runtime = this.runtimeFactory(profile, releaseConversation?.environment);
        const commentPrompt = resumeId && runtime.resumeThread ? buildCommentPrompt(ticket, history) : undefined;
        const context = conversationContext(history);
        const changes = commentPrompt !== undefined && resumeId
          ? await this.conversationStore?.contextChanges(ticket, resumeId, context) ?? {}
          : {};
        const updates = Object.keys(changes).length ? `# Updated task context\n${JSON.stringify(changes, null, 2)}\n\n` : "";
        const prompt = commentPrompt === undefined ? fullPrompt : updates + commentPrompt;
        let missingConversationText = commentPrompt === undefined ? undefined : fullPrompt;


        log.info({
          event: resumeId ? "codex.thread_resuming" : "codex.thread_starting",
          stage: "codex.start",
          instruction_chars: ticket.instructions.length,
          prompt_chars: prompt.length,
          working_directory: workingDirectory,
          used_project_path: workingDirectory === ticket.project_path
        }, resumeId ? "Resuming runtime conversation" : "Starting runtime conversation");

        const threadOptions = runtimeThreadOptions(
          profile,
          workingDirectory,
          workerTitle(ticket)
        );
        if (releaseConversation?.recovered) threadOptions.rebuildOnResumeRejection = true;
        if (resumeId && !runtime.resumeThread) {
          options.observe?.({ kind: "conversation.unlinked", text: "This runtime cannot resume conversations. Starting a fresh conversation from the task history and saved handoff." });
        }
        const thread = resumeId && runtime.resumeThread
          ? runtime.resumeThread(resumeId, threadOptions)
          : runtime.startThread(threadOptions);
        const observeRuntime = async (event: WorkerObservation) => {
          if (event.thread_id) {
            threadId = event.thread_id;
            // Persist before the generator advances to turn/start, so a restart
            // recovers this same conversation even if the first turn fails.
            await this.conversationStore?.remember(ticket, threadId, resumeId);
            resumeId = threadId;
          }
          options.observe?.(event);
        };

        // Local console only: never enqueue prompt text in remote progress/logs.
        // This records prepared input, not confirmation of runtime receipt.
        options.observe?.({ kind: "prompt.prepared", text: prompt, input_revision: processedInputRevision });

        let turnInput = prompt;
        let localSteeringId: string | undefined;
        while (true) {
          reporter.setInputRevision(processedInputRevision);
          const turn = await this.runPreparedTurn(
            thread,
            turnInput,
            ticket,
            log,
            reporter,
            options.signal,
            observeRuntime,
            localSteeringId,
            missingConversationText
          );
          missingConversationText = undefined;
          threadId = turn.threadId ?? threadId;
          usage = mergeUsage(usage, turn.usage);
          handoff = parseHandoff(turn.finalResponse);
          if (threadId) await this.conversationStore?.rememberContext(ticket, threadId, context);

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
            turnInput = `The user sent this local TMatrix message. Continue the same conversation and preserve the current task revision (${processedInputRevision}). Return the required structured handoff.\n\n${local.message}`;
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
        // Keep the authored response intact; PRs retain file diffs and CI evidence.
        const userMessage = handoff.user_message;
        result = {
          status: "completed",
          input_revision: processedInputRevision,
          outcome: handoff.outcome,
          context_summary: this.conversationStore && threadId
            ? this.conversationStore.attachContext(ticket, threadId, handoff.context_summary)
            : handoff.context_summary,
          user_message: userMessage,
          final_response: userMessage,
          ...(threadId ? { thread_id: threadId, ...(this.conversationStore ? { conversation: this.conversationStore.reference(threadId) } : {}) } : {}),
          started_at: startedAt,
          completed_at: new Date().toISOString(),
          duration_ms: Date.now() - startedAtMs,
          ...(usage ? { usage } : {})
        };
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
          await runtime.close();
        } catch (cause) {
          runtimeCloseFailure = cause;
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
            await this.conversationStore?.bindResult(ticket, threadId, receipt);
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
    missingConversationText?: string
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
      return fallback.input;
    };
    try {
      return await this.runTurn(
        thread,
        prepared.input,
        log,
        reporter,
        signal,
        observe,
        localSteeringId,
        missingConversationInput
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
    missingConversationInput?: () => Promise<Input>
  ): Promise<TurnOutcome> {
    let finalResponse: string | undefined;
    let threadId: string | undefined;
    let usage: UsageSummary | undefined;
    let turnCompleted = false;
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


function buildPrompt(ticket: Ticket, history: unknown): string {
  const serializedHistory = typeof history === "string"
    ? history
    : JSON.stringify(history ?? null, null, 2);
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
    ticket.instructions,
    ...contextSection,
    "",
    "## Durable ticket history",
    serializedHistory,
    "",
    "Return the required structured handoff. Use outcome AI_DONE when the work is ready for user review, or AI_NEEDS_FEEDBACK when a specific human answer is required. Any inherited_context in durable history is branch-specific prior-session evidence; the current ticket and latest human revision override it, and important claims should be verified against the workspace. context_summary is private rolling operational memory attached to the same comment as user_message: record completed work, artifacts, decisions, verification, blockers, and next steps for a fresh worker; keep it as short as useful and normally under 8000 characters, and never include secrets or hidden chain-of-thought. Keep user_message concise and human-facing, and do not duplicate the context summary in it.",
    USER_MESSAGE_FORMAT_INSTRUCTION
  ].join("\n");
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
