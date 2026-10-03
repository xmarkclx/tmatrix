import { describe, expect, it, vi } from "vitest";
import { WorkerError } from "../src/errors.js";
import { nullLogger } from "../src/logger.js";
import { Metrics } from "../src/metrics.js";
import type { RunOutcome, TicketRunner } from "../src/runner.js";
import { Supervisor } from "../src/supervisor.js";
import type { PollRequest, PollResponse, Ticket } from "../src/types.js";
import { deferred, makeCancellation, makeConfig, makeTicket } from "./helpers.js";

describe("automatic authorization recovery", () => {
  it.each([401, 403] as const)("recovers owned work after repeated %s rejections and resumes intake", async (status) => {
    const ticket = makeTicket();
    const next = makeTicket({ ticket_id: "T-next", worker_id: "w-next" });
    const url = "wss://tasks.example.test/api/v1/ai/events?instance_id=test-instance&swarm_id=test-swarm";
    const poller = pollSequence([
      response({ control_url: url }), response({ new_tickets: [ticket], control_url: url }),
      authError(status), authError(status),
      response({ owned_in_progress: [ticket], control_url: url }),
      response({ owned_in_progress: [ticket], new_tickets: [next], control_url: url }),
      response({ owned_in_progress: [ticket, next], control_url: url })
    ]);
    const run = vi.fn((_ticket: Ticket, { signal }: { signal: AbortSignal }) =>
      new Promise<RunOutcome>(resolve => {
        signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
      }));
    const control = { updateUrl: vi.fn(), suspend: vi.fn(), close: vi.fn(async () => undefined) };
    const metrics = new Metrics();
    const supervisor = new Supervisor({
      config: makeConfig({ shutdown_grace_ms: 0 }), poller,
      runner: { run } as unknown as TicketRunner, control, logger: nullLogger(), metrics
    });
    try {
      await supervisor.runOnce();
      const priorPoll = poller.poll.mock.calls[1]![0];
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(supervisor.runOnce()).rejects.toMatchObject({ details: { status } });
        await supervisor.drain();
      }
      expect(run).toHaveBeenCalledOnce();
      expect(control.suspend).toHaveBeenCalledOnce();
      expect(control.close).not.toHaveBeenCalled();
      expect(poller.poll.mock.calls[3]![0].available_slots).toBe(0);

      const recovered = await supervisor.runOnce();
      expect(recovered.recoveredWorkers).toBe(1);
      expect(run.mock.calls[1]![1].signal.aborted).toBe(false);
      expect(poller.poll.mock.calls[4]![0].available_slots).toBe(0);
      expect(poller.poll.mock.calls[4]![0].poll_id).not.toBe(priorPoll.poll_id);
      expect(control.updateUrl).toHaveBeenCalledTimes(3);
      expect(supervisor.localSnapshot().poller.error).toBeUndefined();
      expect((await supervisor.runOnce()).newWorkers).toBe(1);
      expect(poller.poll.mock.calls[5]![0].available_slots).toBe(2);
      await supervisor.runOnce();
      expect(run).toHaveBeenCalledTimes(3);
      expect(metrics.snapshot().counters).toMatchObject({
        poll_authorization_rejected: 1, poll_authorization_restored: 1
      });
    } finally {
      await supervisor.shutdown();
    }
  });

  it("waits for the aborted run to finish before recovering its claim", async () => {
    const ticket = makeTicket();
    const pending = deferred<RunOutcome>();
    const run = vi.fn(() => pending.promise);
    const poller = pollSequence([
      response(), response({ new_tickets: [ticket] }), authError(403),
      response({ owned_in_progress: [ticket] }), response({ owned_in_progress: [ticket] })
    ]);
    const supervisor = new Supervisor({
      config: makeConfig(), poller, runner: { run } as unknown as TicketRunner,
      logger: nullLogger(), metrics: new Metrics()
    });
    try {
      await supervisor.runOnce();
      await expect(supervisor.runOnce()).rejects.toThrow();
      expect((await supervisor.runOnce()).recoveredWorkers).toBe(0);
      expect(run).toHaveBeenCalledOnce();
      pending.resolve({ status: "cancelled" });
      await supervisor.drain();
      expect((await supervisor.runOnce()).recoveredWorkers).toBe(1);
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      pending.resolve({ status: "cancelled" });
      await supervisor.shutdown();
    }
  });

  it("keeps execution suspended through other poll failures until a successful response", async () => {
    const ticket = makeTicket();
    const run = vi.fn(async () => ({ status: "completed" as const }));
    const metrics = new Metrics();
    const poller = pollSequence([
      authError(401), new Error("Connection unavailable"),
      new WorkerError({ message: "Invalid poll payload", code: "POLL_RESPONSE_INVALID", stage: "poll.parse" }),
      response({ owned_in_progress: [ticket] }), response()
    ]);
    const supervisor = new Supervisor({
      config: makeConfig(), poller, runner: { run } as unknown as TicketRunner,
      logger: nullLogger(), metrics
    });
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(supervisor.runOnce()).rejects.toThrow();
        expect(run).not.toHaveBeenCalled();
        expect(metrics.snapshot().counters).toMatchObject({ poll_authorization_restored: 0 });
      }
      expect((await supervisor.runOnce()).recoveredWorkers).toBe(1);
      expect(run).toHaveBeenCalledOnce();
      expect(metrics.snapshot().counters).toMatchObject({ poll_authorization_restored: 1 });
    } finally {
      await supervisor.shutdown();
    }
  });

  it("retries cancellation with restored authorization without reviving a cancelled claim", async () => {
    const ticket = makeTicket();
    const cancellation = makeCancellation();
    const pending = deferred<RunOutcome>();
    const run = vi.fn(() => pending.promise);
    const poller = pollSequence([
      response(), response({ new_tickets: [ticket] }), authError(401),
      response({ owned_in_progress: [ticket], cancellation_requests: [cancellation] }),
      response({ owned_in_progress: [ticket], cancellation_requests: [cancellation] })
    ]);
    const acknowledgeCancellation = vi.fn(async (_request: unknown, _signal?: AbortSignal) => undefined);
    const supervisor = new Supervisor({
      config: makeConfig(), poller, runner: { run } as unknown as TicketRunner,
      cancellationApi: { acknowledgeCancellation }, logger: nullLogger(), metrics: new Metrics()
    });
    try {
      await supervisor.runOnce();
      supervisor.handleCancellation(cancellation, "push");
      await expect(supervisor.runOnce()).rejects.toThrow();
      await supervisor.runOnce();
      pending.resolve({ status: "cancelled" });
      await supervisor.drain();
      await new Promise<void>(resolve => setImmediate(resolve));
      // The cancellation begun before revocation cannot use the new ACK signal.
      expect(acknowledgeCancellation).not.toHaveBeenCalled();
      await supervisor.runOnce();
      await supervisor.shutdown();
      expect(acknowledgeCancellation).toHaveBeenCalledOnce();
      expect(acknowledgeCancellation.mock.calls[0]![1]?.aborted).toBe(false);
      expect(run).toHaveBeenCalledOnce();
    } finally {
      pending.resolve({ status: "cancelled" });
      await supervisor.shutdown();
    }
  });

  it("honors paused intake and local stops when authorization is restored", async () => {
    const ticket = makeTicket();
    const run = vi.fn(async () => ({ status: "cancelled" as const }));
    const poller = pollSequence([
      response(), response({ new_tickets: [ticket] }), authError(403),
      response({ owned_in_progress: [ticket] })
    ]);
    const supervisor = new Supervisor({
      config: makeConfig(), poller, runner: { run } as unknown as TicketRunner,
      logger: nullLogger(), metrics: new Metrics()
    });
    try {
      await supervisor.runOnce();
      supervisor.stopLocalWorker(ticket.worker_id);
      await supervisor.drain();
      await expect(supervisor.runOnce()).rejects.toThrow();
      supervisor.updateLocalSettings({ intake_paused: true });
      await supervisor.runOnce();
      expect(poller.poll).toHaveBeenCalledTimes(3);
      supervisor.updateLocalSettings({ intake_paused: false });
      expect((await supervisor.runOnce()).recoveredWorkers).toBe(0);
      expect(supervisor.localSnapshot().poller.status).toBe("connected");
      expect(run).toHaveBeenCalledOnce();
    } finally {
      await supervisor.shutdown();
    }
  });
});

function response(overrides: Partial<PollResponse> = {}): PollResponse {
  return { new_tickets: [], owned_in_progress: [], steering_events: [], cancellation_requests: [], ...overrides };
}

function pollSequence(results: Array<PollResponse | Error>) {
  return {
    poll: vi.fn(async (_request: PollRequest): Promise<PollResponse> => {
      const result = results.shift();
      if (result instanceof Error) throw result;
      if (!result) throw new Error("Unexpected poll");
      return result;
    })
  };
}

function authError(status: 401 | 403): WorkerError {
  return new WorkerError({
    message: "Poll authorization rejected", code: "HTTP_STATUS_ERROR", stage: "http.poll",
    details: { status }
  });
}
