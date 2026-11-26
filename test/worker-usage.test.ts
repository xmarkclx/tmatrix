import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../src/api-client.js";
import { nullLogger } from "../src/logger.js";
import { Metrics } from "../src/metrics.js";
import { WorkerUsageReporter, type ProviderUsage } from "../src/worker-usage.js";
import { deferred, makeConfig } from "./helpers.js";

const codexUsage = {
  provider: "codex", plan_remaining_percent: 0,
  credits: { kind: "amount", amount: "1203.1250001234", unit: "credits" }
} satisfies ProviderUsage;
const claudeUsage = {
  provider: "claude", plan_remaining_percent: 71.5, credits: { kind: "unavailable" }
} satisfies ProviderUsage;
const geminiUsage = {
  provider: "gemini", plan_remaining_percent: 43,
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

  it("rejects generic queue endpoints and never retries an optional report", async () => {
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
        return { plan: "exhausted", display: { plan_remaining_percent: 0, credits: codexUsage.credits } };
      },
      claude: async () => {
        claudeReads += 1;
        return { plan: "unknown", display: { plan_remaining_percent: 71.5, credits: { kind: "unavailable" } } };
      },
      gemini: async () => ({ plan: "unknown", display: {
        plan_remaining_percent: geminiUsage.plan_remaining_percent, credits: geminiUsage.credits
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
      return { plan: "exhausted", display: { plan_remaining_percent: 0, credits: codexUsage.credits } };
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
      plan_remaining_percent: 0, credits: codexUsage.credits
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
