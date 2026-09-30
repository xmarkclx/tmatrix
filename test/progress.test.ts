import { describe, expect, it, vi } from "vitest";
import { nullLogger } from "../src/logger.js";
import { Metrics } from "../src/metrics.js";
import { ProgressReporter } from "../src/progress.js";
import { deferred, makeTicket } from "./helpers.js";

describe("final progress delivery", () => {
  it("bounds a stalled backlog and aborts it before sending more progress", async () => {
    vi.useFakeTimers();
    const pending = deferred<void>();
    let signal: AbortSignal | undefined;
    const reportProgress = vi.fn(async (_ticket, _event, requestSignal) => {
      signal = requestSignal;
      await pending.promise;
    });
    const reporter = new ProgressReporter({
      api: {
        markTaken: async () => undefined,
        getHistory: async () => ({}),
        reportResult: async () => undefined,
        reportProgress
      },
      ticket: makeTicket(), logger: nullLogger(), metrics: new Metrics(), inputRevision: 1
    });
    try {
      reporter.enqueue("item.started", {});
      reporter.enqueue("turn.completed", {});
      const flush = reporter.flush();
      await vi.advanceTimersByTimeAsync(2_000);
      await flush;
      expect(signal?.aborted).toBe(true);
      pending.resolve();
      await reporter.flush();
      expect(reportProgress).toHaveBeenCalledTimes(1);
    } finally {
      pending.resolve();
      vi.useRealTimers();
    }
  });
});
