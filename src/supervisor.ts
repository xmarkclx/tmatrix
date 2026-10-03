import type { LocalWorkerState } from "./local-worker-state.js";
import { localPollError } from "./helpers/local-poll-error.js";
import { localPromptPreview } from "./helpers/local-prompt-preview.js";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { CancellationApi } from "./api-client.js";
import type { WorkerConfig } from "./config.js";
import {
  errorContext,
  RunCancellationError,
  WorkerError
} from "./errors.js";
import type { Metrics } from "./metrics.js";
import { SteeringMailbox, type TicketRunner } from "./runner.js";
import {
  isRecoverableOwnedTicket,
  type CancellationRequest,
  type PollRequest,
  type PollResponse,
  type SteeringEvent,
  type Ticket
} from "./types.js";

interface Poller {
  poll(request: PollRequest, signal?: AbortSignal): Promise<PollResponse>;
}

interface ControlChannel {
  updateUrl(url: string): void;
  suspend(): void;
  close(): Promise<void>;
}

interface RunningWorker {
  runId: string;
  ticketId: string;
  workerId: string;
  controller: AbortController;
  promise: Promise<void>;
  startedAt: number;
  steering: SteeringMailbox;
  settledCleanly: boolean;
}

interface CancellationState {
  request: CancellationRequest;
  status: "pending" | "acknowledged";
  promise: Promise<void>;
}

export interface PollCycleResult {
  newWorkers: number;
  recoveredWorkers: number;
  steeringEvents: number;
  cancellationRequests: number;
  runningWorkers: number;
}

const MAX_CANCELLATION_TOMBSTONES = 10_000;
// Tzu Do caps each poll at 32 new claims, independently of worker capacity.
const MAX_POLL_SLOTS = 32;

export class Supervisor {
  private readonly config: WorkerConfig;
  private readonly poller: Poller;
  private readonly runner: TicketRunner;
  private readonly cancellationApi: CancellationApi | undefined;
  private readonly control: ControlChannel | undefined;
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private readonly running = new Map<string, RunningWorker>();
  private readonly missingRecoveryPayloads = new Set<string>();
  private readonly cancellations = new Map<string, CancellationState>();
  private readonly cancelledWorkers = new Map<string, CancellationRequest>();
  private readonly acknowledgedCancellationOrder: string[] = [];
  private cancellationAckController = new AbortController();
  private readonly localState: LocalWorkerState | undefined;
  private readonly localStops = new Set<string>();
  private readonly localSteeringIds = new Map<string, { workerId: string; message: string }>();
  private intakePaused: boolean;
  private maxWorkers: number;
  private pollIntervalMs: number;
  private pollStatus: "paused" | "polling" | "connected" | "error" | "stopped" = "paused";
  private lastPollAt: string | undefined;
  private lastPollError: string | undefined;
  private stopped = false;
  private pollAuthorizationRevoked = false;
  private pollController?: AbortController;
  private wakeController?: AbortController;
  // Retain a poll after an ambiguous timeout: the server may already have claimed work.
  private pendingPoll?: PollRequest;
  private idleCycles = 0;
  private startupReconciled = false;

  constructor(options: {
    config: WorkerConfig;
    poller: Poller;
    runner: TicketRunner;
    cancellationApi?: CancellationApi;
    control?: ControlChannel;
    logger: Logger;
    metrics: Metrics;
    sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
    localState?: LocalWorkerState;
    intakePaused?: boolean;
  }) {
    this.config = options.config;
    this.localState = options.localState;
    this.intakePaused = options.intakePaused ?? false;
    this.maxWorkers = options.config.max_workers;
    this.pollIntervalMs = options.config.poll_interval_ms;
    this.poller = options.poller;
    this.runner = options.runner;
    this.cancellationApi = options.cancellationApi;
    this.control = options.control;
    this.logger = options.logger.child({ component: "supervisor" });
    this.metrics = options.metrics;
    this.sleep = options.sleep ?? abortableDelay;
  }

  get runningCount(): number {
    return this.running.size;
  }

  localSnapshot() {
    return {
      version: 1,
      runtime_adapter: this.config.runtime_adapter,
      instance_id: this.config.instance_id,
      max_workers: this.maxWorkers,
      intake_paused: this.intakePaused,
      poll_interval_ms: this.pollIntervalMs,
      running_workers: this.running.size,
      poller: {
        type: "tzudo",
        status: this.stopped ? "stopped" : this.intakePaused && this.running.size === 0 ? "paused" : this.pollStatus,
        url: new URL(this.config.poll_url).origin + new URL(this.config.poll_url).pathname,
        ...(this.lastPollAt ? { last_poll_at: this.lastPollAt } : {}),
        ...(this.lastPollError ? { error: this.lastPollError } : {})
      },
      workers: this.localState?.snapshot() ?? []
    };
  }

