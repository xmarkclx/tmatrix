import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readClaudeQuota } from "../src/adapters/claude/quota.js";
import { AppServerCodex } from "../src/adapters/codex/app-server.js";
import { readCodexQuota } from "../src/adapters/codex/quota.js";

const codexScope = "/isolated-project";

async function codexQuota(options: { account?: string; provider?: string; limits: unknown }) {
  const appServer = new AppServerCodex({
    environment: {},
    spawnProcess: () => spawn(process.execPath, ["--eval", `
      const fixture = ${JSON.stringify(options)};
      const readline = require('node:readline').createInterface({input: process.stdin});
      readline.on('line', line => {
        const {id, method, params} = JSON.parse(line);
        if (id === undefined) return;
        let result;
        switch(method) {
          case 'initialize': result = {}; break;
          case 'config/read':
            if (params.cwd !== '${codexScope}') process.exit(2);
            result = {config: {model_provider: fixture.provider ?? null}}; break;
          case 'account/read': result = {account: {type: fixture.account ?? 'chatgpt'}}; break;
          case 'account/rateLimits/read': result = fixture.limits; break;
          default: process.exit(2);
        }
        console.log(JSON.stringify({id, result}));
      });
    `], { detached: process.platform !== "win32" })
  });
  try { return await readCodexQuota(appServer, undefined, codexScope); }
  finally { await appServer.close(); }
}

const credits = { hasCredits: true, unlimited: false, balance: "20.2500012345" };
const exhausted = { ordinaryUsageAllowed: false, rateLimitsByLimitId: { codex: { credits } } };

describe("Codex subscription and purchased credits", () => {
  it("uses explicit plan availability even when rounded percentages appear exhausted", async () => {
    expect(await codexQuota({ limits: {
      ordinaryUsageAllowed: true,
      rateLimits: { primary: { usedPercent: 100, resetsAt: null }, credits }
    } })).toMatchObject({ plan: "available", credits: true, display: {
      plan_remaining_percent: 0, credits: { kind: "amount", amount: "20.2500012345", unit: "credits" }
    } });
  });

  it("keeps exhausted plan and available credits separate", async () => {
    expect(await codexQuota({ limits: exhausted })).toMatchObject({ plan: "exhausted", credits: true, display: {
      plan_remaining_percent: 0, credits: { kind: "amount", amount: "20.2500012345", unit: "credits" }
    } });
  });

  it("reports the tightest current plan window and preserves an exact zero balance", async () => {
    expect(await codexQuota({ limits: {
      ordinaryUsageAllowed: true,
      rateLimits: { primary: { usedPercent: 20 }, secondary: { usedPercent: 59 }, credits: { ...credits, balance: "0.00" } }
    } })).toEqual({ plan: "available", credits: false, display: {
      plan_remaining_percent: 41, credits: { kind: "amount", amount: "0.00", unit: "credits" }
    } });
  });

  it.each([undefined, null, "false"])("does not infer subscription state from percentages or credits without a boolean (%s)", async (permission) => {
    expect(await codexQuota({ limits: {
      ordinaryUsageAllowed: permission,
      rateLimits: { primary: { usedPercent: 0 }, credits }
    } })).toMatchObject({ plan: "unknown", credits: false });
  });

  it.each(["0", "-1", "abc", "0x10", null])("does not infer paid balance from a tracking flag (%s)", async (balance) => {
    expect(await codexQuota({ limits: {
      ordinaryUsageAllowed: false,
      rateLimits: { credits: { ...credits, balance } }
    } })).toMatchObject({ plan: "exhausted", credits: false });
  });

  it("does not use a different provider's allowance or API-key authentication", async () => {
    expect(await codexQuota({ provider: "other", limits: exhausted })).toEqual({ plan: "unknown", credits: false });
    expect(await codexQuota({ account: "apiKey", limits: exhausted })).toEqual({ plan: "unknown", credits: false });
  });

  it("honors a spend-control block despite positive balance", async () => {
    expect(await codexQuota({ limits: {
      ordinaryUsageAllowed: false,
      rateLimits: { spendControlReached: true, credits }
    } })).toMatchObject({ plan: "exhausted", credits: false });
  });
});

async function claudeFixture(options: { auth?: unknown; limits: unknown; replyToOtherRequest?: boolean; hang?: boolean }) {
  const directory = await mkdtemp(join(tmpdir(), "tmatrix-provider-quota-"));
  const executable = join(directory, "claude");
  await writeFile(executable, `#!/usr/bin/env node
const fixture = ${JSON.stringify(options)};
if (process.argv[2] === 'auth') {
  const auth = fixture.auth ?? { loggedIn: true, authMethod: 'claude.ai' };
  console.log(JSON.stringify(auth, null, 2));
  if (!auth.loggedIn) process.exitCode = 1;
} else {
  if (process.env.CLAUDE_CONFIG_DIR === process.cwd() || process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR !== process.cwd()) process.exit(2);
  const readline = require('node:readline').createInterface({input: process.stdin});
  readline.on('line', line => {
    const input = JSON.parse(line);
    if (input.type !== 'control_request' || input.request.subtype !== 'get_usage') process.exit(2);
    if (fixture.hang) { setInterval(() => {}, 1_000); return; }
    console.log(JSON.stringify({type: 'control_response', response: {
      subtype: 'success', request_id: fixture.replyToOtherRequest ? 'other' : input.request_id,
      response: { subscription_type: 'pro', rate_limits_available: true, rate_limits: fixture.limits }
    }}));
  });
}
`, { mode: 0o700 });
  return { executable, directory, async close() { await rm(directory, { recursive: true }); } };
}

