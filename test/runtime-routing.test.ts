import { describe, expect, it } from "vitest";
import type { RuntimeQuota } from "../src/runtime-adapter.js";
import { chooseFundingRoute, geminiModel, modelProvider } from "../src/runtime-routing.js";

const unexpectedProbe = async (): Promise<RuntimeQuota> => { throw new Error("Unexpected quota probe"); };

function route(model: string | undefined, codex: RuntimeQuota | (() => Promise<RuntimeQuota>) = unexpectedProbe) {
  return chooseFundingRoute({ model, codex: typeof codex === "function" ? codex : async () => codex });
}

describe("exact-model runtime routing", () => {
  it("maps model IDs to their provider", () => {
    expect(["claude-opus-5-5", "sonnet", "opus", "haiku-5"].map(modelProvider)).toEqual(["claude", "claude", "claude", "claude"]);
    expect(["gpt-6.2-sol", "codex", "codex-mini", "o3"].map(modelProvider)).toEqual(["codex", "codex", "codex", "codex"]);
    expect(["gemini-4-neon-high", "gemini-3.8-flash-low"].map(modelProvider)).toEqual(["gemini", "gemini"]);
    expect([undefined, "custom-model", "sonnetish"].map(modelProvider)).toEqual([undefined, undefined, undefined]);
  });

  it("maps direct Neon IDs without rewriting their model setting", () => {
    for (const model of ["gemini-4-neon-high", "gemini-4-neon-low", "gemini-4-neon-medium", "gemini-4-neon-xhigh"]) {
      expect(geminiModel(model)).toBe(model);
    }
    expect(geminiModel("gpt-6.2-sol")).toBe("gemini-4-neon-high");
  });

  it("runs Gemini and Claude models on their own provider without checking Codex", async () => {
    await expect(route("gemini-4-neon-high")).resolves.toBe("gemini");
    await expect(route("claude-opus-5-5")).resolves.toBe("claude");
    await expect(route("sonnet")).resolves.toBe("claude");
  });

  it("runs a Codex model on its plan, then on paid credits", async () => {
    await expect(route("gpt-6.2-sol", { plan: "available", credits: true })).resolves.toBe("codex-plan");
    await expect(route("gpt-6.2-sol", { plan: "exhausted", credits: true })).resolves.toBe("codex-credits");
    await expect(route("gpt-6.2-sol", { plan: "exhausted", credits: false })).resolves.toBe("codex");
    await expect(route("gpt-6.2-sol", { plan: "unknown" })).resolves.toBe("codex");
  });

  it.each([undefined, "custom-model", "deepseek-r2"])("fails instead of guessing a provider for %s", async model => {
    await expect(route(model)).rejects.toMatchObject({ code: "MODEL_PROVIDER_UNKNOWN", retryable: false });
  });

  it("observes cancellation after the Codex account check", async () => {
    const controller = new AbortController();
    const stop = new Error("Fixture stopped");
    await expect(chooseFundingRoute({ model: "gpt-6.2-sol", signal: controller.signal,
      codex: async () => { controller.abort(stop); return { plan: "available" }; } })).rejects.toBe(stop);
  });
});
