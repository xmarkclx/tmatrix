import type { WorkerConfig } from "../src/config.js";
import type { CancellationRequest, Ticket } from "../src/types.js";

export function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    runtime_adapter: "codex",
    poll_url: "https://tasks.example.test/api/poll",
    poll_origin: "https://tasks.example.test",
    api_key: "test-secret-key",
    instance_id: "test-instance",
    swarm_id: "test-swarm",
    max_workers: 3,
    poll_interval_ms: 5_000,
    idle_backoff_max_ms: 60_000,
    request_timeout_ms: 5_000,
    max_request_attempts: 3,
    control_ping_interval_ms: 25_000,
    control_reconnect_max_ms: 30_000,
    shutdown_grace_ms: 10,
    metrics_interval_ms: 60_000,
    log_level: "silent",
    pretty_logs: false,
    log_dir: "./logs",
    log_rotate_size: "50M",
    log_rotate_interval: "1d",
    log_max_files: 14,
    ...overrides
  };
}

export function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    ticket_id: "T-1001",
    worker_id: "w-1001",
    instructions: "Create HelloWorld.md with Hello World.",
    execution_mode: "NORMAL",
    model: "gpt-5.6-sol",
    reasoning_effort: "medium",
    service_tier: "default",
    endpoints: {
      mark_taken: "POST https://tasks.example.test/api/tickets/T-1001/taken",
      progress: "POST https://tasks.example.test/api/tickets/T-1001/progress",
      history: "GET https://tasks.example.test/api/tickets/T-1001/history",
      result: "POST https://tasks.example.test/api/tickets/T-1001/result"
    },
    ...overrides
  };
}

export function makeCancellation(
  overrides: Partial<CancellationRequest> = {}
): CancellationRequest {
  return {
    event_id: "cancel-1001",
    ticket_id: "T-1001",
    worker_id: "w-1001",
    requested_at: "2026-08-07T14:00:00.000Z",
    acknowledge:
      "POST https://tasks.example.test/api/v1/ai/tickets/T-1001/cancellation-ack",
    ...overrides
  };
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
