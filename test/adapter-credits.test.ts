import { afterEach, describe, expect, it, vi } from "vitest";
import { AdapterCreditService } from "../src/adapter-credits.js";
import { setupAdapter } from "../src/adapter-loader.js";
import { nullLogger } from "../src/logger.js";
import type { AdapterCreditReading } from "../src/runtime-adapter.js";
import { deferred, makeTicket } from "./helpers.js";

afterEach(() => vi.useRealTimers());
const reading = { windows: [{ label: "5h", remaining_percent: 15 }] };
const createService = (fetch: (options: { signal: AbortSignal }) => Promise<AdapterCreditReading | null>, options = {}) =>
  new AdapterCreditService("echo", { displayName: "Echo", fetch }, options);

describe("adapter credit reporting", () => {
  it("polls immediately and each minute, and manual requests share the active reading", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T00:00:00Z"));
    const pending = deferred<AdapterCreditReading>();
    const fetch = vi.fn().mockResolvedValueOnce(reading).mockImplementationOnce(() => pending.promise).mockResolvedValue(reading);
    const service = createService(fetch);
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.snapshot()).toEqual({ adapter_id: "echo", display_name: "Echo", status: "ready", refreshing: false,
      checked_at: "2026-10-12T00:00:00.000Z", last_successful_at: "2026-10-12T00:00:00.000Z", windows: reading.windows });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetch.mock.calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const first = service.refresh();
    expect(service.refresh()).toBe(first);
    expect(service.snapshot()).toMatchObject({ refreshing: true, windows: reading.windows });
    pending.resolve({ windows: [{ label: "7d", remaining_percent: 0 }] });
    await first;
    expect(service.snapshot()).toMatchObject({ status: "ready", refreshing: false, windows: [{ label: "7d", remaining_percent: 0 }] });
    expect(fetch.mock.calls.length).toBe(2);
    await service.close();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(fetch.mock.calls.length).toBe(2);
  });

  it("retains visibly stale percentages on failure and clears them on a successful empty or null reading", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(reading).mockRejectedValueOnce(new Error("private diagnostic"))
      .mockResolvedValueOnce({ windows: [] }).mockResolvedValueOnce(reading).mockResolvedValueOnce(null);
    const service = createService(fetch);
    await service.refresh();
    await service.refresh();
    expect(service.snapshot()).toMatchObject({ status: "stale", windows: reading.windows });
    expect(JSON.stringify(service.snapshot())).not.toContain("private diagnostic");
    await service.refresh();
    expect(service.snapshot()).toMatchObject({ status: "unavailable", refreshing: false });
    expect("windows" in service.snapshot()).toBe(false);
    await service.refresh();
    expect(service.snapshot()).toMatchObject({ status: "ready", windows: reading.windows });
    await service.refresh();
    expect(service.snapshot()).toMatchObject({ status: "unavailable" });
    await service.close();
  });

  it("rejects unsafe and invalid adapter values and exports only normalized reading fields", async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ windows: [{ label: "5h", remaining_percent: 0, secret: "discard" }], output: "discard" })
      .mockResolvedValueOnce({ windows: [{ label: "bad\u001b", remaining_percent: 21 }] })
      .mockResolvedValueOnce({ windows: [{ label: "5h", remaining_percent: Number.NaN }] });
    const service = createService(fetch);
    await service.refresh();
    expect(service.snapshot()).toMatchObject({ windows: [{ label: "5h", remaining_percent: 0 }] });
    expect(JSON.stringify(service.snapshot())).not.toContain("discard");
    await service.refresh();
    expect(service.snapshot()).toMatchObject({ status: "stale", windows: [{ label: "5h", remaining_percent: 0 }] });
    await service.refresh();
    expect(service.snapshot()).toMatchObject({ status: "stale" });
    await service.close();
  });

  it("marks aged data stale after two polling intervals", async () => {
    let now = 1_000_000;
    const service = createService(async () => reading, { now: () => now });
    await service.refresh();
    now += 119_999;
    expect(service.snapshot().status).toBe("ready");
    now += 1;
    expect(service.snapshot()).toMatchObject({ status: "stale", windows: reading.windows });
    await service.close();
  });

  it("bounds timeout, blocks another operation when cancellation is ignored, and discards late output", async () => {
    vi.useFakeTimers();
    const pending = deferred<AdapterCreditReading>();
    let signal: AbortSignal | undefined;
    const fetch = vi.fn(({ signal: supplied }) => { signal = supplied; return pending.promise; });
    const service = createService(fetch, { timeoutMs: 10, closeTimeoutMs: 5 });
    const first = service.refresh();
    await vi.advanceTimersByTimeAsync(10);
    await first;
    expect(signal?.aborted).toBe(true);
    expect(service.snapshot()).toMatchObject({ status: "unavailable", refreshing: false });
    await service.refresh();
    expect(fetch.mock.calls.length).toBe(1);
    const closed = service.close();
    await vi.advanceTimersByTimeAsync(5);
    await closed;
    pending.resolve(reading);
    await vi.advanceTimersByTimeAsync(0);
    expect(service.snapshot()).toMatchObject({ status: "unavailable", refreshing: false });
    expect("windows" in service.snapshot()).toBe(false);
  });

  it("preserves a prepared worker factory and updater when the optional credit capability is invalid", async () => {
    const selected = vi.fn(() => ({ startThread() { throw new Error("prepared worker selected"); }, async close() {} }));
    const fallback = vi.fn(() => ({ startThread() { throw new Error("fallback"); }, async close() {} }));
    const setup = await setupAdapter({ apiVersion: 1, id: "echo", create: fallback, setup: () => ({ create: selected,
      updates: { displayName: "Echo", snapshot: () => ({ status: "idle", current_version: "2.0.0" }), start() {}, async close() {}, async checkNow() {} },
      credits: { displayName: "bad\u001b", async fetch() { return reading; } } })
    }, { environment: {}, logger: nullLogger(), updateDirectory: "/unused" });
    expect(() => setup.runtimeFactory(makeTicket()).startThread({} as never)).toThrow("prepared worker selected");
    expect(setup.updates?.snapshot()).toMatchObject({ current_version: "2.0.0" });
    expect(setup.credits).toBeUndefined();
  });
});
