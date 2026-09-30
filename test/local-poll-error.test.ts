import { describe, expect, it } from "vitest";
import { WorkerError } from "../src/errors.js";
import { localPollError } from "../src/helpers/local-poll-error.js";

describe("local poll error", () => {
  it("shows HTTP diagnostics without serializing response details", () => {
    const error = new WorkerError({ message: "API returned HTTP 401 for poll", code: "HTTP_STATUS_ERROR", stage: "http.poll", details: { body: "private response" } });
    expect(localPollError(error, "fake-key")).toBe("Poll failed: HTTP_STATUS_ERROR: API returned HTTP 401 for poll");
  });

  it("includes nested network codes without nested request data", () => {
    const cause = Object.assign(new Error("private request"), { code: "ENOTFOUND" });
    expect(localPollError(new Error("fetch failed", { cause }), "")).toBe("Poll failed: fetch failed (ENOTFOUND)");
  });

  it("redacts credentials, strips terminal escapes, and bounds messages", () => {
    const result = localPollError(new Error("\x1b[31mfailed fake-key Bearer abcdef password=hidden\n" + "x".repeat(2000)), "fake-key");
    expect(result).not.toMatch(/fake-key|abcdef|hidden|\x1b|\n/);
    expect(result).toContain("[REDACTED]");
    expect(result.length).toBeLessThan(1020);
    expect(result.endsWith("…")).toBe(true);
  });
});