  updateLocalSettings(settings: { max_workers?: number; intake_paused?: boolean; poll_interval_ms?: number }): void {
    if (settings.max_workers !== undefined) this.maxWorkers = settings.max_workers;
    if (settings.intake_paused !== undefined) this.intakePaused = settings.intake_paused;
    if (settings.poll_interval_ms !== undefined) this.pollIntervalMs = settings.poll_interval_ms;
    this.idleCycles = 0;
    this.wakeController?.abort();
  }

  queueLocalSteering(workerId: string, message: string, id: string): void {
    const duplicate = this.localSteeringIds.get(id);
    if (duplicate) {
      if (duplicate.workerId !== workerId || duplicate.message !== message) throw new Error("Request ID was already used for a different message");
      return;
    }
    const worker = this.running.get(workerId);
    if (!worker || worker.controller.signal.aborted) throw new Error("Worker is no longer accepting messages");
    if (!worker.steering.enqueueLocal(id, message)) throw new Error("Worker is finishing or its local message queue is full");
    this.localSteeringIds.set(id, { workerId, message });
    // Keep recent operation IDs for retries without retaining unbounded text.
    if (this.localSteeringIds.size > 1000) this.localSteeringIds.delete(this.localSteeringIds.keys().next().value!);
    this.localState?.queue(workerId, id);
  }

  pinLocalWorker(workerId: string, options: { pinned: boolean }): boolean {
    return this.localState?.setPinned(workerId, options) ?? false;
  }

  stopLocalWorker(workerId: string): void {
    const worker = this.running.get(workerId);
    if (!worker) throw new Error("Worker is no longer running");
    if (worker.controller.signal.aborted) return;
    // Local stop must never be presented as a server cancellation ACK. Retain
    // this claim's tombstone so the next poll cannot immediately resurrect it.
    this.localStops.add(`${worker.ticketId}:${worker.workerId}`);
    this.localState?.status(workerId, "stopping");
    worker.controller.abort(new RunCancellationError({ kind: "user", ticketId: worker.ticketId, workerId }));
  }

  async run(): Promise<void> {
    this.logger.info({ event: "supervisor.loop_started" }, "Poll loop started");
    while (!this.stopped) {
      let result: PollCycleResult | undefined;
      try {
        result = await this.runOnce();
      } catch (cause) {
        if (this.stopped) break;
        const context = errorContext(cause);
        this.metrics.increment("poll_failed");
        this.metrics.recordFailure(String(context.error_code ?? "POLL_FAILED"), String(context.error_stage ?? "poll"));
        this.logger.error({ event: "poll.cycle_failed", ...context }, "Poll cycle failed");
      }

      const hadActivity = result !== undefined &&
        result.newWorkers + result.recoveredWorkers + result.steeringEvents +
          result.cancellationRequests > 0;
      this.idleCycles = hadActivity || this.running.size > 0 ? 0 : this.idleCycles + 1;
      const delayMs = this.nextPollDelay();
      this.logger.debug({
        event: "poll.sleeping",
        delay_ms: delayMs,
        idle_cycles: this.idleCycles,
        running_workers: this.running.size
      }, "Waiting before next poll");
      this.wakeController = new AbortController();
      try {
        const signal = this.pollController ? AbortSignal.any([this.pollController.signal, this.wakeController.signal]) : this.wakeController.signal;
        await this.sleep(delayMs, signal);
      } catch {
        if (!this.stopped && !this.wakeController.signal.aborted) throw new Error("Poll delay was unexpectedly interrupted");
      }
    }
    this.logger.info({ event: "supervisor.loop_stopped" }, "Poll loop stopped");
  }

