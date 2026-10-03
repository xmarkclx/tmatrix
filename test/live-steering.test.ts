import { describe, expect, it, vi } from "vitest";
import * as preparation from "../src/adapters/codex/prepare-input.js";
import type { WorkerObservation } from "../src/local-worker-state.js";
import { nullLogger } from "../src/logger.js";
import { Metrics } from "../src/metrics.js";
import { SteeringMailbox, TicketRunner, type WorkerThreadEvent } from "../src/runner.js";
import { deferred, makeTicket } from "./helpers.js";

describe("live steering delivery failures", () => {
  it.each(["screening", "preparation", "steer", "cleanup"])("reports %s failures at the correct delivery boundary", async (stage) => {
    const failureObserved = deferred<void>();
    const observations: WorkerObservation[] = [];
    const mailbox = new SteeringMailbox();
    mailbox.enqueueLocal("local-failure", "LOCAL_GUIDANCE: Check focus");
    const originalPrepare = preparation.prepareCodexInput;
    const fixtureError = new Error("Private fixture error detail");
    const cleanup = vi.fn(async () => { if (stage === "cleanup") throw fixtureError; });
    const prepare = vi.spyOn(preparation, "prepareCodexInput").mockImplementation(async (text, options) => {
      if (!text.includes("LOCAL_GUIDANCE")) return originalPrepare(text, options);
      if (stage === "preparation") throw fixtureError;
      return { input: text, attachedImages: 0, skippedImages: 0, cleanup };
    });
    const steer = vi.fn(async () => {
      if (stage === "steer") throw fixtureError;
      return true;
    });
    const runStreamed = vi.fn(async () => ({ events: (async function* (): AsyncGenerator<WorkerThreadEvent> {
      yield { type: "turn.started" };
      await failureObserved.promise;
      yield { type: "item.completed", item: { id: "final", type: "agent_message", text: JSON.stringify({
        outcome: "AI_DONE", context_summary: "Completed", user_message: "Ready"
      }) } };
      yield { type: "turn.completed", usage: {
        input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0,
        output_tokens: 1, reasoning_output_tokens: 0
      } };
    })() }));
    const api = {
      markTaken: vi.fn(async () => undefined),
      getHistory: vi.fn(async () => ({})),
      reportProgress: vi.fn(async () => undefined),
      reportResult: vi.fn(async () => undefined)
    };
    const runner = new TicketRunner({
      runtimeFactory: () => ({ startThread: () => ({ runStreamed, steer }) }),
      screenPrompt: async (_ticket, text) => {
        if (stage === "screening" && text.includes("LOCAL_GUIDANCE")) throw fixtureError;
      },
      api, logger: nullLogger(), metrics: new Metrics()
    });
    try {
      await expect(runner.run(makeTicket(), {
        runId: "failure-boundary", recovered: false, steering: mailbox,
        observe: event => {
          observations.push(event);
          if (event.kind === "steering.failed") failureObserved.resolve();
        }
      })).resolves.toMatchObject({ status: "completed" });
      const notSent = stage === "screening" || stage === "preparation";
      expect(observations.filter(event => event.steering_id === "local-failure")).toEqual([{
        kind: "steering.failed", steering_id: "local-failure",
        text: notSent
          ? "Message was not sent because screening or input preparation failed."
          : "Could not confirm message delivery. It will not be resent automatically because the runtime may have received it."
      }]);
      expect(steer).toHaveBeenCalledTimes(notSent ? 0 : 1);
      expect(cleanup).toHaveBeenCalledTimes(notSent ? 0 : 1);
      expect(runStreamed).toHaveBeenCalledTimes(1);
      expect(mailbox.hasLocal()).toBe(false);
      expect(JSON.stringify(observations)).not.toContain(fixtureError.message);
    } finally {
      prepare.mockRestore();
    }
  });
});
