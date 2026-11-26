import { describe, expect, it } from "vitest";
import type { RuntimeQuota } from "../src/runtime-adapter.js";
import { chooseFundingRoute, modelProvider, type Provider, type RuntimePolicy } from "../src/runtime-routing.js";

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

  it.each(["subscriptions-first", "claude-first"] as const)("skips an unavailable Claude plan under %s", async (policy) => {
    await expect(resolve(policy, available, unavailable)).resolves.toBe("codex-plan");
    await expect(resolve(policy, exhausted, unavailable)).resolves.toBe("codex-credits");
  });

  it("requires confirmed Codex exhaustion and a positive credit signal before spending credits", async () => {
    for (const [codex, claude] of [[unknown, exhausted], [unknown, unavailable],
      [{ plan: "exhausted", credits: false }, unavailable],
      [{ plan: "exhausted", credits: false }, exhausted]] satisfies [RuntimeQuota, RuntimeQuota][]) {
      await expect(resolve("subscriptions-first", codex, claude)).rejects.toMatchObject({
        code: "RUNTIME_QUOTA_UNAVAILABLE", retryable: false
      });
    }
    await expect(resolve("subscriptions-first", unknown, available)).resolves.toBe("claude-plan");
  });

  it.each(["subscriptions-first", "claude-first", "subscriptions-only"] as const)(
    "lets Claude try the turn when its account usage cannot be read under %s", async (policy) => {
      await expect(resolve(policy, exhausted, unknown)).resolves.toBe("claude-plan");
      await expect(resolve(policy, unknown, unknown)).resolves.toBe("claude-plan");
      await expect(resolve(policy, available, unknown)).resolves.toBe("codex-plan");
    });

  it("keeps a Claude conversation unless Claude is unavailable", async () => {
    const prefer = (policy: RuntimePolicy, runtime: "codex" | "claude", codex: RuntimeQuota, claude: RuntimeQuota) =>
      chooseFundingRoute({ policy, prefer: runtime, codex: async () => codex, claude: async () => claude });
    await expect(prefer("subscriptions-first", "claude", available, available)).resolves.toBe("claude-plan");
    await expect(prefer("subscriptions-first", "claude", available, unknown)).resolves.toBe("claude-plan");
    await expect(prefer("subscriptions-first", "claude", available, exhausted)).resolves.toBe("claude-plan");
    await expect(prefer("subscriptions-first", "claude", available, unavailable)).resolves.toBe("codex-plan");
    await expect(prefer("claude-first", "codex", available, available)).resolves.toBe("codex-plan");
    await expect(prefer("claude-first", "codex", unknown, available)).resolves.toBe("claude-plan");
    await expect(prefer("subscriptions-first", "codex", exhausted, exhausted)).resolves.toBe("codex-credits");
  });

  it("respects Claude-first and no credit fallback policies", async () => {
    await expect(resolve("claude-first", available, available)).resolves.toBe("claude-plan");
    await expect(resolve("claude-first", available, exhausted)).resolves.toBe("codex-plan");
    await expect(resolve("claude-first", exhausted, exhausted)).resolves.toBe("codex-credits");
    await expect(resolve("subscriptions-only", exhausted, exhausted)).rejects.toMatchObject({ code: "RUNTIME_QUOTA_UNAVAILABLE" });
    await expect(resolve("subscriptions-only", exhausted, unavailable)).rejects.toMatchObject({ code: "RUNTIME_QUOTA_UNAVAILABLE" });
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

describe("model-selected runtime routing", () => {
  function route(policy: RuntimePolicy, requested: Provider, codex: RuntimeQuota, claude: RuntimeQuota) {
    return chooseFundingRoute({ policy, requested, codex: async () => codex, claude: async () => claude });
  }

  it("maps model IDs to their provider", () => {
    expect(["claude-opus-5-5", "sonnet", "opus", "haiku-5"].map(modelProvider)).toEqual(["claude", "claude", "claude", "claude"]);
    expect(["gpt-6.2-sol", "codex", "codex-mini", "o3"].map(modelProvider)).toEqual(["codex", "codex", "codex", "codex"]);
    expect([undefined, "custom-model", "sonnetish"].map(modelProvider)).toEqual([undefined, undefined, undefined]);
  });

  it("runs a Claude model on Claude even when the policy prefers Codex", async () => {
    for (const policy of ["subscriptions-first", "subscriptions-only", "codex-only"] as const) {
      await expect(route(policy, "claude", available, available)).resolves.toBe("claude-plan");
    }
  });

  it("runs a Codex model on Codex even when the policy prefers Claude", async () => {
    for (const policy of ["claude-first", "claude-only"] as const) {
      await expect(route(policy, "codex", available, available)).resolves.toBe("codex-plan");
    }
  });

  it("falls back to Codex under codex-only when the requested Claude plan is not available", async () => {
    for (const claude of [exhausted, unknown, unavailable]) {
      await expect(route("codex-only", "claude", exhausted, claude)).resolves.toBe("codex");
    }
  });

  it("uses the policy's order when the requested Codex plan is exhausted", async () => {
    await expect(route("subscriptions-first", "codex", exhausted, available)).resolves.toBe("claude-plan");
    await expect(route("subscriptions-first", "codex", exhausted, exhausted)).resolves.toBe("codex-credits");
  });

  it("tries a requested Claude model unless Claude is unavailable", async () => {
    await expect(route("subscriptions-first", "claude", available, exhausted)).resolves.toBe("claude-plan");
    await expect(route("subscriptions-first", "claude", available, unknown)).resolves.toBe("claude-plan");
    await expect(route("claude-first", "claude", available, unavailable)).resolves.toBe("codex-plan");
  });

  it("checks each provider at most once", async () => {
    const calls: string[] = [];
    await chooseFundingRoute({ policy: "subscriptions-first", requested: "claude",
      codex: async () => { calls.push("codex"); return exhausted; },
      claude: async () => { calls.push("claude"); return unavailable; } });
    expect(calls).toEqual(["claude", "codex"]);
  });

  it("skips quota checks when the requested provider matches a single-provider policy", async () => {
    const probe = async (): Promise<RuntimeQuota> => { throw new Error("Unexpected quota probe"); };
    await expect(chooseFundingRoute({ policy: "codex-only", requested: "codex", codex: probe, claude: probe })).resolves.toBe("codex");
    await expect(chooseFundingRoute({ policy: "claude-only", requested: "claude", codex: probe, claude: probe })).resolves.toBe("claude");
  });
});