  async runOnce(): Promise<PollCycleResult> {
    if (this.intakePaused && this.running.size === 0 && !this.pendingPoll) {
      this.pollStatus = "paused";
      return { newWorkers: 0, recoveredWorkers: 0, steeringEvents: 0, cancellationRequests: 0, runningWorkers: 0 };
    }
    if (this.startupReconciled) {
      return this.pollOnce(this.availableSlots(), false);
    }

    const reconciliation = await this.pollOnce(0, true);
    this.startupReconciled = true;
    const availableSlots = this.availableSlots();
    if (availableSlots === 0 || this.stopped) return reconciliation;

    // `--once` still performs useful intake after its restart reconciliation.
    const intake = await this.pollOnce(availableSlots, false);
    return {
      newWorkers: reconciliation.newWorkers + intake.newWorkers,
      recoveredWorkers: reconciliation.recoveredWorkers + intake.recoveredWorkers,
      steeringEvents: reconciliation.steeringEvents + intake.steeringEvents,
      cancellationRequests:
        reconciliation.cancellationRequests + intake.cancellationRequests,
      runningWorkers: this.running.size
    };
  }

  private async pollOnce(
    availableSlots: number,
    startupReconciliation: boolean
  ): Promise<PollCycleResult> {
    const request = this.pendingPoll ?? {
      poll_id: randomUUID(),
      instance_id: this.config.instance_id,
      ...(this.config.swarm_id ? { swarm_id: this.config.swarm_id } : {}),
      available_slots: availableSlots
    };
    this.pendingPoll = request;
    const pollId = request.poll_id;
    availableSlots = request.available_slots;
    const startedAt = Date.now();
    this.pollController = new AbortController();
    this.metrics.increment("poll_attempts");
    this.logger.info({
      event: "poll.started",
      poll_id: pollId,
      available_slots: availableSlots,
      startup_reconciliation: startupReconciliation,
      running_workers: this.running.size
    }, "Polling for tickets");

    let response: PollResponse;
    this.pollStatus = "polling";
    try {
      response = await this.poller.poll(request, this.pollController.signal);
      delete this.pendingPoll;
      // A fresh authenticated response establishes ownership again. Old runs
      // remain aborted and occupy their slots until their teardown settles.
      if (this.pollAuthorizationRevoked && !this.stopped) {
        this.pollAuthorizationRevoked = false;
        this.cancellationAckController = new AbortController();
        this.metrics.increment("poll_authorization_restored");
        this.logger.info({ event: "poll.authorization_restored", poll_id: pollId },
          "Poll authorization restored; resuming owned work automatically");
      }
      this.pollStatus = "connected";
      this.lastPollError = undefined;
      this.lastPollAt = new Date().toISOString();
    } catch (cause) {
      this.pollStatus = "error";
      this.lastPollError = localPollError(cause, this.config.api_key);
      const status = pollAuthorizationStatus(cause);
      if (status !== undefined) {
        // Authorization rejection is definitive, unlike an ambiguous timeout.
        // Reconcile fresh ownership instead of replaying a pre-rejection poll.
        delete this.pendingPoll;
        this.revokeAllWorkersForPollAuthorization(pollId, status);
      }
      throw cause;
    }

    this.metrics.increment("poll_succeeded");
    this.metrics.recordPollSuccess();
    this.metrics.observeDuration("poll.cycle", Date.now() - startedAt);
    this.metrics.increment("tickets_received", response.new_tickets.length);
    this.metrics.increment("steering_received", response.steering_events.length);
    this.metrics.increment(
      "cancellations_received",
      response.cancellation_requests.length
    );

    if (response.control_url) this.control?.updateUrl(response.control_url);

    let newWorkers = 0;
    let recoveredWorkers = 0;
    let steeringEvents = 0;
    let cancellationRequests = 0;

    // Cancellation is control-plane state and must win over recovery, intake,
    // and steering returned by the same response.
    for (const cancellation of response.cancellation_requests) {
      if (this.handleCancellation(cancellation, "poll")) {
        cancellationRequests += 1;
      }
    }

    this.abortWorkersMissingFromAuthoritativeOwnership(response, pollId);

    const ownedKeys = new Set(response.owned_in_progress.map((ticket) => `${ticket.ticket_id}:${ticket.worker_id}`));
    for (const key of this.missingRecoveryPayloads) {
      if (!ownedKeys.has(key)) this.missingRecoveryPayloads.delete(key);
    }

    for (const owned of response.owned_in_progress) {
      if (this.intakePaused || this.localStops.has(`${owned.ticket_id}:${owned.worker_id}`)) continue;
      if (this.isCancelledClaim(owned.ticket_id, owned.worker_id, pollId)) continue;
      if (this.running.has(owned.worker_id)) continue;

      const sameTicket = [...this.running.values()].find((worker) => worker.ticketId === owned.ticket_id);
      if (sameTicket) {
        this.logger.warn({
          event: "recovery.worker_id_mismatch",
          poll_id: pollId,
          ticket_id: owned.ticket_id,
          api_worker_id: owned.worker_id,
          local_worker_id: sameTicket.workerId,
          local_run_id: sameTicket.runId
        }, "Owned ticket is already running locally under a different worker id");
        continue;
      }

      if (!isRecoverableOwnedTicket(owned)) {
        const key = `${owned.ticket_id}:${owned.worker_id}`;
        const firstObservation = !this.missingRecoveryPayloads.has(key);
        this.missingRecoveryPayloads.add(key);
        if (firstObservation) {
          this.metrics.increment("recovery_payload_missing");
          this.logger.error({
            event: "recovery.payload_missing",
            poll_id: pollId,
            ticket_id: owned.ticket_id,
            worker_id: owned.worker_id,
            required_fields: [
              "instructions",
              "endpoints",
              "execution_mode",
              "model",
              "reasoning_effort",
              "service_tier"
            ]
          }, "Dead worker detected, but the poll response lacks the payload required to resume it");
        } else {
          this.logger.debug({
            event: "recovery.payload_still_missing",
            poll_id: pollId,
            ticket_id: owned.ticket_id,
            worker_id: owned.worker_id
          }, "Recovery payload is still missing");
        }
        continue;
      }

      if (this.running.size >= this.maxWorkers) {
        this.logger.info({
          event: "recovery.deferred_capacity",
          poll_id: pollId,
          ticket_id: owned.ticket_id,
          worker_id: owned.worker_id,
          max_workers: this.maxWorkers
        }, "Dead worker recovery deferred until a slot is available");
        continue;
      }

      if (this.start(owned, true, pollId)) recoveredWorkers += 1;
    }

    let remainingNewTicketBudget = availableSlots;
    for (const ticket of response.new_tickets) {
      if (remainingNewTicketBudget <= 0 || this.running.size >= this.maxWorkers) {
        this.logger.error({
          event: "poll.capacity_violation",
          poll_id: pollId,
          ticket_id: ticket.ticket_id,
          worker_id: ticket.worker_id,
          advertised_slots: availableSlots,
          max_workers: this.maxWorkers
        }, "Poll API returned more new tickets than advertised or locally available capacity; ticket was not started");
        continue;
      }
      if (this.isCancelledClaim(ticket.ticket_id, ticket.worker_id, pollId)) {
        continue;
      }
      if (this.start(ticket, false, pollId)) {
        newWorkers += 1;
        remainingNewTicketBudget -= 1;
      }
    }

    for (const steering of response.steering_events) {
      if (this.routeSteering(steering, pollId)) steeringEvents += 1;
    }

    if (
      newWorkers + recoveredWorkers + steeringEvents + cancellationRequests === 0
    ) this.metrics.increment("poll_empty");
    this.logger.info({
      event: "poll.completed",
      poll_id: pollId,
      duration_ms: Date.now() - startedAt,
      startup_reconciliation: startupReconciliation,
      new_tickets: response.new_tickets.length,
      owned_in_progress: response.owned_in_progress.length,
      new_workers_started: newWorkers,
      recovered_workers_started: recoveredWorkers,
      steering_events_routed: steeringEvents,
      cancellation_requests_routed: cancellationRequests,
      running_workers: this.running.size
    }, "Poll cycle completed");

    return {
      newWorkers,
      recoveredWorkers,
      steeringEvents,
      cancellationRequests,
      runningWorkers: this.running.size
    };
  }

