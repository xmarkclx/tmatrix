import { describe, expect, it, vi } from "vitest";
import { WorkerError } from "../src/errors.js";
import { nullLogger } from "../src/logger.js";
import { deliverResult } from "../src/result-delivery.js";
import type { TicketApi } from "../src/api-client.js";
import type { TicketResult } from "../src/types.js";
import { makeTicket } from "./helpers.js";

describe("completed result delivery", () => {
  const result: TicketResult = {
    status: "completed", input_revision: 1, outcome: "AI_DONE",
    user_message: "Done", context_summary: "Finished", final_response: "Done",
    started_at: "2026-09-27T14:00:00.000Z", completed_at: "2026-09-27T14:01:00.000Z", duration_ms: 60_000
  };
  const transient = () => new WorkerError({ message: "API timeout", code: "HTTP_NETWORK_ERROR", stage: "http.result", retryable: true });
  const makeApi = (reportResult: TicketApi["reportResult"]): TicketApi => ({
    markTaken: async () => undefined, getHistory: async () => ({}), reportProgress: async () => undefined, reportResult
  });

  it("retries the same completed result after request retries are exhausted", async () => {
    const receipt = { success: true, comment_id: "accepted-comment" };
    const reportResult = vi.fn<TicketApi["reportResult"]>().mockRejectedValueOnce(transient()).mockResolvedValue(receipt);
    const wait = vi.fn(async () => undefined);
    expect(await deliverResult({ api: makeApi(reportResult), ticket: makeTicket(), result, signal: new AbortController().signal, logger: nullLogger(), wait })).toBe(receipt);
    expect(reportResult).toHaveBeenCalledTimes(2);
    expect(reportResult.mock.calls[0]?.[1]).toBe(result);
    expect(reportResult.mock.calls[1]?.[1]).toBe(result);
    expect(wait).toHaveBeenCalledOnce();
  });

  it("stops retained delivery when ownership is cancelled", async () => {
    const controller = new AbortController();
    const reportResult = vi.fn<TicketApi["reportResult"]>().mockRejectedValue(transient());
    const reason = new Error("Ownership revoked");
    await expect(deliverResult({
      api: makeApi(reportResult), ticket: makeTicket(), result, signal: controller.signal, logger: nullLogger(),
      wait: async () => { controller.abort(reason); }
    })).rejects.toBe(reason);
    expect(reportResult).toHaveBeenCalledOnce();
  });

  it("does not retry permanent API rejections", async () => {
    const rejected = new WorkerError({ message: "Stale revision", code: "HTTP_STATUS_ERROR", stage: "http.result", retryable: false });
    const reportResult = vi.fn<TicketApi["reportResult"]>().mockRejectedValue(rejected);
    const wait = vi.fn(async () => undefined);
    await expect(deliverResult({ api: makeApi(reportResult), ticket: makeTicket(), result, signal: new AbortController().signal, logger: nullLogger(), wait })).rejects.toBe(rejected);
    expect(wait).not.toHaveBeenCalled();
  });
});
