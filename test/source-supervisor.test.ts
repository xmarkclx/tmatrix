import { describe, expect, it, vi } from "vitest";
import type { EngineConfig, ReadySource } from "../src/config.js";
import { WorkerError } from "../src/errors.js";
import { LocalWorkerState } from "../src/local-worker-state.js";
import { nullLogger } from "../src/logger.js";
import { Metrics } from "../src/metrics.js";
import type { RunOutcome, SteeringMailbox } from "../src/runner.js";
import { SourceSupervisor } from "../src/source-supervisor.js";
import { Supervisor } from "../src/supervisor.js";
import type { PollRequest, PollResponse, Ticket } from "../src/types.js";
import { deferred, makeCancellation, makeConfig, makeTicket } from "./helpers.js";

const ids = ["legacy", "22222222-2222-4222-8222-222222222222"];
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const response = (changes: Partial<PollResponse> = {}): PollResponse => ({ new_tickets: [], owned_in_progress: [], steering_events: [], cancellation_requests: [], ...changes });

type Run = { source: number; signal: AbortSignal | undefined; pending: ReturnType<typeof deferred<RunOutcome>>; steering: SteeringMailbox | undefined };
function harness(maxWorkers = 2, intercept?: (source: number, request: PollRequest, calls: number) => Promise<PollResponse | void>, initialSources = 2) {
  const configs = ids.map((id, source) => makeConfig({ instance_id: id, max_workers: maxWorkers, poll_interval_ms: 250, idle_backoff_max_ms: 250, api_key: `fixture-${source}` }));
  const first = configs[0]!;
  const { api_key: _key, poll_url: _url, poll_origin, ...common } = first;
  const sources: ReadySource[] = configs.map((config, source) => ({ kind: "ready", config,
    metadata: { id: ids[source]!, name: source === 0 ? "TzuDo" : "Mindmap", instance_id: config.instance_id,
      poll_url: config.poll_url, conversation_namespace: JSON.stringify([config.poll_url, ids[source]]) } }));
  const config: EngineConfig = { ...common, update_origin: poll_origin, sources: sources.slice(0, initialSources) };
  const requests: PollRequest[][] = [[], []];
  const runs: Run[] = [];
  const children: Supervisor[] = [];
  const active: (Ticket | undefined)[] = [];
  const claimed = [false, false];
  const supervisor = new SourceSupervisor({ config, logger: nullLogger(), createSupervisor(source, sharedCapacity) {
    const index = ids.indexOf(source.metadata.id);
    const child = new Supervisor({ config: source.config, sharedCapacity, logger: nullLogger(), metrics: new Metrics(), localState: new LocalWorkerState(),
      poller: { async poll(request) {
        requests[index]!.push(request);
        const result = await intercept?.(index, request, requests[index]!.length);
        if (result) return result;
        if (request.available_slots && !claimed[index]) {
          claimed[index] = true;
          active[index] = makeTicket();
          return response({ new_tickets: [active[index]!] });
        }
        return response({ owned_in_progress: active[index] ? [active[index]!] : [] });
      } },
      runner: { run(_ticket, options) {
        const pending = deferred<RunOutcome>();
        runs.push({ source: index, signal: options.signal, pending, steering: options.steering });
        options.signal?.addEventListener("abort", () => pending.resolve({ status: "cancelled" }), { once: true });
        return pending.promise.then(outcome => { active[index] = undefined; return outcome; });
      } }
    });
    children.push(child);
    return child;
  } });
  return { supervisor, requests, runs, children, active, config, sources, async close() {
    for (const run of runs) run.pending.resolve({ status: "completed" });
    await supervisor.shutdown(0);
  } };
}