  /** Limits new claims per request while allowing earlier claims to keep running. */
  private availableSlots(): number {
    if (this.intakePaused || this.pollAuthorizationRevoked) return 0;
    return Math.min(
      Math.max(0, this.maxWorkers - this.running.size),
      this.config.max_tickets_per_poll ?? this.maxWorkers,
      MAX_POLL_SLOTS
    );
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.running.values()].map((worker) => worker.promise));
  }

  /** Waits for the current workers and clears the deadline timer after an early drain. */
  private async drainFor(milliseconds: number): Promise<void> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.drain(),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, milliseconds);
        })
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  /** Stops intake, then drains with the configured or caller-supplied deadline. */
  async shutdown(graceMs = this.config.shutdown_grace_ms): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.wakeController?.abort();
    this.pollController?.abort(new Error("Worker daemon is shutting down"));
    this.logger.info({
      event: "shutdown.started",
      running_workers: this.running.size,
      grace_ms: graceMs
    }, "Graceful shutdown started");

    if (this.running.size > 0 && graceMs === -1) {
      await this.drain();
    } else if (this.running.size > 0 && graceMs > 0) {
      await this.drainFor(graceMs);
    }

    if (this.running.size > 0) {
      this.logger.warn({
        event: "shutdown.aborting_workers",
        running_workers: this.running.size
      }, "Grace period ended; aborting remaining workers");
      for (const worker of this.running.values()) {
        worker.controller.abort(new Error("Shutdown grace period expired"));
      }
      await this.drainFor(5_000);
    }

    await Promise.allSettled(
      [...this.cancellations.values()]
        .filter((state) => state.status === "pending")
        .map((state) => state.promise)
    );

    // Push control remains available throughout an unlimited service drain so
    // a user can still stop an active task after the daemon stops intake.
    if (this.control) {
      try {
        await this.control.close();
      } catch (cause) {
        this.logger.warn({
          event: "control.close_failed",
          ...errorContext(cause)
        }, "AI control WebSocket did not close cleanly");
      }
    }

    this.logger.info({
      event: "shutdown.completed",
      running_workers: this.running.size
    }, "Graceful shutdown completed");
  }

  private start(ticket: Ticket, recovered: boolean, pollId: string): boolean {
    // An abort-aware poll should reject during shutdown, but this guard also
    // protects against implementations that resolve after their signal fires.
    if (this.stopped || this.pollAuthorizationRevoked || this.localStops.has(`${ticket.ticket_id}:${ticket.worker_id}`)) return false;
    if (this.running.has(ticket.worker_id)) {
      this.logger.warn({
        event: "worker.duplicate_worker_id",
        poll_id: pollId,
        ticket_id: ticket.ticket_id,
        worker_id: ticket.worker_id
      }, "Ticket was not started because its worker id is already running");
      return false;
    }
    const duplicateTicket = [...this.running.values()].find((worker) => worker.ticketId === ticket.ticket_id);
    if (duplicateTicket) {
      this.logger.warn({
        event: "worker.duplicate_ticket_id",
        poll_id: pollId,
        ticket_id: ticket.ticket_id,
        worker_id: ticket.worker_id,
        running_worker_id: duplicateTicket.workerId
      }, "Ticket was not started because the ticket is already running locally");
      return false;
    }

    const runId = randomUUID();
    const controller = new AbortController();
    const steering = new SteeringMailbox();
    const running: RunningWorker = {
      runId,
      ticketId: ticket.ticket_id,
      workerId: ticket.worker_id,
      controller,
      promise: Promise.resolve(),
      startedAt: Date.now(),
      steering,
      settledCleanly: false
    };
    this.running.set(ticket.worker_id, running);
    this.localState?.start(ticket);
    this.metrics.setRunningWorkers(this.running.size);
    this.metrics.increment("workers_started");
    if (recovered) this.metrics.increment("workers_recovered");

    this.logger.info({
      event: recovered ? "worker.recovery_started" : "worker.started",
      poll_id: pollId,
      ticket_id: ticket.ticket_id,
      worker_id: ticket.worker_id,
      run_id: runId,
      recovered,
      running_workers: this.running.size
    }, recovered ? "Recovering dead ticket worker" : "Ticket worker started");

    running.promise = this.runner.run(ticket, {
      runId,
      recovered,
      steering,
      ...(this.localState ? { observe: (event: import("./local-worker-state.js").WorkerObservation) => this.localState?.record(ticket.worker_id, event) } : {}),
      signal: controller.signal
    }).then((outcome) => {
      running.settledCleanly = true;
      this.localState?.status(ticket.worker_id, outcome.status === "cancelled" ? "stopped" : outcome.status);
      this.metrics.increment(
        outcome.status === "completed"
          ? "workers_completed"
          : outcome.status === "cancelled"
            ? "workers_cancelled"
            : "workers_failed"
      );
      this.metrics.observeDuration("worker.run", Date.now() - running.startedAt);
      this.logger.info({
        event: "worker.finished",
        ticket_id: ticket.ticket_id,
        worker_id: ticket.worker_id,
        run_id: runId,
        outcome: outcome.status,
        thread_id: outcome.threadId,
        duration_ms: Date.now() - running.startedAt
      }, "Ticket worker finished");
    }).catch((cause: unknown) => {
      this.localState?.status(ticket.worker_id, controller.signal.aborted ? "stop_unverified" : "failed");
      this.metrics.increment("workers_failed");
      this.metrics.recordFailure(
        cause instanceof WorkerError ? cause.code : "WORKER_UNHANDLED_FAILURE",
        cause instanceof WorkerError ? cause.stage : "worker"
      );
      this.logger.error({
        event: "worker.unhandled_failure",
        ticket_id: ticket.ticket_id,
        worker_id: ticket.worker_id,
        run_id: runId,
        duration_ms: Date.now() - running.startedAt,
        ...errorContext(cause)
      }, "Ticket worker ended with an unhandled failure");
    }).finally(() => {
      if (this.running.get(ticket.worker_id)?.runId === runId) {
        this.running.delete(ticket.worker_id);
        this.metrics.setRunningWorkers(this.running.size);
      }
    });

    return true;
  }

  private nextPollDelay(): number {
    if (this.running.size > 0) return this.pollIntervalMs;
    if (this.idleCycles <= 1) return this.pollIntervalMs;
    const exponential = this.pollIntervalMs * 2 ** Math.min(this.idleCycles - 1, 10);
    return Math.min(exponential, Math.max(this.pollIntervalMs, this.config.idle_backoff_max_ms));
  }

  /**
   * Routes a durable cancellation from push or poll. The event is tombstoned
   * before any asynchronous work so duplicate delivery cannot start its claim.
   */
  handleCancellation(
    request: CancellationRequest,
    source: "poll" | "push" = "push"
  ): boolean {
    const existing = this.cancellations.get(request.event_id);
    if (existing) {
      if (!sameCancellation(existing.request, request)) {
        this.logger.error({
          event: "cancellation.event_conflict",
          event_id: request.event_id,
          ticket_id: request.ticket_id,
          worker_id: request.worker_id,
          existing_ticket_id: existing.request.ticket_id,
          existing_worker_id: existing.request.worker_id
        }, "Cancellation event id was reused with conflicting ownership");
      } else {
        this.logger.debug({
          event: "cancellation.duplicate_ignored",
          event_id: request.event_id,
          ticket_id: request.ticket_id,
          worker_id: request.worker_id,
          source,
          status: existing.status
        }, "Duplicate cancellation request ignored");
      }
      return false;
    }

    // A worker id is not sufficient authority by itself. Reject a stale or
    // malformed event before creating any tombstone for the active claim.
    const activeWorker = this.running.get(request.worker_id);
    if (activeWorker && activeWorker.ticketId !== request.ticket_id) {
      this.logger.error({
        event: "cancellation.ownership_mismatch",
        event_id: request.event_id,
        ticket_id: request.ticket_id,
        worker_id: request.worker_id,
        active_ticket_id: activeWorker.ticketId,
        source
      }, "Cancellation request does not match the active ticket and worker");
      return false;
    }

    const conflictingWorker = this.cancelledWorkers.get(request.worker_id);
    if (conflictingWorker && !sameCancellationClaim(conflictingWorker, request)) {
      this.logger.error({
        event: "cancellation.worker_conflict",
        event_id: request.event_id,
        ticket_id: request.ticket_id,
        worker_id: request.worker_id,
        existing_event_id: conflictingWorker.event_id,
        existing_ticket_id: conflictingWorker.ticket_id
      }, "Cancellation request conflicts with an existing worker tombstone");
      return false;
    }

    this.cancelledWorkers.set(request.worker_id, request);
    const state: CancellationState = {
      request,
      status: "pending",
      promise: Promise.resolve()
    };
    this.cancellations.set(request.event_id, state);
    this.metrics.increment("cancellations_routed");
    this.logger.info({
      event: "cancellation.requested",
      event_id: request.event_id,
      ticket_id: request.ticket_id,
      worker_id: request.worker_id,
      source,
      requested_at: request.requested_at
    }, "AI work cancellation requested");

    state.promise = this.stopAndAcknowledgeCancellation(request).then(() => {
      state.status = "acknowledged";
      this.rememberAcknowledgedCancellation(request.event_id);
    }).catch((cause) => {
      // Poll replay is the retry mechanism. Remove only the event-level entry;
      // retain the worker tombstone so a cancelled claim can never start.
      if (this.cancellations.get(request.event_id) === state) {
        this.cancellations.delete(request.event_id);
      }
      this.metrics.increment("cancellation_ack_failed");
      this.logger.error({
        event: "cancellation.ack_failed",
        event_id: request.event_id,
        ticket_id: request.ticket_id,
        worker_id: request.worker_id,
        ...errorContext(cause)
      }, "AI cancellation could not be acknowledged");
    });
    return true;
  }

  /** Stops an exact local run and acknowledges only after its teardown resolves. */
  private async stopAndAcknowledgeCancellation(
    request: CancellationRequest
  ): Promise<void> {
    // Bind this operation to its authorization period, even if access returns
    // while its runtime is still stopping. Poll replay can retry the ACK.
    const acknowledgementSignal = this.cancellationAckController.signal;
    const worker = this.running.get(request.worker_id);
    if (worker && worker.ticketId !== request.ticket_id) {
      throw new WorkerError({
        message: "Cancellation ticket does not match the active worker",
        code: "CANCELLATION_OWNERSHIP_MISMATCH",
        stage: "cancellation.route",
        details: {
          event_id: request.event_id,
          ticket_id: request.ticket_id,
          worker_id: request.worker_id,
          active_ticket_id: worker.ticketId
        }
      });
    }

    if (worker) {
      this.localState?.status(worker.workerId, "stopping");
      worker.controller.abort(new RunCancellationError({
        kind: "user",
        eventId: request.event_id,
        ticketId: request.ticket_id,
        workerId: request.worker_id
      }));
      this.metrics.increment("workers_cancellation_aborted");
      await worker.promise;
      if (!worker.settledCleanly) {
        throw new WorkerError({
          message: "Cancelled worker teardown was not verified",
          code: "CANCELLATION_STOP_UNVERIFIED",
          stage: "cancellation.stop",
          retryable: true,
          details: {
            event_id: request.event_id,
            ticket_id: request.ticket_id,
            worker_id: request.worker_id
          }
        });
      }
    }

    if (this.pollAuthorizationRevoked || acknowledgementSignal.aborted) {
      throw new WorkerError({
        message: "Cancellation acknowledgement skipped because poll authorization was revoked",
        code: "CANCELLATION_ACK_AUTH_REVOKED",
        stage: "cancellation.ack",
        retryable: false,
        details: {
          event_id: request.event_id,
          ticket_id: request.ticket_id,
          worker_id: request.worker_id
        }
      });
    }
    if (!this.cancellationApi) {
      throw new WorkerError({
        message: "Cancellation acknowledgement API is unavailable",
        code: "CANCELLATION_ACK_UNAVAILABLE",
        stage: "cancellation.ack",
        retryable: true
      });
    }
    await this.cancellationApi.acknowledgeCancellation(
      request,
      acknowledgementSignal
    );
    this.metrics.increment("cancellations_acknowledged");
    this.logger.info({
      event: "cancellation.acknowledged",
      event_id: request.event_id,
      ticket_id: request.ticket_id,
      worker_id: request.worker_id
    }, "AI work cancellation acknowledged after local stop");
  }

  /** Aborts local work omitted from the API's documented complete ownership set. */
  private abortWorkersMissingFromAuthoritativeOwnership(
    response: PollResponse,
    pollId: string
  ): void {
    const authoritative = new Map<string, string>();
    for (const ticket of [...response.owned_in_progress, ...response.new_tickets]) {
      authoritative.set(ticket.worker_id, ticket.ticket_id);
    }

    for (const worker of this.running.values()) {
      const ticketId = authoritative.get(worker.workerId);
      if (ticketId === worker.ticketId) continue;
      if (worker.controller.signal.aborted) continue;

      worker.controller.abort(new RunCancellationError({
        kind: "ownership_revoked",
        ticketId: worker.ticketId,
        workerId: worker.workerId
      }));
      this.metrics.increment("workers_ownership_revoked");
      this.logger.warn({
        event: "worker.ownership_revoked",
        poll_id: pollId,
        ticket_id: worker.ticketId,
        worker_id: worker.workerId,
        ...(ticketId !== undefined ? { api_ticket_id: ticketId } : {})
      }, "Active local worker is absent from authoritative API ownership");
    }
  }

  /** Stops owned runs until a successful poll establishes authorization again. */
  private revokeAllWorkersForPollAuthorization(
    pollId: string,
    status: 401 | 403
  ): void {
    if (!this.pollAuthorizationRevoked) {
      this.pollAuthorizationRevoked = true;
      this.metrics.increment("poll_authorization_rejected");
      this.cancellationAckController.abort(
        new Error("Poll API authorization was revoked")
      );
      if (this.control) {
        this.control.suspend();
      }
      this.logger.error({
        event: "poll.authorization_revoked",
        poll_id: pollId,
        status,
        running_workers: this.running.size
      }, "Poll authorization was rejected; revoking all local AI work");
    }

    for (const worker of this.running.values()) {
      if (worker.controller.signal.aborted) continue;
      worker.controller.abort(new RunCancellationError({
        kind: "ownership_revoked",
        ticketId: worker.ticketId,
        workerId: worker.workerId
      }));
      this.metrics.increment("workers_ownership_revoked");
      this.logger.warn({
        event: "worker.ownership_revoked",
        poll_id: pollId,
        ticket_id: worker.ticketId,
        worker_id: worker.workerId,
        reason: "poll_authorization_rejected",
        status
      }, "Active local worker lost ownership after poll authorization rejection");
    }
  }

  /** Prevents a cancelled claim from starting even when returned in the same poll. */
  private isCancelledClaim(
    ticketId: string,
    workerId: string,
    pollId: string
  ): boolean {
    const cancellation = this.cancelledWorkers.get(workerId);
    if (!cancellation) return false;
    const exact = cancellation.ticket_id === ticketId;
    this.logger[exact ? "info" : "error"]({
      event: exact
        ? "cancellation.claim_suppressed"
        : "cancellation.claim_mismatch",
      poll_id: pollId,
      event_id: cancellation.event_id,
      ticket_id: ticketId,
      cancellation_ticket_id: cancellation.ticket_id,
      worker_id: workerId
    }, exact
      ? "Cancelled AI claim was not started"
      : "AI claim conflicts with a cancellation tombstone");
    return true;
  }

  private rememberAcknowledgedCancellation(eventId: string): void {
    this.acknowledgedCancellationOrder.push(eventId);
    while (this.acknowledgedCancellationOrder.length > MAX_CANCELLATION_TOMBSTONES) {
      const oldest = this.acknowledgedCancellationOrder.shift();
      if (!oldest) break;
      const state = this.cancellations.get(oldest);
      if (state?.status !== "acknowledged") continue;
      this.cancellations.delete(oldest);
      if (this.cancelledWorkers.get(state.request.worker_id)?.event_id === oldest) {
        this.cancelledWorkers.delete(state.request.worker_id);
      }
    }
  }

  /** Routes an edit to its active worker without logging the edited content. */
  private routeSteering(steering: SteeringEvent, pollId: string): boolean {
    const worker = this.running.get(steering.worker_id);
    if (!worker) {
      this.logger.debug({
        event: "steering.worker_not_running",
        poll_id: pollId,
        worker_id: steering.worker_id,
        input_revision: steering.input_revision
      }, "Steering event has no active local worker");
      return false;
    }
    if (worker.controller.signal.aborted) return false;

    const queued = worker.steering.enqueue(steering);
    if (queued && this.localState) {
      const preview = localPromptPreview(steering.content);
      this.localState.record(worker.workerId, {
        kind: "revision.queued",
        text: `Task update received and queued (revision ${steering.input_revision})\n\n${preview.text}` +
          (preview.redacted ? "\n\n[Credentials redacted]" : "") +
          (preview.truncated ? "\n\n[Update preview truncated]" : "")
      });
    }
    if (queued) this.metrics.increment("steering_queued");
    this.logger.debug({
      event: queued ? "steering.queued" : "steering.duplicate_ignored",
      poll_id: pollId,
      ticket_id: worker.ticketId,
      worker_id: worker.workerId,
      run_id: worker.runId,
      input_revision: steering.input_revision
    }, queued ? "Latest steering revision queued" : "Duplicate steering revision ignored");
    return queued;
  }
}

function sameCancellation(
  left: CancellationRequest,
  right: CancellationRequest
): boolean {
  return left.event_id === right.event_id &&
    sameCancellationClaim(left, right) &&
    left.requested_at === right.requested_at &&
    left.acknowledge === right.acknowledge;
}

function sameCancellationClaim(
  left: CancellationRequest,
  right: CancellationRequest
): boolean {
  return left.ticket_id === right.ticket_id && left.worker_id === right.worker_id;
}

function pollAuthorizationStatus(cause: unknown): 401 | 403 | undefined {
  if (
    !(cause instanceof WorkerError) ||
    cause.code !== "HTTP_STATUS_ERROR" ||
    cause.stage !== "http.poll"
  ) return undefined;
  const status = cause.details.status;
  return status === 401 || status === 403 ? status : undefined;
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timeout = setTimeout(resolve, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
