import { Buffer } from "node:buffer";
import type { Logger } from "pino";
import { z } from "zod";
import type { EngineConfig, EngineSource, SourceMetadata } from "./config.js";
import { errorContext } from "./errors.js";
import { Supervisor, type PollCycleResult, type SharedCapacity } from "./supervisor.js";

type ReadySource = Extract<EngineSource, { kind: "ready" }>;
type Settings = Parameters<Supervisor["updateLocalSettings"]>[0];
interface SourceSession {
  source: ReadySource;
  supervisor: Supervisor;
  nextPollAt: number;
  idleCycles: number;
  waitingForCapacity: boolean;
  inFlight?: Promise<PollCycleResult>;
}
const localIdSchema = z.tuple([z.string().min(1), z.string().min(1)]);
const emptyCycle = (): PollCycleResult => ({ newWorkers: 0, recoveredWorkers: 0, steeringEvents: 0, cancellationRequests: 0, runningWorkers: 0 });

export function localWorkerId(sourceId: string, workerId: string): string {
  return Buffer.from(JSON.stringify([sourceId, workerId])).toString("base64url");
}

export class SourceSupervisor {
  private readonly sessions: SourceSession[];
  private readonly sources: EngineSource[];
  private readonly order: string[];
  private readonly config: EngineConfig;
  private readonly logger: Logger;
  private maxWorkers: number;
  private pollIntervalMs: number;
  private intakePaused: boolean;
  private stopped = false;
  private reconciled = false;
  private startup: Promise<void> | undefined;
  private wakeController: AbortController | undefined;

  constructor(options: {
    config: EngineConfig;
    logger: Logger;
    intakePaused?: boolean;
    createSupervisor(source: ReadySource, capacity: SharedCapacity): Supervisor;
  }) {
    this.config = options.config;
    this.sources = options.config.sources;
    this.logger = options.logger.child({ component: "sources" });
    this.maxWorkers = options.config.max_workers;
    this.pollIntervalMs = options.config.poll_interval_ms;
    this.intakePaused = options.intakePaused ?? false;
    this.sessions = this.sources.flatMap(source => source.kind === "ready" ? [{
      source,
      supervisor: options.createSupervisor(source, {
        freeSlots: () => this.freeSlots(),
        pollSlots: () => this.pollSlots(source.metadata.id),
        changed: () => this.capacityChanged()
      }),
      nextPollAt: 0,
      idleCycles: 0,
      waitingForCapacity: false
    }] : []);
    this.order = this.sessions.map(session => session.source.metadata.id);
  }

  get runningCount(): number {
    return this.sessions.reduce((count, session) => count + session.supervisor.runningCount, 0);
  }

  get reservedSlots(): number {
    return this.sessions.reduce((count, session) => count + session.supervisor.pendingClaimSlots, 0);
  }

  private freeSlots(): number {
    return Math.max(0, this.maxWorkers - this.runningCount - this.reservedSlots);
  }

  private pollSlots(sourceId: string): number {
    const session = this.sessions.find(entry => entry.source.metadata.id === sourceId);
    if (!session || this.stopped || this.intakePaused) return 0;
    const now = Date.now();
    const next = this.admissionCandidate(sourceId, now);
    const available = this.freeSlots();
    if (!available || next !== sourceId) {
      session.waitingForCapacity = true;
      return 0;
    }
    session.waitingForCapacity = false;
    this.order.splice(this.order.indexOf(sourceId), 1);
    this.order.push(sourceId);
    return Math.min(available, Math.max(1, Math.ceil(this.maxWorkers / this.sessions.length)));
  }

  private admissionCandidate(requester?: string, now = Date.now()): string | undefined {
    return this.order.find(id => {
      const entry = this.sessions.find(candidate => candidate.source.metadata.id === id);
      if (!entry || !entry.supervisor.admissionAllowed || entry.supervisor.pendingClaimSlots > 0) return false;
      if (entry.waitingForCapacity) return true;
      return (!entry.inFlight || id === requester) && !entry.supervisor.hasPendingPoll && entry.nextPollAt <= now;
    });
  }

  private capacityChanged(): void {
    if (this.freeSlots() > 0) {
      for (const session of this.sessions) if (session.waitingForCapacity) session.nextPollAt = 0;
    }
    this.wakeController?.abort();
  }

  localSnapshot() {
    const views = this.sessions.map(session => ({ session, snapshot: session.supervisor.localSnapshot() }));
    const pollers = this.sources.map(source => {
      if (source.kind === "error") return { id: source.metadata.id, name: source.metadata.name,
        type: "tzudo", status: "error", url: source.metadata.poll_url, error: source.error, reserved_slots: 0 };
      const view = views.find(entry => entry.session.source === source)!;
      return { ...view.snapshot.poller, id: source.metadata.id, name: source.metadata.name, url: source.metadata.poll_url,
        reserved_slots: view.session.supervisor.pendingClaimSlots };
    });
    const workers = views.flatMap(({ session, snapshot }) => snapshot.workers.map(worker => ({ ...worker,
      id: localWorkerId(session.source.metadata.id, worker.id),
      source_id: session.source.metadata.id, source_name: session.source.metadata.name
    })));
    return { version: 2, runtime_adapter: this.config.runtime_adapter, instance_id: this.config.instance_id,
      max_workers: this.maxWorkers, intake_paused: this.intakePaused, poll_interval_ms: this.pollIntervalMs,
      running_workers: this.runningCount, pollers, workers };
  }

