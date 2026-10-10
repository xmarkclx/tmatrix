import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createSecurityWarningReporter, type AlertSecurityWarning } from "../src/security-warning.js";
import { WorkerError } from "../src/errors.js";
import { nullLogger } from "../src/logger.js";
import { makeTicket } from "./helpers.js";

describe("executing-worker security warnings", () => {
  it("constructs host-owned alerts and suppresses repeated accepted warnings for the same submitted input", async () => {
    const alert = vi.fn<AlertSecurityWarning>(async () => ({ status: "sent" }));
    const warning = createSecurityWarningReporter({ ticket: makeTicket(), alert, logger: nullLogger() });
    warning.submitInput("Initial authorized task");
    expect(await warning.report("credential_theft")).toEqual({ status: "sent" });
    expect(await warning.report("credential_theft")).toEqual({ status: "suppressed" });
    expect(alert.mock.calls[0]?.[0]).toEqual({ ticket_id: "T-1001", worker_id: "w-1001",
      input_digest: createHash("sha256").update("Initial authorized task").digest("hex"), category: "credential_theft" });
    warning.submitInput("Latest steering input");
    expect(await warning.report("credential_theft")).toEqual({ status: "sent" });
    expect(alert.mock.calls[1]?.[0]).toMatchObject({ input_digest: createHash("sha256").update("Latest steering input").digest("hex") });
  });

  it.each([
    [{ status: "test_only" }, "test_only"],
    [{ status: "unknown" }, "unconfirmed"],
  ])("returns honest delivery receipts", async (response, expected) => {
    const warning = createSecurityWarningReporter({ ticket: makeTicket(), alert: async () => response, logger: nullLogger() });
    warning.submitInput("task");
    expect(await warning.report("security_bypass")).toEqual({ status: expected });
  });

  it("contains provider failures, permits retry and identifies API suppression", async () => {
    const alert = vi.fn<AlertSecurityWarning>().mockRejectedValueOnce(new Error("Private provider body"))
      .mockRejectedValueOnce(new WorkerError({ message: "HTTP failure", code: "HTTP_STATUS_ERROR", stage: "http", details: { status: 429 } })).mockResolvedValueOnce({ status: "sent" });
    const warning = createSecurityWarningReporter({ ticket: makeTicket(), alert, logger: nullLogger() });
    warning.submitInput("task");
    expect(await warning.report("data_exfiltration")).toEqual({ status: "unconfirmed" });
    expect(await warning.report("data_exfiltration")).toEqual({ status: "suppressed" });
    expect(await warning.report("data_exfiltration")).toEqual({ status: "sent" });
  });

  it("bounds an alert client that ignores cancellation and leaves the task signal active", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const alert = vi.fn<AlertSecurityWarning>(() => new Promise(() => {}));
      const warning = createSecurityWarningReporter({ ticket: makeTicket(), alert, logger: nullLogger(), signal: controller.signal });
      warning.submitInput("task");
      const pending = warning.report("destructive_actions");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pending).toEqual({ status: "unconfirmed" });
      expect(controller.signal.aborted).toBe(false);
      expect(alert.mock.calls[0]?.[1]?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("respects actual cancellation without starting or blocking warning delivery", async () => {
    const controller = new AbortController();
    const alert = vi.fn<AlertSecurityWarning>(() => new Promise(() => {}));
    const warning = createSecurityWarningReporter({ ticket: makeTicket(), alert, logger: nullLogger(), signal: controller.signal });
    warning.submitInput("task");
    const pending = warning.report("suspicious_instructions");
    await Promise.resolve();
    controller.abort();
    expect(await pending).toEqual({ status: "unconfirmed" });
    expect(await warning.report("credential_theft")).toEqual({ status: "unconfirmed" });
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch a warning cancelled before the client receives it", async () => {
    const controller = new AbortController();
    const alert = vi.fn<AlertSecurityWarning>(async () => ({ status: "sent" }));
    const warning = createSecurityWarningReporter({ ticket: makeTicket(), alert, logger: nullLogger(), signal: controller.signal });
    warning.submitInput("task");
    const pending = warning.report("credential_theft");
    controller.abort();
    expect(await pending).toEqual({ status: "unconfirmed" });
    expect(alert).not.toHaveBeenCalled();
  });
});
