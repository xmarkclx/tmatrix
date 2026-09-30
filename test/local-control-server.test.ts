import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startLocalControlServer } from "../src/local-control-server.js";
import { LocalWorkerState } from "../src/local-worker-state.js";
import { nullLogger } from "../src/logger.js";
import { Metrics } from "../src/metrics.js";
import { Supervisor } from "../src/supervisor.js";
import type { RunOutcome, TicketRunner } from "../src/runner.js";
import { deferred, makeConfig, makeTicket } from "./helpers.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });

async function connect(supervisor: Supervisor) {
  const dir = await mkdtemp(join(tmpdir(), "tmatrix-control-test-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "control.json");
  const onShutdown = vi.fn();
  const bridge = await startLocalControlServer({ supervisor, file, onShutdown });
  cleanup.push(() => bridge.close());
  const discovery = JSON.parse(await readFile(file, "utf8"));
  return { file, bridge, onShutdown, discovery, request: (path: string, body?: unknown) => fetch(discovery.url + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${discovery.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }) };
}

function pausedSupervisor() {
  const poll = vi.fn(async () => ({ new_tickets: [], owned_in_progress: [], steering_events: [], cancellation_requests: [] }));
  const supervisor = new Supervisor({
    config: makeConfig(), poller: { poll }, runner: { run: vi.fn() } as unknown as TicketRunner,
    logger: nullLogger(), metrics: new Metrics(), intakePaused: true, localState: new LocalWorkerState()
  });
  return { supervisor, poll };
}

describe("local console bridge", () => {
  it("starts paused without contacting TzuDo, authenticates, and applies validated settings", async () => {
    const { supervisor, poll } = pausedSupervisor();
    await supervisor.runOnce();
    expect(poll).not.toHaveBeenCalled();
    const client = await connect(supervisor);
    expect((await stat(client.file)).mode & 0o777).toBe(0o600);
    expect((await fetch(client.discovery.url + "/v1/snapshot")).status).toBe(401);
    expect((await fetch(client.discovery.url + "/v1/snapshot", { headers: { authorization: `Bearer ${client.discovery.token}`, origin: "https://example.test" } })).status).toBe(403);
    expect((await client.request("/v1/settings", { max_workers: 0 })).status).toBe(400);
    expect((await client.request("/v1/settings", { max_workers: 8, poll_interval_ms: 750, intake_paused: false })).status).toBe(200);
    const snapshot = await (await client.request("/v1/snapshot")).json();
    expect(snapshot).toMatchObject({ version: 1, max_workers: 8, poll_interval_ms: 750, intake_paused: false, workers: [] });
    expect(JSON.stringify(snapshot)).not.toContain("test-secret-key");
    await supervisor.runOnce();
    expect(poll).toHaveBeenCalledTimes(2);
    expect((await client.request("/v1/shutdown", {})).status).toBe(202);
    await vi.waitFor(() => expect(client.onShutdown).toHaveBeenCalledOnce());
    await client.bridge.close();
    await expect(stat(client.file)).rejects.toThrow();
  });

  it("refuses existing discovery files instead of replacing a running daemon", async () => {
    const { supervisor } = pausedSupervisor();
    const client = await connect(supervisor);
    const original = await readFile(client.file, "utf8");
    await expect(startLocalControlServer({ supervisor, file: client.file, onShutdown: () => undefined })).rejects.toThrow("Could not create private");
    expect(await readFile(client.file, "utf8")).toBe(original);
    await writeFile(client.file, "different owner");
    await client.bridge.close();
    expect(await readFile(client.file, "utf8")).toBe("different owner");
  });

  it.each([true, false])("confirms stop only after verified teardown (clean=%s)", async (clean) => {
    const ticket = makeTicket();
    const done = deferred<RunOutcome>();
    const run = vi.fn(() => done.promise);
    let pollCount = 0;
    const supervisor = new Supervisor({
      config: makeConfig(), localState: new LocalWorkerState(),
      poller: { poll: async () => ({ new_tickets: ++pollCount === 2 ? [ticket] : [], owned_in_progress: pollCount > 2 ? [ticket] : [], steering_events: [], cancellation_requests: [] }) },
      runner: { run } as unknown as TicketRunner, logger: nullLogger(), metrics: new Metrics()
    });
    await supervisor.runOnce();
    const client = await connect(supervisor);
    expect((await client.request(`/v1/workers/${ticket.worker_id}/steer`, { message: "Focus on tests", request_id: "local-one" })).status).toBe(202);
    expect((await client.request(`/v1/workers/${ticket.worker_id}/steer`, { message: "Focus on tests", request_id: "local-one" })).status).toBe(202);
    expect((await client.request(`/v1/workers/${ticket.worker_id}/steer`, { message: "Different message", request_id: "local-one" })).status).toBe(409);
    expect(supervisor.localSnapshot().workers[0]?.steering).toHaveLength(1);
    expect((await client.request(`/v1/workers/${ticket.worker_id}/stop`, {})).status).toBe(202);
    expect(supervisor.localSnapshot().workers[0]?.status).toBe("stopping");
    expect((await client.request(`/v1/workers/${ticket.worker_id}/steer`, { message: "Too late" })).status).toBe(409);
    if (clean) done.resolve({ status: "cancelled" }); else done.reject(new Error("teardown failed"));
    await supervisor.drain();
    expect(supervisor.localSnapshot().workers[0]?.status).toBe(clean ? undefined : "stop_unverified");
    await supervisor.runOnce();
    expect(run).toHaveBeenCalledOnce();
  });

  it.each(["completed", "failed"] as const)("pins a %s worker without retaining its execution slot", async (status) => {
    const ticket = makeTicket();
    const done = deferred<RunOutcome>();
    let polls = 0;
    const supervisor = new Supervisor({
      config: makeConfig(), localState: new LocalWorkerState(),
      poller: { poll: async () => ({ new_tickets: ++polls === 2 ? [ticket] : [], owned_in_progress: [], steering_events: [], cancellation_requests: [] }) },
      runner: { run: () => done.promise } as unknown as TicketRunner, logger: nullLogger(), metrics: new Metrics()
    });
    await supervisor.runOnce();
    const client = await connect(supervisor);
    const path = `/v1/workers/${ticket.worker_id}/pin`;
    for (const body of [{}, { pinned: "true" }, { pinned: true, extra: 1 }]) {
      expect((await client.request(path, body)).status).toBe(400);
    }
    expect((await client.request(path, { pinned: true })).status).toBe(200);
    done.resolve({ status });
    await supervisor.drain();
    expect(supervisor.localSnapshot()).toMatchObject({ running_workers: 0, workers: [{ pinned: true, status }] });
    expect((await client.request(`/v1/workers/${ticket.worker_id}/steer`, { message: "too late" })).status).toBe(409);
    expect((await client.request(path, { pinned: false })).status).toBe(200);
    expect(supervisor.localSnapshot().workers).toEqual([]);
    expect((await client.request(path, { pinned: true })).status).toBe(404);
  });

  it("bounds local activity and strips terminal controls", () => {
    const state = new LocalWorkerState();
    state.start(makeTicket());
    for (let i = 0; i < 250; i++) state.record("w-1001", { kind: "command.output", text: "\x1b[2Jhello\x1b]52;c;bad\x07" });
    const worker = state.snapshot()[0]!;
    expect(worker.activity).toHaveLength(251);
    expect(worker.activity[1]?.text).toBe("hello");
    worker.activity[1]!.text = "changed";
    expect(state.snapshot()[0]?.activity[1]?.text).toBe("hello");
    for (let i = 0; i < 100; i++) {
      const id = `worker-${i}`;
      state.start(makeTicket({ worker_id: id }));
      state.record(id, { kind: "prompt.prepared", text: "\\".repeat(40000), input_revision: 1 });
      for (let entry = 0; entry < 20; entry++) state.record(id, { kind: "command.output", text: "\\".repeat(4096) });
      expect(Buffer.byteLength(JSON.stringify(state.snapshot().find((worker) => worker.id === id)?.activity))).toBeLessThanOrEqual(128 * 1024);
    }
    expect(Buffer.byteLength(JSON.stringify(state.snapshot()))).toBeLessThan(16 * 1024 * 1024);
  });
});
