import { describe, expect, it } from "vitest";
import type { RuntimeQuota } from "../src/runtime-adapter.js";
import { chooseFundingRoute, type RuntimePolicy } from "../src/runtime-routing.js";

const available = { plan: "available", credits: true } satisfies RuntimeQuota;
const exhausted = { plan: "exhausted", credits: true } satisfies RuntimeQuota;
const unknown = { plan: "unknown", credits: true } satisfies RuntimeQuota;
const unavailable = { plan: "unavailable" } satisfies RuntimeQuota;

function resolve(policy: RuntimePolicy, codex: RuntimeQuota, claude: RuntimeQuota) {
  return chooseFundingRoute({ policy, codex: async () => codex, claude: async () => claude });
}

describe("subscription-first runtime routing", () => {
  it("selects included Codex, then included Claude, then Codex credits", async () => {
    await expect(resolve("subscriptions-first", available, available)).resolves.toBe("codex-plan");
    await expect(resolve("subscriptions-first", exhausted, available)).resolves.toBe("claude-plan");
    await expect(resolve("subscriptions-first", exhausted, exhausted)).resolves.toBe("codex-credits");
  });

  it("requires confirmed exhaustion of both subscriptions and a positive credit signal", async () => {
    for (const [codex, claude] of [[unknown, exhausted], [exhausted, unknown],
      [exhausted, unavailable], [{ plan: "exhausted", credits: false }, exhausted]] satisfies [RuntimeQuota, RuntimeQuota][]) {
      await expect(resolve("subscriptions-first", codex, claude)).rejects.toMatchObject({
        code: "RUNTIME_QUOTA_UNAVAILABLE", retryable: false
      });
    }
    await expect(resolve("subscriptions-first", unknown, available)).resolves.toBe("claude-plan");
  });

  it("respects Claude-first and no credit fallback policies", async () => {
    await expect(resolve("claude-first", available, available)).resolves.toBe("claude-plan");
    await expect(resolve("claude-first", available, exhausted)).resolves.toBe("codex-plan");
    await expect(resolve("claude-first", exhausted, exhausted)).resolves.toBe("codex-credits");
    await expect(resolve("subscriptions-only", exhausted, exhausted)).rejects.toMatchObject({ code: "RUNTIME_QUOTA_UNAVAILABLE" });
  });

  it("allows a directly selected provider without automatic funding checks", async () => {
    const probe = async (): Promise<RuntimeQuota> => { throw new Error("Unexpected quota probe"); };
    await expect(chooseFundingRoute({ policy: "codex-only", codex: probe, claude: probe })).resolves.toBe("codex");
    await expect(chooseFundingRoute({ policy: "claude-only", codex: probe, claude: probe })).resolves.toBe("claude");
  });

  it("observes cancellation after an account check and before choosing a runtime", async () => {
    const controller = new AbortController();
    const stop = new Error("Fixture stopped");
    const codex = async () => { controller.abort(stop); return available; };
    await expect(chooseFundingRoute({ policy: "subscriptions-first", codex, claude: async () => available,
      signal: controller.signal })).rejects.toBe(stop);
  });
});
