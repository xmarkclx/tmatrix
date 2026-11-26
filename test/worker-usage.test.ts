import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../src/api-client.js";
import { nullLogger } from "../src/logger.js";
import { Metrics } from "../src/metrics.js";
import { WorkerUsageReporter, type ProviderUsage } from "../src/worker-usage.js";
import { deferred, makeConfig } from "./helpers.js";

const codexUsage = {
  provider: "codex", plan_remaining_percent: 0, plan_resets_at: "2026-11-26T18:25:03.000Z",
  credits: { kind: "amount", amount: "1203.1250001234", unit: "credits" }
} satisfies ProviderUsage;
const claudeUsage = {
  provider: "claude", plan_remaining_percent: 71.5, plan_resets_at: null, credits: { kind: "unavailable" }
} satisfies ProviderUsage;
const geminiUsage = {
  provider: "gemini", plan_remaining_percent: 43, plan_resets_at: null,
  credits: { kind: "amount", amount: "51.25", unit: "credits" }
} satisfies ProviderUsage;

function clientAt(pollUrl: string, fetch: typeof globalThis.fetch) {
  return new ApiClient({
    config: makeConfig({ poll_url: pollUrl, poll_origin: new URL(pollUrl).origin }),
    logger: nullLogger(), metrics: new Metrics(), fetch
  });
}