function activeWindow(utilization: number) {
  return { utilization, resets_at: new Date(Date.now() + 60_000).toISOString() };
}

const subscriptionLimits = {
  five_hour: activeWindow(20), seven_day: activeWindow(10), extra_usage: { is_enabled: false }
};

describe.skipIf(process.platform === "win32")("Claude subscription quota", () => {
  async function quota(options: Parameters<typeof claudeFixture>[0], selectedModel?: string) {
    const fixture = await claudeFixture(options);
    try {
      return await readClaudeQuota(fixture.executable, { PATH: process.env.PATH ?? "", CLAUDE_CONFIG_DIR: fixture.directory }, undefined, fixture.directory, selectedModel);
    } finally { await fixture.close(); }
  }

  it("reports included usage from a no-prompt control request", async () => {
    expect(await quota({ limits: subscriptionLimits })).toEqual({ plan: "available", display: {
      plan_remaining_percent: 80, credits: { kind: "disabled" }
    } });
  });

  it("reports an exhausted subscription even when Claude's purchased credits are enabled", async () => {
    expect(await quota({ limits: { ...subscriptionLimits, seven_day: activeWindow(100), extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 750 } } })).toEqual({
      plan: "exhausted", display: { plan_remaining_percent: 0, credits: { kind: "unavailable" } }
    });
  });

  it("uses the reported model-specific limits for the selected Claude model", async () => {
    const limits = { ...subscriptionLimits, seven_day_sonnet: activeWindow(100), seven_day_opus: activeWindow(20),
      model_scoped: [{ display_name: "Fable 5", ...activeWindow(100) }] };
    expect(await quota({ limits }, "sonnet")).toMatchObject({ plan: "exhausted", display: { plan_remaining_percent: 80 } });
    expect(await quota({ limits }, "claude-opus-4-7")).toMatchObject({ plan: "available" });
    expect(await quota({ limits }, "claude-fable-5")).toMatchObject({ plan: "exhausted" });
  });

  it.each([null, { is_enabled: true }])("refuses to select a plan from unknown or enabled overage settings (%j)", async (extra_usage) => {
    expect(await quota({ limits: { ...subscriptionLimits, extra_usage } })).toMatchObject({ plan: "unknown" });
  });

  it("keeps stale and unmatched response data unknown", async () => {
    expect(await quota({ limits: { ...subscriptionLimits, five_hour: { utilization: 100, resets_at: "2000-01-01T00:00:00.000Z" } } })).toMatchObject({ plan: "unknown" });
    expect(await quota({ limits: subscriptionLimits, replyToOtherRequest: true })).toMatchObject({ plan: "unknown" });
  });

  it("identifies signed-out and API-key sessions without selecting a plan", async () => {
    expect(await quota({ auth: { loggedIn: false, authMethod: "none" }, limits: subscriptionLimits })).toEqual({ plan: "unavailable" });
    expect(await quota({ auth: { loggedIn: true, authMethod: "api_key" }, limits: subscriptionLimits })).toEqual({ plan: "unavailable" });
  });

  it.each(["free", null])("classifies a signed-in Claude account with subscription type %j as unavailable", async (subscriptionType) => {
    const auth = { loggedIn: true, authMethod: "claude.ai", subscriptionType };
    expect(await quota({ auth, limits: null })).toEqual({ plan: "unavailable" });
  });

  it("keeps a failed authentication probe unknown", async () => {
    const fixture = await claudeFixture({ limits: subscriptionLimits });
    try {
      const executable = join(fixture.directory, "missing-claude");
      expect(await readClaudeQuota(executable, { PATH: process.env.PATH ?? "" }, undefined, fixture.directory)).toEqual({ plan: "unknown" });
    } finally { await fixture.close(); }
  });

  it("propagates cancellation while a probe is waiting", async () => {
    const fixture = await claudeFixture({ limits: subscriptionLimits, hang: true });
    const signal = AbortSignal.timeout(1_000);
    try {
      await expect(readClaudeQuota(fixture.executable, { PATH: process.env.PATH ?? "", CLAUDE_CONFIG_DIR: fixture.directory }, signal, fixture.directory)).rejects.toMatchObject({ name: "TimeoutError" });
    } finally {
      await fixture.close();
    }
  });
});
