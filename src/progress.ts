import type { Logger } from "pino";
import type { TicketApi } from "./api-client.js";
import { errorContext } from "./errors.js";
import type { Metrics } from "./metrics.js";
import type { ProgressEvent, Ticket } from "./types.js";

const MAX_QUEUED_PROGRESS_EVENTS = 100;
const FINAL_PROGRESS_WAIT_MS = 2_000;

export class ProgressReporter {
  private readonly api: TicketApi;
  private readonly ticket: Ticket;
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  private readonly signal: AbortSignal | undefined;
  private readonly controller = new AbortController();
  private sequence = 0;
  private inputRevision: number;
  private queued = 0;
  private pending: Promise<void> = Promise.resolve();

  constructor(options: {
    api: TicketApi;
    ticket: Ticket;
    logger: Logger;
    metrics: Metrics;
    inputRevision: number;
    signal?: AbortSignal;
  }) {
    this.api = options.api;
    this.ticket = options.ticket;
    this.logger = options.logger;
    this.metrics = options.metrics;
    this.inputRevision = options.inputRevision;
    this.signal = options.signal
      ? AbortSignal.any([options.signal, this.controller.signal])
      : this.controller.signal;
  }

  /** Associates subsequent progress events with the input revision being processed. */
  setInputRevision(inputRevision: number): void {
    this.inputRevision = inputRevision;
  }

  enqueue(kind: string, summary: Record<string, unknown>): void {
    const event: ProgressEvent = {
      sequence: ++this.sequence,
      occurred_at: new Date().toISOString(),
      kind,
      input_revision: this.inputRevision,
      summary
    };

    if (this.queued >= MAX_QUEUED_PROGRESS_EVENTS) {
      this.metrics.increment("progress_failed");
      this.logger.warn({
        event: "progress.queue_full",
        progress_kind: kind,
        progress_sequence: event.sequence,
        queued_events: this.queued,
        max_queued_events: MAX_QUEUED_PROGRESS_EVENTS
      }, "Progress event dropped because the reporting queue is full");
      return;
    }

    this.queued += 1;
    this.pending = this.pending.then(async () => {
      const startedAt = Date.now();
      try {
        if (this.signal?.aborted) return;
        await this.api.reportProgress(this.ticket, event, this.signal);
        this.metrics.increment("progress_sent");
        this.metrics.observeDuration("progress.report", Date.now() - startedAt);
        this.logger.debug({
          event: "progress.reported",
          progress_kind: kind,
          progress_sequence: event.sequence,
          duration_ms: Date.now() - startedAt
        }, "Worker progress reported");
      } catch (cause) {
        this.metrics.increment("progress_failed");
        this.logger.error({
          event: "progress.report_failed",
          progress_kind: kind,
          progress_sequence: event.sequence,
          duration_ms: Date.now() - startedAt,
          ...errorContext(cause)
        }, "Worker progress could not be reported");
      } finally {
        this.queued -= 1;
      }
    });
  }

  /** Gives final progress a short window, then frees result delivery from its backlog. */
  async flush(): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.pending,
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            this.logger.warn({
              event: "progress.final_flush_timed_out",
              queued_events: this.queued
            }, "Skipping remaining progress so the finished result can be delivered");
            this.controller.abort(new Error("Final progress delivery budget exceeded"));
            resolve();
          }, FINAL_PROGRESS_WAIT_MS);
        })
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }
}
