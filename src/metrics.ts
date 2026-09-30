import type { Logger } from "pino";

export type CounterName =
  | "poll_attempts"
  | "poll_succeeded"
  | "poll_failed"
  | "poll_authorization_rejected"
  | "poll_empty"
  | "http_retries"
  | "tickets_received"
  | "workers_started"
  | "workers_recovered"
  | "workers_completed"
  | "workers_failed"
  | "workers_cancelled"
  | "workers_cancellation_aborted"
  | "workers_ownership_revoked"
  | "recovery_payload_missing"
  | "steering_received"
  | "steering_queued"
  | "progress_sent"
  | "progress_failed"
  | "results_sent"
  | "results_failed"
  | "cancellations_received"
  | "cancellations_routed"
  | "cancellations_acknowledged"
  | "cancellation_ack_failed"
  | "control_connect_attempts"
  | "control_connect_failed"
  | "control_connected"
  | "control_disconnected"
  | "control_errors"
  | "control_messages_rejected"
  | "control_cancellations_received"
  | "control_url_rejected";

const COUNTERS: CounterName[] = [
  "poll_attempts",
  "poll_succeeded",
  "poll_failed",
  "poll_authorization_rejected",
  "poll_empty",
  "http_retries",
  "tickets_received",
  "workers_started",
  "workers_recovered",
  "workers_completed",
  "workers_failed",
  "workers_cancelled",
  "workers_cancellation_aborted",
  "workers_ownership_revoked",
  "recovery_payload_missing",
  "steering_received",
  "steering_queued",
  "progress_sent",
  "progress_failed",
  "results_sent",
  "results_failed",
  "cancellations_received",
  "cancellations_routed",
  "cancellations_acknowledged",
  "cancellation_ack_failed",
  "control_connect_attempts",
  "control_connect_failed",
  "control_connected",
  "control_disconnected",
  "control_errors",
  "control_messages_rejected",
  "control_cancellations_received",
  "control_url_rejected"
];

export class Metrics {
  private readonly startedAt = Date.now();
  private readonly counters = Object.fromEntries(COUNTERS.map((name) => [name, 0])) as Record<CounterName, number>;
  private readonly durationTotals: Record<string, number> = {};
  private readonly durationCounts: Record<string, number> = {};
  private readonly durationMax: Record<string, number> = {};
  private runningWorkers = 0;
  private lastPollSucceededAt?: string;
  private lastFailure?: { at: string; code: string; stage: string };

  increment(name: CounterName, amount = 1): void {
    this.counters[name] += amount;
  }

  setRunningWorkers(count: number): void {
    this.runningWorkers = count;
  }

  observeDuration(name: string, durationMs: number): void {
    this.durationTotals[name] = (this.durationTotals[name] ?? 0) + durationMs;
    this.durationCounts[name] = (this.durationCounts[name] ?? 0) + 1;
    this.durationMax[name] = Math.max(this.durationMax[name] ?? 0, durationMs);
  }

  recordPollSuccess(): void {
    this.lastPollSucceededAt = new Date().toISOString();
  }

  recordFailure(code: string, stage: string): void {
    this.lastFailure = { at: new Date().toISOString(), code, stage };
  }

  snapshot(): Record<string, unknown> {
    const durations = Object.fromEntries(Object.keys(this.durationCounts).map((name) => {
      const count = this.durationCounts[name] ?? 0;
      return [name, {
        count,
        average_ms: count === 0 ? 0 : Math.round((this.durationTotals[name] ?? 0) / count),
        max_ms: this.durationMax[name] ?? 0
      }];
    }));

    return {
      event: "metrics.snapshot",
      uptime_ms: Date.now() - this.startedAt,
      running_workers: this.runningWorkers,
      counters: { ...this.counters },
      durations,
      last_poll_succeeded_at: this.lastPollSucceededAt,
      last_failure: this.lastFailure
    };
  }

  log(logger: Logger, reason: "interval" | "signal" | "shutdown" | "startup"): void {
    logger.info({ ...this.snapshot(), reason }, "Worker metrics snapshot");
  }
}
