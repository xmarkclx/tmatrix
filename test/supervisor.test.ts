import { describe, expect, it, vi } from "vitest";
import { RunCancellationError, WorkerError } from "../src/errors.js";
import { nullLogger } from "../src/logger.js";
import { Metrics } from "../src/metrics.js";
import type { RunOutcome, SteeringMailbox, TicketRunner } from "../src/runner.js";
import { Supervisor } from "../src/supervisor.js";
import type { PollRequest, PollResponse, Ticket } from "../src/types.js";
import {
  deferred,
  makeCancellation,
  makeConfig,
  makeTicket
} from "./helpers.js";

describe("Supervisor", () => {
  it.each([{}, { max_tickets_per_poll: 100 }])(
    "fills 50 workers across valid polls with batch settings %j", async (batchSettings) => {
      const pending = deferred<RunOutcome>();
      const run = vi.fn(() => pending.promise);
      const owned: Ticket[] = [];
      const poller = {
        poll: vi.fn(async (request: PollRequest): Promise<PollResponse> => {
          if (request.available_slots > 32) throw new Error("HTTP 400: available_slots exceeds 32");
          const priorOwned = [...owned];
          const tickets = Array.from({ length: request.available_slots }, (_, index) =>
            makeTicket({ ticket_id: `T-${owned.length + index}`, worker_id: `w-${owned.length + index}` })
          );
          owned.push(...tickets);
          return { new_tickets: tickets, owned_in_progress: priorOwned, steering_events: [], cancellation_requests: [] };
        })
      };
      const supervisor = new Supervisor({
        config: makeConfig({ max_workers: 50, ...batchSettings }), poller,
        runner: { run } as unknown as TicketRunner, logger: nullLogger(), metrics: new Metrics()
      });
      try {
        await supervisor.runOnce();
        expect(supervisor.runningCount).toBe(32);
        await supervisor.runOnce();
        expect(supervisor.runningCount).toBe(50);
        await supervisor.runOnce();
        expect(run).toHaveBeenCalledTimes(50);
        expect(poller.poll.mock.calls.map(([request]) => request.available_slots)).toEqual([0, 32, 18, 0]);
      } finally {
        pending.resolve({ status: "completed" });
        await supervisor.drain();
      }
    }
  );

  it("reuses a timed-out poll across cycles so committed claims are not multiplied", async () => {
    const poller = {
      poll: vi.fn(async (_request: PollRequest): Promise<PollResponse> => {
        if (poller.poll.mock.calls.length === 1) throw new Error("Response lost after commit");
        return { new_tickets: [], owned_in_progress: [], steering_events: [], cancellation_requests: [] };
      })
    };
    const supervisor = new Supervisor({
      config: makeConfig(), poller,
      runner: { run: vi.fn() } as unknown as TicketRunner,
      logger: nullLogger(), metrics: new Metrics()
    });
    await expect(supervisor.runOnce()).rejects.toThrow("Response lost after commit");
    expect(supervisor.localSnapshot().poller.error).toBe("Poll failed: Response lost after commit");
    await supervisor.runOnce();
    expect(supervisor.localSnapshot().poller.error).toBeUndefined();
    const requests = poller.poll.mock.calls.map(([request]) => request);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[2]?.poll_id).not.toBe(requests[0]?.poll_id);
    expect(requests[2]?.available_slots).toBe(3);
  });

  it("recovers the ticket from a lost intake response before making a new reservation", async () => {
    const pending = deferred<RunOutcome>();
    const run = vi.fn(() => pending.promise);
    const ticket = makeTicket();
    const poller = {
      poll: vi.fn(async (_request: PollRequest): Promise<PollResponse> => {
        const call = poller.poll.mock.calls.length;
        if (call === 2) throw new Error("Response lost after reservation");
        return {
          new_tickets: call === 3 ? [ticket] : [],
          owned_in_progress: call > 3 ? [ticket] : [],
          steering_events: [], cancellation_requests: []
        };
      })
    };
    const supervisor = new Supervisor({
      config: makeConfig(), poller, runner: { run } as unknown as TicketRunner,
      logger: nullLogger(), metrics: new Metrics()
    });
    try {
      await expect(supervisor.runOnce()).rejects.toThrow("Response lost after reservation");
      await supervisor.runOnce();
      expect(poller.poll.mock.calls[2]?.[0]).toEqual(poller.poll.mock.calls[1]?.[0]);
      expect(poller.poll.mock.calls[2]?.[0].available_slots).toBe(3);
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      pending.resolve({ status: "completed" });
      await supervisor.drain();
    }
  });

  it("claims one ticket per poll while running multiple tickets concurrently", async () => {
    const pending = deferred<RunOutcome>();
    const run = vi.fn(() => pending.promise);
    const owned: Ticket[] = [];
    const poller = {
      poll: vi.fn(async (request: PollRequest): Promise<PollResponse> => {
        const priorOwned = [...owned];
        const next = request.available_slots > 0
          ? makeTicket({ ticket_id: `T-${owned.length}`, worker_id: `w-${owned.length}` })
          : undefined;
        if (next) owned.push(next);
        return {
          new_tickets: next ? [next] : [],
          owned_in_progress: priorOwned,
          steering_events: [],
          cancellation_requests: []
        };
      })
    };
    const supervisor = new Supervisor({
      config: makeConfig({ max_workers: 3, max_tickets_per_poll: 1 }),
      poller,
      runner: { run } as unknown as TicketRunner,
      logger: nullLogger(),
      metrics: new Metrics()
    });

    try {
      await supervisor.runOnce();
      expect(supervisor.runningCount).toBe(1);
      await supervisor.runOnce();
      expect(supervisor.runningCount).toBe(2);
      await supervisor.runOnce();
      expect(supervisor.runningCount).toBe(3);
      await supervisor.runOnce();
      expect(run).toHaveBeenCalledTimes(3);
      expect(poller.poll.mock.calls.map(([request]) => request.available_slots))
        .toEqual([0, 1, 1, 1, 0]);
    } finally {
      pending.resolve({ status: "completed" });
      await supervisor.drain();
    }
  });

  it("drains active workers without aborting them when shutdown is unlimited", async () => {
    const pending = deferred<RunOutcome>();
    let workerSignal: AbortSignal | undefined;
    const run = vi.fn((_ticket: Ticket, options: { signal: AbortSignal }) => {
      workerSignal = options.signal;
      return pending.promise;
    });
    const poller = {
      poll: vi.fn(async (_request: PollRequest): Promise<PollResponse> =>
        poller.poll.mock.calls.length === 2
          ? {
              new_tickets: [makeTicket()],
              owned_in_progress: [],
              steering_events: [],
              cancellation_requests: []
            }
          : { new_tickets: [], owned_in_progress: [], steering_events: [], cancellation_requests: [] })
    };
    const control = {
      updateUrl: vi.fn(),
      close: vi.fn(async () => undefined)
    };
    const supervisor = new Supervisor({
      config: makeConfig({ shutdown_grace_ms: -1 }),
      poller,
      runner: { run } as unknown as TicketRunner,
      control,
      logger: nullLogger(),
      metrics: new Metrics()
    });

    await supervisor.runOnce();
    const shutdown = supervisor.shutdown();
    let shutdownCompleted = false;
    void shutdown.then(() => {
      shutdownCompleted = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(shutdownCompleted).toBe(false);
    expect(workerSignal?.aborted).toBe(false);
    expect(control.close).not.toHaveBeenCalled();

    pending.resolve({ status: "completed" });
    await shutdown;

    expect(shutdownCompleted).toBe(true);
    expect(control.close).toHaveBeenCalledOnce();
    expect(supervisor.runningCount).toBe(0);
  });

  it("does not start tickets returned by a poll after shutdown begins", async () => {
    const pendingPoll = deferred<PollResponse>();
    const run = vi.fn();
    const poller = {
      poll: vi.fn(async () => pendingPoll.promise)
    };
    const supervisor = new Supervisor({
      config: makeConfig({ shutdown_grace_ms: -1 }),
      poller,
      runner: { run } as unknown as TicketRunner,
      logger: nullLogger(),
      metrics: new Metrics()
    });

    const poll = supervisor.runOnce();
    await vi.waitFor(() => expect(poller.poll).toHaveBeenCalledOnce());
    await supervisor.shutdown();
    pendingPoll.resolve({
      new_tickets: [makeTicket()],
      owned_in_progress: [],
      steering_events: [],
      cancellation_requests: []
    });
    await poll;

    expect(run).not.toHaveBeenCalled();
    expect(supervisor.runningCount).toBe(0);
  });

  it("allows a fatal caller to cancel despite an unlimited service setting", async () => {
    let workerSignal: AbortSignal | undefined;
    const run = vi.fn((_ticket: Ticket, options: { signal: AbortSignal }) => {
      workerSignal = options.signal;
      return new Promise<RunOutcome>((resolve) => {
        options.signal.addEventListener("abort", () => resolve({ status: "failed" }), { once: true });
      });
    });
    const poller = {
      poll: vi.fn(async (_request: PollRequest): Promise<PollResponse> =>
        poller.poll.mock.calls.length === 2
          ? {
              new_tickets: [makeTicket()],
              owned_in_progress: [],
              steering_events: [],
              cancellation_requests: []
            }
          : { new_tickets: [], owned_in_progress: [], steering_events: [], cancellation_requests: [] })
    };
    const supervisor = new Supervisor({
      config: makeConfig({ shutdown_grace_ms: -1 }),
      poller,
      runner: { run } as unknown as TicketRunner,
      logger: nullLogger(),
      metrics: new Metrics()
    });

    await supervisor.runOnce();
    await supervisor.shutdown(0);

    expect(workerSignal?.aborted).toBe(true);
    expect(supervisor.runningCount).toBe(0);
  });

  it("retains bounded cancellation for a positive shutdown grace", async () => {
    let workerSignal: AbortSignal | undefined;
    const run = vi.fn((_ticket: Ticket, options: { signal: AbortSignal }) => {
      workerSignal = options.signal;
      return new Promise<RunOutcome>((resolve) => {
        options.signal.addEventListener("abort", () => resolve({ status: "failed" }), { once: true });
      });
    });
    const poller = {
      poll: vi.fn(async (_request: PollRequest): Promise<PollResponse> =>
        poller.poll.mock.calls.length === 2
          ? {
              new_tickets: [makeTicket()],
              owned_in_progress: [],
              steering_events: [],
              cancellation_requests: []
            }
          : { new_tickets: [], owned_in_progress: [], steering_events: [], cancellation_requests: [] })
    };
    const supervisor = new Supervisor({
      config: makeConfig({ shutdown_grace_ms: 1 }),
      poller,
      runner: { run } as unknown as TicketRunner,
      logger: nullLogger(),
      metrics: new Metrics()
    });

    await supervisor.runOnce();
    await supervisor.shutdown();

    expect(workerSignal?.aborted).toBe(true);
    expect(supervisor.runningCount).toBe(0);
  });

  it("never starts more workers than the local concurrency cap", async () => {
    const runs = [deferred<RunOutcome>(), deferred<RunOutcome>()];
    const run = vi.fn()
      .mockReturnValueOnce(runs[0]!.promise)
      .mockReturnValueOnce(runs[1]!.promise);
    const poller = {
      poll: vi.fn(async (_request: PollRequest): Promise<PollResponse> =>
        poller.poll.mock.calls.length === 2
        ? {
            new_tickets: [
              makeTicket({ ticket_id: "work-1", worker_id: "w-1", task_id: 42 }),
              makeTicket({ ticket_id: "work-2", worker_id: "w-2", task_id: 42 }),
              makeTicket({ ticket_id: "work-3", worker_id: "w-3", task_id: 43 })
            ],
            owned_in_progress: [],
            steering_events: [],
            cancellation_requests: []
          }
        : { new_tickets: [], owned_in_progress: [], steering_events: [], cancellation_requests: [] })
    };
    const supervisor = new Supervisor({
      config: makeConfig({ max_workers: 2 }),
      poller,
      runner: { run } as unknown as TicketRunner,
      logger: nullLogger(),
      metrics: new Metrics()
    });

    const result = await supervisor.runOnce();

    expect(result.newWorkers).toBe(2);
    expect(result.runningWorkers).toBe(2);
    expect(run).toHaveBeenCalledTimes(2);
    expect(poller.poll.mock.calls[0]![0]).toMatchObject({ available_slots: 0 });
    expect(poller.poll.mock.calls[1]![0]).toMatchObject({ available_slots: 2 });
    const fullCapacityPoll = await supervisor.runOnce();
    expect(fullCapacityPoll).toEqual({
      newWorkers: 0,
      recoveredWorkers: 0,
      steeringEvents: 0,
      cancellationRequests: 0,
      runningWorkers: 2
    });
    expect(poller.poll).toHaveBeenCalledTimes(3);
    expect(poller.poll.mock.calls[2]![0]).toMatchObject({ available_slots: 0 });
    expect(poller.poll.mock.calls[0]![0].poll_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    runs[0]!.resolve({ status: "completed" });
    runs[1]!.resolve({ status: "completed" });
    await supervisor.drain();
  });

  it("recovers full owned tickets and diagnoses bare recovery references", async () => {
    const pending = deferred<RunOutcome>();
    const run = vi.fn((_ticket: Ticket, _options: { recovered: boolean }) => pending.promise);
    const recoverable = makeTicket({ ticket_id: "T-recover", worker_id: "w-dead" });
    const poller = {
      poll: vi.fn(async (_request: PollRequest): Promise<PollResponse> => ({
        new_tickets: [],
        owned_in_progress: [
          recoverable,
          { ticket_id: "T-bare", worker_id: "w-bare" }
        ],
        steering_events: [],
        cancellation_requests: []
      }))
    };
    const metrics = new Metrics();
    const supervisor = new Supervisor({
      config: makeConfig(),
      poller,
      runner: { run } as unknown as TicketRunner,
      logger: nullLogger(),
      metrics
    });

    const first = await supervisor.runOnce();
    const second = await supervisor.runOnce();

    expect(first.recoveredWorkers).toBe(1);
    expect(second.recoveredWorkers).toBe(0);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]![1]).toMatchObject({ recovered: true });
    expect((metrics.snapshot().counters as Record<string, number>).recovery_payload_missing).toBe(1);
    pending.resolve({ status: "completed" });
    await supervisor.drain();
  });

  it("reconciles restart ownership before intake and recovers overflow claims on the next poll", async () => {
    const runs = [deferred<RunOutcome>(), deferred<RunOutcome>(), deferred<RunOutcome>()];
    const run = vi.fn()
      .mockReturnValueOnce(runs[0]!.promise)
      .mockReturnValueOnce(runs[1]!.promise)
      .mockReturnValueOnce(runs[2]!.promise);
    const oldOwned = makeTicket({ ticket_id: "old-owned", worker_id: "w-old" });
    const zeroSlotClaim = makeTicket({ ticket_id: "zero-slot-claim", worker_id: "w-zero" });
    const overflowClaim = makeTicket({ ticket_id: "overflow-claim", worker_id: "w-overflow" });
    const laterClaim = makeTicket({ ticket_id: "later-claim", worker_id: "w-later" });
    const poller = {
      poll: vi.fn(async (_request: PollRequest): Promise<PollResponse> => {
        const call = poller.poll.mock.calls.length;
        if (call === 1) {
          return {
            new_tickets: [zeroSlotClaim],
            owned_in_progress: [oldOwned],
            steering_events: [],
            cancellation_requests: []
          };
        }
        if (call === 2) {
          return {
            new_tickets: [overflowClaim],
            owned_in_progress: [oldOwned, zeroSlotClaim],
            steering_events: [],
            cancellation_requests: []
          };
        }
        return {
          new_tickets: [laterClaim],
          owned_in_progress: [zeroSlotClaim, overflowClaim],
          steering_events: [],
          cancellation_requests: []
        };
      })
    };
    const supervisor = new Supervisor({
      config: makeConfig({ max_workers: 2 }),
      poller,
      runner: { run } as unknown as TicketRunner,
      logger: nullLogger(),
      metrics: new Metrics()
    });

    const startup = await supervisor.runOnce();

    expect(poller.poll.mock.calls.map((call) => call[0].available_slots)).toEqual([0, 1]);
    expect(startup).toMatchObject({
      newWorkers: 0,
      recoveredWorkers: 2,
      runningWorkers: 2
    });
    expect(run.mock.calls.map((call) => call[0].ticket_id)).toEqual([
      "old-owned",
      "zero-slot-claim"
    ]);
    expect(run.mock.calls.every((call) => call[1].recovered)).toBe(true);

    runs[0]!.resolve({ status: "completed" });
    await vi.waitFor(() => expect(supervisor.runningCount).toBe(1));

    const next = await supervisor.runOnce();

    expect(poller.poll.mock.calls[2]![0]).toMatchObject({ available_slots: 1 });
    expect(next).toMatchObject({
      newWorkers: 0,
      recoveredWorkers: 1,
      runningWorkers: 2
    });
    expect(run.mock.calls.map((call) => call[0].ticket_id)).toEqual([
      "old-owned",
      "zero-slot-claim",
      "overflow-claim"
    ]);

    runs[1]!.resolve({ status: "completed" });
    runs[2]!.resolve({ status: "completed" });
    await supervisor.drain();
  });

  it("polls at zero slots and routes steering to the targeted active worker", async () => {
    const pending = deferred<RunOutcome>();
    let steering: SteeringMailbox | undefined;
    const run = vi.fn((
      _ticket: Ticket,
      options: { steering?: SteeringMailbox }
    ) => {
      steering = options.steering;
      return pending.promise;
    });
    const poller = {
      poll: vi.fn(async (_request: PollRequest): Promise<PollResponse> => {
        const call = poller.poll.mock.calls.length;
        if (call === 1) {
          return { new_tickets: [], owned_in_progress: [], steering_events: [], cancellation_requests: [] };
        }
        if (call === 2) {
          return {
            new_tickets: [makeTicket({ input_revision: 1 })],
            owned_in_progress: [],
            steering_events: [],
            cancellation_requests: []
          };
        }
        return {
            new_tickets: [],
            owned_in_progress: [makeTicket({ input_revision: 1 })],
            steering_events: [{
              worker_id: "w-1001",
              input_revision: 2,
              content: "Use the edited reply."
            }],
            cancellation_requests: []
          };
      })
    };
    const supervisor = new Supervisor({
      config: makeConfig({ max_workers: 1 }),
      poller,
      runner: { run } as unknown as TicketRunner,
      logger: nullLogger(),
      metrics: new Metrics()
    });

    await supervisor.runOnce();
    const second = await supervisor.runOnce();

    expect(poller.poll).toHaveBeenCalledTimes(3);
    expect(poller.poll.mock.calls[0]![0]).toMatchObject({ available_slots: 0 });
    expect(poller.poll.mock.calls[1]![0]).toMatchObject({ available_slots: 1 });
    expect(poller.poll.mock.calls[2]![0]).toMatchObject({ available_slots: 0 });
    expect(second.steeringEvents).toBe(1);
    expect(steering?.takeLatestAfter(1)).toMatchObject({
      worker_id: "w-1001",
      input_revision: 2,
      content: "Use the edited reply."
    });

    pending.resolve({ status: "completed" });
    await supervisor.drain();
  });

  it("suppresses a same-poll cancelled claim and acknowledges it once", async () => {
    const cancellation = makeCancellation();
    const poller = {
      poll: vi.fn(async (_request: PollRequest): Promise<PollResponse> =>
        poller.poll.mock.calls.length === 1
          ? {
              new_tickets: [],
              owned_in_progress: [],
              steering_events: [],
              cancellation_requests: []
            }
          : {
              new_tickets: [makeTicket()],
              owned_in_progress: [],
              steering_events: [],
              cancellation_requests: [cancellation]
            })
    };
    const run = vi.fn();
    const acknowledgeCancellation = vi.fn(async () => undefined);
    const supervisor = new Supervisor({
      config: makeConfig(),
      poller,
      runner: { run } as unknown as TicketRunner,
      cancellationApi: { acknowledgeCancellation },
      logger: nullLogger(),
      metrics: new Metrics()
    });

    const result = await supervisor.runOnce();
    await vi.waitFor(() => expect(acknowledgeCancellation).toHaveBeenCalledOnce());

    expect(result).toMatchObject({
      newWorkers: 0,
      cancellationRequests: 1,
      runningWorkers: 0
    });
    expect(run).not.toHaveBeenCalled();
    expect(acknowledgeCancellation).toHaveBeenCalledWith(
      cancellation,
      expect.any(AbortSignal)
    );
    expect(supervisor.handleCancellation(cancellation, "push")).toBe(false);
    expect(acknowledgeCancellation).toHaveBeenCalledOnce();
    await supervisor.shutdown();
  });

  it("deduplicates push and poll cancellation and ACKs only after teardown", async () => {
    const pending = deferred<RunOutcome>();
    let workerSignal: AbortSignal | undefined;
    const run = vi.fn((_ticket: Ticket, options: { signal: AbortSignal }) => {
      workerSignal = options.signal;
      return pending.promise;
    });
    const poller = {
      poll: vi.fn(async (_request: PollRequest): Promise<PollResponse> =>
        poller.poll.mock.calls.length === 1
          ? {
              new_tickets: [],
              owned_in_progress: [],
              steering_events: [],
              cancellation_requests: []
            }
          : {
              new_tickets: [makeTicket()],
              owned_in_progress: [],
              steering_events: [],
              cancellation_requests: []
            })
    };
    const acknowledgeCancellation = vi.fn(async () => undefined);
    const supervisor = new Supervisor({
      config: makeConfig(),
      poller,
      runner: { run } as unknown as TicketRunner,
      cancellationApi: { acknowledgeCancellation },
      logger: nullLogger(),
      metrics: new Metrics()
    });
    await supervisor.runOnce();
    const cancellation = makeCancellation();

    expect(supervisor.handleCancellation(cancellation, "push")).toBe(true);
    expect(supervisor.handleCancellation(cancellation, "poll")).toBe(false);
    expect(workerSignal?.aborted).toBe(true);
    expect(workerSignal?.reason).toMatchObject({
      kind: "user",
      eventId: cancellation.event_id,
      ticketId: cancellation.ticket_id,
      workerId: cancellation.worker_id
    });
    expect(acknowledgeCancellation).not.toHaveBeenCalled();

    pending.resolve({ status: "cancelled" });
    await vi.waitFor(() => expect(acknowledgeCancellation).toHaveBeenCalledOnce());
    expect(acknowledgeCancellation).toHaveBeenCalledWith(
      cancellation,
      expect.any(AbortSignal)
    );
    await supervisor.shutdown();
  });

  it("rejects a cancellation that does not match the active ticket", async () => {
    const pending = deferred<RunOutcome>();
    let workerSignal: AbortSignal | undefined;
    const run = vi.fn((_ticket: Ticket, options: { signal: AbortSignal }) => {
      workerSignal = options.signal;
      return pending.promise;
    });
    const poller = {
      poll: vi.fn(async (_request: PollRequest): Promise<PollResponse> =>
        poller.poll.mock.calls.length === 1
          ? {
              new_tickets: [],
              owned_in_progress: [],
              steering_events: [],
              cancellation_requests: []
            }
          : {
              new_tickets: [makeTicket()],
              owned_in_progress: [],
              steering_events: [],
              cancellation_requests: []
            })
    };
    const acknowledgeCancellation = vi.fn(async () => undefined);
    const supervisor = new Supervisor({
      config: makeConfig(),
      poller,
      runner: { run } as unknown as TicketRunner,
      cancellationApi: { acknowledgeCancellation },
      logger: nullLogger(),
      metrics: new Metrics()
    });
    await supervisor.runOnce();

    expect(supervisor.handleCancellation(makeCancellation({
      event_id: "cancel-wrong-ticket",
      ticket_id: "T-wrong"
    }))).toBe(false);
    expect(workerSignal?.aborted).toBe(false);
    expect(acknowledgeCancellation).not.toHaveBeenCalled();

    pending.resolve({ status: "completed" });
    await supervisor.drain();
    await supervisor.shutdown();
  });

  it("aborts work omitted from authoritative ownership without cancellation ACK", async () => {
    let cancellationReason: unknown;
    const run = vi.fn((_ticket: Ticket, options: { signal: AbortSignal }) =>
      new Promise<RunOutcome>((resolve) => {
        options.signal.addEventListener("abort", () => {
          cancellationReason = options.signal.reason;
          resolve({ status: "cancelled" });
        }, { once: true });
      }));
    const poller = {
      poll: vi.fn(async (_request: PollRequest): Promise<PollResponse> => {
        const call = poller.poll.mock.calls.length;
        if (call === 1) {
          return {
            new_tickets: [],
            owned_in_progress: [],
            steering_events: [],
            cancellation_requests: []
          };
        }
        if (call === 2) {
          return {
            new_tickets: [makeTicket()],
            owned_in_progress: [],
            steering_events: [],
            cancellation_requests: []
          };
        }
        return {
          new_tickets: [],
          owned_in_progress: [],
          steering_events: [],
          cancellation_requests: []
        };
      })
    };
    const acknowledgeCancellation = vi.fn(async () => undefined);
    const supervisor = new Supervisor({
      config: makeConfig(),
      poller,
      runner: { run } as unknown as TicketRunner,
      cancellationApi: { acknowledgeCancellation },
      logger: nullLogger(),
      metrics: new Metrics()
    });
    await supervisor.runOnce();

    await supervisor.runOnce();
    await supervisor.drain();

    expect(cancellationReason).toBeInstanceOf(RunCancellationError);
    expect(cancellationReason).toMatchObject({
      kind: "ownership_revoked",
      ticketId: "T-1001",
      workerId: "w-1001"
    });
    expect(acknowledgeCancellation).not.toHaveBeenCalled();
    await supervisor.shutdown();
  });

  it.each([401, 403] as const)(
    "immediately revokes active ownership after a %s poll rejection",
    async (status) => {
      let cancellationReason: unknown;
      const run = vi.fn((_ticket: Ticket, options: { signal: AbortSignal }) =>
        new Promise<RunOutcome>((resolve) => {
          options.signal.addEventListener("abort", () => {
            cancellationReason = options.signal.reason;
            resolve({ status: "cancelled" });
          }, { once: true });
        }));
      const poller = {
        poll: vi.fn(async (_request: PollRequest): Promise<PollResponse> => {
          const call = poller.poll.mock.calls.length;
          if (call === 1) {
            return {
              new_tickets: [],
              owned_in_progress: [],
              steering_events: [],
              cancellation_requests: []
            };
          }
          if (call === 2) {
            return {
              new_tickets: [makeTicket()],
              owned_in_progress: [],
              steering_events: [],
              cancellation_requests: []
            };
          }
          if (call === 3) throw pollAuthError(status);
          return {
            new_tickets: [makeTicket({
              ticket_id: "T-after-revoke",
              worker_id: "w-after-revoke"
            })],
            owned_in_progress: [],
            steering_events: [],
            cancellation_requests: []
          };
        })
      };
      const metrics = new Metrics();
      const acknowledgeCancellation = vi.fn(async () => undefined);
      const supervisor = new Supervisor({
        config: makeConfig(),
        poller,
        runner: { run } as unknown as TicketRunner,
        cancellationApi: { acknowledgeCancellation },
        logger: nullLogger(),
        metrics
      });
      await supervisor.runOnce();

      await expect(supervisor.runOnce()).rejects.toMatchObject({
        code: "HTTP_STATUS_ERROR",
        details: { status }
      });
      await supervisor.drain();

      expect(cancellationReason).toBeInstanceOf(RunCancellationError);
      expect(cancellationReason).toMatchObject({
        kind: "ownership_revoked",
        ticketId: "T-1001",
        workerId: "w-1001"
      });
      expect(acknowledgeCancellation).not.toHaveBeenCalled();
      expect(
        (metrics.snapshot().counters as Record<string, number>)
          .poll_authorization_rejected
      ).toBe(1);

      const afterRevocation = await supervisor.runOnce();
      expect(afterRevocation.newWorkers).toBe(0);
      expect(run).toHaveBeenCalledOnce();
      await supervisor.shutdown();
    }
  );

  it("does not ACK a pending user cancellation after poll authorization is revoked", async () => {
    const pending = deferred<RunOutcome>();
    const run = vi.fn(() => pending.promise);
    const poller = {
      poll: vi.fn(async (_request: PollRequest): Promise<PollResponse> => {
        const call = poller.poll.mock.calls.length;
        if (call === 1) {
          return {
            new_tickets: [],
            owned_in_progress: [],
            steering_events: [],
            cancellation_requests: []
          };
        }
        if (call === 2) {
          return {
            new_tickets: [makeTicket()],
            owned_in_progress: [],
            steering_events: [],
            cancellation_requests: []
          };
        }
        throw pollAuthError(401);
      })
    };
    const acknowledgeCancellation = vi.fn(async () => undefined);
    const control = {
      updateUrl: vi.fn(),
      close: vi.fn(async () => undefined)
    };
    const supervisor = new Supervisor({
      config: makeConfig(),
      poller,
      runner: { run } as unknown as TicketRunner,
      cancellationApi: { acknowledgeCancellation },
      control,
      logger: nullLogger(),
      metrics: new Metrics()
    });
    await supervisor.runOnce();
    expect(supervisor.handleCancellation(makeCancellation(), "push")).toBe(true);

    await expect(supervisor.runOnce()).rejects.toMatchObject({
      details: { status: 401 }
    });
    expect(control.close).toHaveBeenCalledOnce();
    pending.resolve({ status: "cancelled" });
    await supervisor.drain();
    await supervisor.shutdown();

    expect(acknowledgeCancellation).not.toHaveBeenCalled();
  });
});

function pollAuthError(status: 401 | 403): WorkerError {
  return new WorkerError({
    message: `API returned HTTP ${status} for poll`,
    code: "HTTP_STATUS_ERROR",
    stage: "http.poll",
    details: { operation: "poll", status }
  });
}