describe("worker usage reports", () => {
  it("posts only sanitized figures through the preview source key and tolerates an older API", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 404 }));
    const client = clientAt("https://pr-43.tzd.mc-lopez.com/api/v1/ai/poll", fetch);
    await client.reportWorkerUsage([codexUsage, claudeUsage], new AbortController().signal);
    expect(fetch.mock.calls).toHaveLength(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://pr-43.tzd.mc-lopez.com/api/v1/ai/worker-usage");
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-secret-key");
    expect(JSON.parse(String(init?.body))).toEqual({ providers: [codexUsage, claudeUsage] });
  });

  it("rejects generic queue endpoints and does not retry service failures", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(null, { status: 503 }));
    const signal = new AbortController().signal;
    for (const url of [
      "https://example.com/api/v1/ai/poll", "https://tzudo.app/api/v1/other/poll",
      "https://pr-43.tzd.mc-lopez.com.example.com/api/v1/ai/poll", "https://tzudo.app:8443/api/v1/ai/poll"
    ]) await clientAt(url, fetch).reportWorkerUsage([codexUsage], signal);
    await expect(clientAt("https://tzudo.app/api/v1/ai/poll", fetch).reportWorkerUsage([codexUsage], signal))
      .rejects.toMatchObject({ code: "HTTP_STATUS_ERROR", details: { status: 503 } });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["https://tzudo.app/api/v1/ai/worker-usage"]);
  });

  const resetIssue = (index: number) => ({
    code: "unrecognized_keys", keys: ["plan_resets_at"], path: ["providers", index],
    message: 'Unrecognized key: "plan_resets_at"'
  });
  const inputError = (issues: unknown[]) => ({
    defined: false, code: "BAD_REQUEST", status: 400, message: "Input validation failed", data: { issues }
  });

  it("retries only the report fields supported by the older Tzu Do schema and checks again on the next report", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(inputError([resetIssue(0), resetIssue(1)]), { status: 400 }))
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const client = clientAt("https://tzudo.app/api/v1/ai/poll", fetch);
    const signal = new AbortController().signal;
    await client.reportWorkerUsage([codexUsage, claudeUsage], signal);
    await client.reportWorkerUsage([codexUsage, claudeUsage], signal);
    expect(fetch.mock.calls.map(([url, init]) => [
      url, init?.method, init?.redirect, new Headers(init?.headers).get("authorization"), JSON.parse(String(init?.body))
    ])).toEqual([
      ["https://tzudo.app/api/v1/ai/worker-usage", "POST", "error", "Bearer test-secret-key", { providers: [codexUsage, claudeUsage] }],
      ["https://tzudo.app/api/v1/ai/worker-usage", "POST", "error", "Bearer test-secret-key", { providers: [
        { provider: "codex", plan_remaining_percent: 0, credits: { kind: "amount", amount: "1203.1250001234", unit: "credits" } },
        { provider: "claude", plan_remaining_percent: 71.5, credits: { kind: "unavailable" } }
      ] }],
      ["https://tzudo.app/api/v1/ai/worker-usage", "POST", "error", "Bearer test-secret-key", { providers: [codexUsage, claudeUsage] }]
    ]);
  });

  it.each([
    { status: 401, payload: { code: "UNAUTHORIZED" } },
    { status: 403, payload: { code: "FORBIDDEN" } },
    { status: 400, payload: { code: "BAD_REQUEST", message: "Bad request" } },
    { status: 400, payload: inputError([{ code: "invalid_format", path: ["providers", 0, "plan_resets_at"] }]) },
    { status: 400, payload: inputError([resetIssue(0), { code: "invalid_type", path: ["providers", 0, "credits"] }]) },
    { status: 400, payload: inputError([{ ...resetIssue(0), keys: ["plan_resets_at", "unknown"] }]) },
    { status: 400, payload: inputError([resetIssue(1)]) }
  ])("preserves unrelated usage errors at status $status", async ({ status, payload }) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(payload, { status }));
    const client = clientAt("https://tzudo.app/api/v1/ai/poll", fetch);
    await expect(client.reportWorkerUsage([codexUsage], new AbortController().signal))
      .rejects.toMatchObject({ code: "HTTP_STATUS_ERROR", details: { status } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("makes at most one fallback request and surfaces its error", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(inputError([resetIssue(0)]), { status: 400 }))
      .mockResolvedValueOnce(Response.json({ code: "FORBIDDEN" }, { status: 403 }));
    const client = clientAt("https://tzudo.app/api/v1/ai/poll", fetch);
    await expect(client.reportWorkerUsage([codexUsage], new AbortController().signal))
      .rejects.toMatchObject({ code: "HTTP_STATUS_ERROR", details: { status: 403 } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps legacy meters fresh on servers that reject the Gemini provider", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 400 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = clientAt("https://tzudo.app/api/v1/ai/poll", fetch);
    await client.reportWorkerUsage([codexUsage, claudeUsage, geminiUsage], new AbortController().signal);
    expect(fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { providers: [codexUsage, claudeUsage, geminiUsage] },
      { providers: [codexUsage, claudeUsage] }
    ]);
  });

  it("keeps Gemini credits when the API supports Gemini but rejects reset fields", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(inputError([resetIssue(0), resetIssue(1), resetIssue(2)]), { status: 400 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = clientAt("https://tzudo.app/api/v1/ai/poll", fetch);
    await client.reportWorkerUsage([codexUsage, claudeUsage, geminiUsage], new AbortController().signal);
    expect(fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { providers: [codexUsage, claudeUsage, geminiUsage] },
      { providers: [codexUsage, claudeUsage, geminiUsage].map(({ plan_resets_at, ...usage }) => usage) }
    ]);
  });

  it("keeps Codex and Claude readings on servers that reject both Gemini and reset fields", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(inputError([
        resetIssue(0), resetIssue(1),
        { code: "invalid_value", path: ["providers", 2, "provider"], values: ["codex", "claude"] },
        resetIssue(2), { code: "too_big", path: ["providers"], maximum: 2 }
      ]), { status: 400 }))
      .mockResolvedValueOnce(Response.json(inputError([resetIssue(0), resetIssue(1)]), { status: 400 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = clientAt("https://tzudo.app/api/v1/ai/poll", fetch);
    await client.reportWorkerUsage([codexUsage, claudeUsage, geminiUsage], new AbortController().signal);
    expect(fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { providers: [codexUsage, claudeUsage, geminiUsage] },
      { providers: [codexUsage, claudeUsage] },
      { providers: [codexUsage, claudeUsage].map(({ plan_resets_at, ...usage }) => usage) }
    ]);
  });

  it("refreshes the sole production source while idle and aborts on close", async () => {
    vi.useFakeTimers();
    const first = deferred<void>();
    const last = deferred<void>();
    const history: { source: string; providers: ProviderUsage[] }[] = [];
    let codexReads = 0;
    let claudeReads = 0;
    let aborted = false;
    const reporter = new WorkerUsageReporter({
      codex: async (signal) => {
        if (++codexReads === 1) await first.promise;
        else {
          signal?.addEventListener("abort", () => { aborted = true; last.resolve(); }, { once: true });
          await last.promise;
        }
        return { plan: "exhausted", display: { plan_remaining_percent: 0, plan_resets_at: codexUsage.plan_resets_at, credits: codexUsage.credits } };
      },
      claude: async () => {
        claudeReads += 1;
        return { plan: "unknown", display: { plan_remaining_percent: 71.5, plan_resets_at: null, credits: { kind: "unavailable" } } };
      },
      gemini: async () => ({ plan: "unknown", display: {
        plan_remaining_percent: geminiUsage.plan_remaining_percent, plan_resets_at: null, credits: geminiUsage.credits
      } })
    });
    reporter.addSource({ id: "production", pollUrl: "https://tzudo.app/api/v1/ai/poll",
      async publish(providers) { history.push({ source: "production", providers }); } });
    reporter.addSource({ id: "preview", pollUrl: "https://pr-43.tzd.mc-lopez.com/api/v1/ai/poll",
      async publish(providers) { history.push({ source: "preview", providers }); } });
    try {
      reporter.start();
      await vi.advanceTimersByTimeAsync(300_001);
      first.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(history).toEqual([{ source: "production", providers: [codexUsage, claudeUsage, geminiUsage] }]);
      expect([codexReads, claudeReads]).toEqual([1, 1]);
      await vi.advanceTimersByTimeAsync(300_000);
      expect([codexReads, claudeReads]).toEqual([2, 2]);
      await reporter.close();
      await vi.advanceTimersByTimeAsync(300_000);
      expect(aborted).toBe(true);
      expect(history).toHaveLength(1);
    } finally {
      first.resolve();
      last.resolve();
      await reporter.close();
      vi.useRealTimers();
    }
  });

  it("stops default reporting if a second production account is added during a check", async () => {
    vi.useFakeTimers();
    const first = deferred<void>();
    const reports: string[] = [];
    let checks = 0;
    const reporter = new WorkerUsageReporter({ codex: async () => {
      checks += 1;
      if (checks === 2) await first.promise;
      return { plan: "exhausted", display: { plan_remaining_percent: 0, plan_resets_at: codexUsage.plan_resets_at, credits: codexUsage.credits } };
    } });
    const add = (id: string) => reporter.addSource({ id, pollUrl: "https://tzudo.app/api/v1/ai/poll",
      async publish() { reports.push(id); } });
    try {
      add("one");
      reporter.start();
      await vi.advanceTimersByTimeAsync(300_001);
      expect(checks).toBe(2);
      add("two");
      first.resolve();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(reports).toEqual(["one"]);
      expect(checks).toBe(2);
    } finally {
      first.resolve();
      await reporter.close();
      vi.useRealTimers();
    }
  });

  it.each([["preview", ["preview"]], ["missing", []]] as const)("publishes only to the explicitly selected source (%s)", async (chosen, expected) => {
    vi.useFakeTimers();
    const reports: string[] = [];
    const reporter = new WorkerUsageReporter({ codex: async () => ({ plan: "exhausted", display: {
      plan_remaining_percent: 0, plan_resets_at: null, credits: codexUsage.credits
    } }) }, chosen);
    try {
      for (const [id, host] of [["production", "tzudo.app"], ["preview", "pr-43.tzd.mc-lopez.com"]] as const) {
        reporter.addSource({ id, pollUrl: `https://${host}/api/v1/ai/poll`, async publish() { reports.push(id); } });
      }
      reporter.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(reports).toEqual(expected);
    } finally {
      await reporter.close();
      vi.useRealTimers();
    }
  });
});
