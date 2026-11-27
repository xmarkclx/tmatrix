import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeAdapter, RuntimeQuota } from "../src/runtime-adapter.js";
import { probeAccount, scanAccounts, type AccountReading } from "../src/runtime-accounts.js";
import { chooseFundingRoute, geminiModel, modelProvider } from "../src/runtime-routing.js";

const unexpectedProbe = async (): Promise<RuntimeQuota> => { throw new Error("Unexpected quota probe"); };

function route(model: string | undefined, codex: RuntimeQuota | (() => Promise<RuntimeQuota>) = unexpectedProbe) {
  return chooseFundingRoute({ model, cursors: new Map(), accounts: async provider => ({
    readings: [{ account: "default", quota: provider !== "codex" ? { plan: "unknown" }
      : typeof codex === "function" ? await codex() : codex }]
  }) });
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
    await expect(route("gemini-4-neon-high")).resolves.toEqual({ provider: "gemini", account: "default" });
    await expect(route("claude-opus-5-5")).resolves.toEqual({ provider: "claude", account: "default" });
    await expect(route("sonnet")).resolves.toEqual({ provider: "claude", account: "default" });
  });

  it("runs a Codex model on its plan, then on paid credits", async () => {
    await expect(route("gpt-6.2-sol", { plan: "available", credits: true })).resolves.toEqual({
      provider: "codex", account: "default", funding: "plan"
    });
    await expect(route("gpt-6.2-sol", { plan: "exhausted", credits: true })).resolves.toEqual({
      provider: "codex", account: "default", funding: "credits"
    });
    await expect(route("gpt-6.2-sol", { plan: "exhausted", credits: false })).resolves.toEqual({ provider: "codex", account: "default" });
    await expect(route("gpt-6.2-sol", { plan: "unknown" })).resolves.toEqual({ provider: "codex", account: "default" });
  });

  it.each([undefined, "custom-model", "deepseek-r2"])("fails instead of guessing a provider for %s", async model => {
    await expect(route(model)).rejects.toMatchObject({ code: "MODEL_PROVIDER_UNKNOWN", retryable: false });
  });

  it("observes cancellation after the Codex account check", async () => {
    const controller = new AbortController();
    const stop = new Error("Fixture stopped");
    await expect(chooseFundingRoute({ model: "gpt-6.2-sol", signal: controller.signal, cursors: new Map(),
      accounts: async () => { controller.abort(stop); return { readings: [] }; } })).rejects.toBe(stop);
  });
});

function reading(account: string, quota: RuntimeQuota): AccountReading {
  return { account, quota };
}

function measured(account: string, remaining: number): AccountReading {
  return reading(account, {
    plan: "available",
    display: { plan_remaining_percent: remaining, plan_resets_at: null, credits: { kind: "disabled" } }
  });
}

describe("account funding", () => {
  it("discovers newly added accounts in a custom config directory", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "tmatrix-account-registry-"));
    const environment = { EXAMPLE_HOME: "/fixture/default" };
    const adapter: RuntimeAdapter = {
      apiVersion: 1, id: "example",
      create() { throw new Error("Scanning should not start a runtime"); },
      accounts: {
        environment: (dir, base) => ({ ...base, EXAMPLE_HOME: dir }),
        home: env => env.EXAMPLE_HOME ?? "",
        login: () => ({ executable: "example", args: ["login"] })
      }
    };
    try {
      const root = join(configDir, "accounts", adapter.id);
      await expect(scanAccounts(configDir, adapter, environment)).resolves.toEqual([{ label: "default", environment }]);
      const work = join(root, "work");
      await Promise.all([work, join(root, "default"), join(root, "INVALID")].map(path => mkdir(path, { recursive: true })));
      await writeFile(join(root, "file"), "");
      await expect(scanAccounts(configDir, adapter, environment)).resolves.toEqual([
        { label: "default", environment }, { label: "work", directory: work, environment: { EXAMPLE_HOME: work } }
      ]);
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it("picks the least-used measured account and breaks ties by label", async () => {
    const readings = [reading("default", { plan: "unknown" }), measured("work", 80), measured("backup", 60), measured("personal", 80)];
    await expect(chooseFundingRoute({ model: "gemini-4-neon-low", cursors: new Map(),
      accounts: async () => ({ readings }) })).resolves.toEqual({ provider: "gemini", account: "personal" });
  });

  it("skips exhausted and signed-out accounts", async () => {
    const readings = [reading("default", { plan: "exhausted", usedPercent: 100 }),
      reading("signed-out", { plan: "unavailable", authenticated: false }), measured("work", 10)];
    await expect(chooseFundingRoute({ model: "sonnet", cursors: new Map(),
      accounts: async () => ({ readings, preferred: "default" }) })).resolves.toEqual({ provider: "claude", account: "work" });
  });

  it("uses all Codex subscription plans before using any account's credits", async () => {
    const exhausted = reading("default", { plan: "exhausted", credits: true });
    const choose = (readings: AccountReading[]) => chooseFundingRoute({
      model: "gpt-6.2-sol", cursors: new Map(), accounts: async () => ({ readings, preferred: "default" })
    });
    await expect(choose([exhausted, measured("work", 40), measured("backup", 10)])).resolves.toEqual({
      provider: "codex", account: "work", funding: "plan"
    });
    await expect(choose([exhausted, reading("work", { plan: "unknown" })])).resolves.toEqual({ provider: "codex", account: "work" });
    await expect(choose([exhausted, reading("work", { plan: "exhausted", credits: false })])).resolves.toEqual({
      provider: "codex", account: "default", funding: "credits"
    });
  });

  it("probes accounts concurrently and rotates after stalled reads", async () => {
    const cursors = new Map<string, string>();
    const started: string[] = [];
    const choose = () => chooseFundingRoute({
      model: "sonnet", cursors, accounts: async () => ({
        readings: await Promise.all(["default", "work"].map(label => probeAccount({ label, environment: {} },
          async () => {
            started.push(label);
            return new Promise<RuntimeQuota>(() => undefined);
          }, { timeoutMs: 20 })))
      })
    });
    const first = choose();
    await Promise.resolve();
    expect(started).toEqual(["default", "work"]);
    await expect(first).resolves.toEqual({ provider: "claude", account: "default" });
    await expect(choose()).resolves.toEqual({ provider: "claude", account: "work" });
    await expect(choose()).resolves.toEqual({ provider: "claude", account: "default" });
  });
});