describe("named sources", () => {
  it("adds a source to the running engine without replacing active work or changing pause and capacity", async () => {
    const h = harness(2, undefined, 1);
    const loop = h.supervisor.run();
    try {
      await vi.waitFor(() => expect(h.runs.map(run => run.source)).toEqual([0]));
      const previous = h.supervisor.localSnapshot().workers[0];
      h.supervisor.updateLocalSettings({ max_workers: 1, poll_interval_ms: 300_000, intake_paused: true });
      const source = h.sources[1]!;
      expect(h.supervisor.addSource(source)).toBe(true);
      expect(h.supervisor.addSource(source)).toBe(true);
      expect(h.supervisor.addSource({ ...source, metadata: { ...source.metadata, name: "Different" } })).toBe(false);
      const snapshot = h.supervisor.localSnapshot();
      expect(snapshot).toMatchObject({ running_workers: 1, intake_paused: true, max_workers: 1, poll_interval_ms: 300_000,
        workers: [{ id: previous?.id, status: "running" }] });
      expect(snapshot.pollers.map(poller => poller.name)).toEqual(["TzuDo", "Mindmap"]);
      expect(h.runs[0]?.signal?.aborted).toBe(false);
      await flush();
      expect(h.requests[1]).toEqual([]);

      h.supervisor.updateLocalSettings({ intake_paused: false });
      await vi.waitFor(() => expect(h.requests[1]?.map(request => request.available_slots)).toEqual([0]));
      expect(h.runs.map(run => run.source)).toEqual([0]);
      h.runs[0]?.pending.resolve({ status: "completed" });
      await vi.waitFor(() => expect(h.runs.map(run => run.source)).toEqual([0, 1]));
      expect(h.supervisor.localSnapshot().running_workers).toBe(1);
    } finally { await h.close(); await loop; }
  });

  it("reconciles every source before intake and runs colliding IDs under one cap", async () => {
    const seen: { source: number; slots: number }[] = [];
    const h = harness(2, async (source, request) => { seen.push({ source, slots: request.available_slots }); });
    try {
      await h.supervisor.runOnce();
      expect(seen.slice(0, 2)).toEqual([{ source: 0, slots: 0 }, { source: 1, slots: 0 }]);
      const state = h.supervisor.localSnapshot();
      expect(state.running_workers).toBe(2);
      expect(state.workers.map(worker => worker.source_name)).toEqual(["TzuDo", "Mindmap"]);
      expect(new Set(state.workers.map(worker => worker.id)).size).toBe(2);
      expect(state.workers.map(worker => worker.ticket_id)).toEqual(["T-1001", "T-1001"]);
      await h.supervisor.runOnce();
      expect(h.requests.map(requests => requests.at(-1)?.available_slots)).toEqual([0, 0]);
      expect(h.runs.map(run => run.source)).toEqual([0, 1]);
    } finally { await h.close(); }
  });

  it("routes local steer, pin and stop to the selected source only", async () => {
    const h = harness();
    try {
      await h.supervisor.runOnce();
      const [first, second] = h.supervisor.localSnapshot().workers;
      expect(h.supervisor.pinLocalWorker(first!.id, { pinned: true })).toBe(true);
      h.supervisor.queueLocalSteering(second!.id, "Continue this source", "same-request-id");
      h.supervisor.stopLocalWorker(first!.id);
      await flush();
      expect(h.runs.map(run => run.signal?.aborted)).toEqual([true, false]);
      expect(h.supervisor.localSnapshot().workers.map(worker => ({ source: worker.source_name, status: worker.status, queued: worker.steering.length })))
        .toEqual([{ source: "TzuDo", status: "stopped", queued: 0 }, { source: "Mindmap", status: "running", queued: 1 }]);
      expect(h.supervisor.runningCount).toBe(1);
    } finally { await h.close(); }
  });

  it("retains ambiguous reservations and replays them exactly even after global pause", async () => {
    let failed = false;
    const h = harness(1, async (source, request) => {
      if (source === 0 && request.available_slots > 0 && !failed) { failed = true; throw new Error("Reply lost after server claim"); }
    });
    try {
      await h.supervisor.runOnce();
      expect(h.supervisor.localSnapshot().pollers.map(poller => poller.reserved_slots)).toEqual([1, 0]);
      expect(h.supervisor.runningCount).toBe(0);
      h.supervisor.updateLocalSettings({ intake_paused: true });
      await h.supervisor.runOnce();
      expect(h.requests[0]![2]).toEqual(h.requests[0]![1]);
      expect(h.supervisor.reservedSlots).toBe(0);
      expect(h.runs.map(run => run.source)).toEqual([0]);
      expect(h.supervisor.runningCount).toBe(1);
    } finally { await h.close(); }
  });

  it("one source's authorization rejection stops only that source's claim", async () => {
    let reject = false;
    const h = harness(2, async source => {
      if (source === 0 && reject) throw new WorkerError({ message: "Rejected", code: "HTTP_STATUS_ERROR", stage: "http.poll", details: { status: 401 } });
    });
    try {
      await h.supervisor.runOnce();
      reject = true;
      await h.supervisor.runOnce();
      await flush();
      expect(h.runs.map(run => run.signal?.aborted)).toEqual([true, false]);
      expect(h.supervisor.runningCount).toBe(1);
      expect(h.supervisor.localSnapshot().pollers.map(poller => poller.status)).toEqual(["error", "connected"]);
    } finally { await h.close(); }
  });

  it("a failed startup source does not prevent healthy source intake", async () => {
    const h = harness(2, async source => { if (source === 0) throw new Error("Source is offline"); });
    try {
      await h.supervisor.runOnce();
      expect(h.runs.map(run => run.source)).toEqual([1]);
      expect(h.supervisor.localSnapshot().pollers.map(poller => poller.status)).toEqual(["error", "connected"]);
      expect(h.requests[1]!.map(request => request.available_slots)).toEqual([0, 1]);
    } finally { await h.close(); }
  });

  it("keeps a waiting source first even while its zero-slot control poll is slow", async () => {
    const slow = deferred<PollResponse>();
    let blocked = false;
    const h = harness(1, async (source, request, calls) => {
      if (source === 1 && calls === 2 && request.available_slots === 0) { blocked = true; return slow.promise; }
    });
    try {
      const initial = h.supervisor.runOnce();
      await flush();
      expect(blocked).toBe(true);
      expect(h.runs.map(run => run.source)).toEqual([0]);
      h.runs[0]!.pending.resolve({ status: "completed" });
      await flush();
      const extra = h.children[0]!.runOnce();
      await extra;
      expect(h.requests[0]!.at(-1)?.available_slots).toBe(0);
      slow.resolve(response());
      await initial;
      await h.supervisor.runOnce();
      expect(h.runs.map(run => run.source)).toEqual([0, 1]);
    } finally { slow.resolve(response()); await h.close(); }
  });

  it("global recovery and new intake share capacity", async () => {
    const h = harness(1, async (source, _request, calls) => {
      if (source === 1) return response({ owned_in_progress: [makeTicket()] });
    });
    try {
      await h.supervisor.runOnce();
      expect(h.runs.map(run => run.source)).toEqual([1]);
      expect(h.supervisor.runningCount).toBe(1);
      expect(h.requests[0]!.at(-1)?.available_slots).toBe(0);
    } finally { await h.close(); }
  });

  it("a paused startup does not contact sources until resumed", async () => {
    const h = harness();
    try {
      h.supervisor.updateLocalSettings({ intake_paused: true });
      await h.supervisor.runOnce();
      expect(h.supervisor.localSnapshot().intake_paused).toBe(true);
      expect(h.requests).toEqual([[], []]);
      h.supervisor.updateLocalSettings({ intake_paused: false });
      await h.supervisor.runOnce();
      expect(h.runs.map(run => run.source)).toEqual([0, 1]);
    } finally { await h.close(); }
  });

  it("identical cancellation event IDs remain independent across sources", async () => {
    const h = harness();
    try {
      await h.supervisor.runOnce();
      expect(h.children[0]!.handleCancellation(makeCancellation())).toBe(true);
      await flush();
      expect(h.runs.map(run => run.signal?.aborted)).toEqual([true, false]);
      expect(h.children[1]!.handleCancellation(makeCancellation())).toBe(true);
      await flush();
      expect(h.runs.map(run => run.signal?.aborted)).toEqual([true, true]);
      expect(h.supervisor.runningCount).toBe(0);
    } finally { await h.close(); }
  });

  it("a lowered cap defers claimed work until existing workers release capacity", async () => {
    let failed = false;
    const h = harness(4, async (source, request) => {
      if (source === 0 && request.available_slots > 0 && !failed) { failed = true; throw new Error("Claim reply lost"); }
    });
    try {
      await h.supervisor.runOnce();
      expect(h.supervisor.runningCount).toBe(1);
      expect(h.supervisor.reservedSlots).toBe(2);
      h.supervisor.updateLocalSettings({ max_workers: 1 });
      await h.supervisor.runOnce();
      expect(h.runs.map(run => run.source)).toEqual([1]);
      expect(h.supervisor.runningCount).toBe(1);
      h.runs[0]!.pending.resolve({ status: "completed" });
      await flush();
      await h.supervisor.runOnce();
      expect(h.runs.map(run => run.source)).toEqual([1, 0]);
      expect(h.supervisor.runningCount).toBe(1);
    } finally { await h.close(); }
  });


  it.each(["offline", "unauthorized"])("a failed %s waiter cannot block healthy peer intake", async failure => {
    let unhealthy = false;
    let claimedAgain = false;
    const h = harness(1, async (source, request) => {
      if (source === 1 && unhealthy) {
        if (failure === "unauthorized") throw new WorkerError({ message: "Rejected", code: "HTTP_STATUS_ERROR", stage: "http.poll", details: { status: 401 } });
        throw new Error("Source offline");
      }
      if (source === 0 && request.available_slots > 0 && unhealthy && !claimedAgain) {
        claimedAgain = true;
        const ticket = makeTicket({ worker_id: "w-healthy-next", ticket_id: "T-healthy-next" });
        h.active[0] = ticket;
        return response({ new_tickets: [ticket] });
      }
    });
    try {
      await h.supervisor.runOnce();
      expect(h.runs.map(run => run.source)).toEqual([0]);
      unhealthy = true;
      await h.supervisor.runOnce();
      h.runs[0]!.pending.resolve({ status: "completed" });
      await flush();
      for (let index = 0; index < 3 && h.runs.length < 2; index++) await h.supervisor.runOnce();
      expect(h.runs.map(run => run.source)).toEqual([0, 0]);
      expect(h.supervisor.runningCount).toBe(1);
      expect(h.supervisor.localSnapshot().pollers.map(poller => poller.status)).toEqual(["connected", "error"]);
      expect(h.supervisor.reservedSlots).toBe(0);
    } finally { await h.close(); }
  });

});