  updateLocalSettings(settings: Settings): void {
    if (settings.max_workers !== undefined) this.maxWorkers = settings.max_workers;
    if (settings.poll_interval_ms !== undefined) this.pollIntervalMs = settings.poll_interval_ms;
    if (settings.intake_paused !== undefined) this.intakePaused = settings.intake_paused;
    for (const session of this.sessions) {
      session.supervisor.updateLocalSettings(settings);
      session.nextPollAt = 0;
      session.idleCycles = 0;
    }
    this.wakeController?.abort();
  }

  private worker(id: string): { supervisor: Supervisor; workerId: string } {
    let parts: z.infer<typeof localIdSchema>;
    try { parts = localIdSchema.parse(JSON.parse(Buffer.from(id, "base64url").toString("utf8"))); }
    catch { throw new Error("Invalid source worker ID"); }
    const session = this.sessions.find(entry => entry.source.metadata.id === parts[0]);
    if (!session) throw new Error("Worker source is no longer configured");
    return { supervisor: session.supervisor, workerId: parts[1] };
  }

  queueLocalSteering(id: string, message: string, requestId: string): void {
    const worker = this.worker(id);
    worker.supervisor.queueLocalSteering(worker.workerId, message, requestId);
  }

  stopLocalWorker(id: string): void {
    const worker = this.worker(id);
    worker.supervisor.stopLocalWorker(worker.workerId);
  }

  pinLocalWorker(id: string, options: { pinned: boolean }): boolean {
    try {
      const worker = this.worker(id);
      return worker.supervisor.pinLocalWorker(worker.workerId, options);
    } catch { return false; }
  }

  private async reconcile(): Promise<void> {
    if (this.reconciled || this.intakePaused || this.stopped) return;
    this.startup ??= Promise.allSettled(this.sessions.map(async session => {
      try { await session.supervisor.reconcileOnce(); }
      catch (cause) { this.logFailure(session.source.metadata, cause); }
    })).then(() => { this.reconciled = true; });
    await this.startup;
  }

  private logFailure(source: SourceMetadata, cause: unknown): void {
    this.logger.error({ event: "source.poll_failed", source_id: source.id, ...errorContext(cause) }, "Source poll failed");
  }

  private async poll(session: SourceSession): Promise<PollCycleResult> {
    let result = emptyCycle();
    try {
      result = await session.supervisor.runOnce();
      const activity = result.newWorkers + result.recoveredWorkers + result.steeringEvents + result.cancellationRequests;
      session.idleCycles = !activity && !session.supervisor.runningCount && session.supervisor.lastPollSlots > 0 ? session.idleCycles + 1 : 0;
    } catch (cause) {
      this.logFailure(session.source.metadata, cause);
      session.waitingForCapacity = false;
      session.idleCycles = 0;
    }
    const idleDelay = this.pollIntervalMs * 2 ** Math.min(Math.max(0, session.idleCycles - 1), 10);
    session.nextPollAt = Date.now() + Math.min(idleDelay, Math.max(this.pollIntervalMs, this.config.idle_backoff_max_ms));
    if (this.freeSlots() > 0 && (session.waitingForCapacity && this.admissionCandidate(session.source.metadata.id) === session.source.metadata.id || result.newWorkers > 0)) session.nextPollAt = 0;
    return result;
  }

  private launch(session: SourceSession): Promise<PollCycleResult> {
    const promise = this.poll(session).finally(() => {
      delete session.inFlight;
      this.wakeController?.abort();
    });
    session.inFlight = promise;
    return promise;
  }

  async runOnce(): Promise<PollCycleResult> {
    if (this.stopped || this.intakePaused && this.runningCount === 0 && this.reservedSlots === 0) return emptyCycle();
    await this.reconcile();
    const results = await Promise.all(this.order.map(id => this.sessions.find(session => session.source.metadata.id === id)!)
      .map(session => session.inFlight ?? this.launch(session)));
    return results.reduce((total, result) => ({ newWorkers: total.newWorkers + result.newWorkers,
      recoveredWorkers: total.recoveredWorkers + result.recoveredWorkers, steeringEvents: total.steeringEvents + result.steeringEvents,
      cancellationRequests: total.cancellationRequests + result.cancellationRequests, runningWorkers: this.runningCount }), emptyCycle());
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      await this.reconcile();
      if (this.stopped) break;
      const now = Date.now();
      if (!this.intakePaused || this.runningCount > 0 || this.reservedSlots > 0) {
        const due = [...this.order].flatMap(id => this.sessions.filter(session => session.source.metadata.id === id && !session.inFlight && session.nextPollAt <= now));
        for (const session of due) void this.launch(session);
      }
      const times = this.sessions.filter(session => !session.inFlight).map(session => session.nextPollAt);
      const delay = this.intakePaused && this.runningCount === 0 && this.reservedSlots === 0 ? 60_000
        : Math.max(1, Math.min(60_000, ...times.map(time => Math.max(1, time - Date.now()))));
      this.wakeController = new AbortController();
      const controller = this.wakeController;
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, delay);
        controller.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
  }

  async drain(): Promise<void> {
    await Promise.all(this.sessions.map(session => session.supervisor.drain()));
  }

  async shutdown(graceMs = this.config.shutdown_grace_ms): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.wakeController?.abort();
    await Promise.all(this.sessions.map(session => session.supervisor.shutdown(graceMs)));
    await Promise.allSettled(this.sessions.flatMap(session => session.inFlight ? [session.inFlight] : []));
  }
}
