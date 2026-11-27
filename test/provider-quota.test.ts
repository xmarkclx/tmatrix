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
    const resetsAt = Math.floor(Date.now() / 1000) + 3_600;
    const fiveHourReset = new Date((resetsAt + 3_600) * 1000).toISOString();
    const weeklyReset = new Date(resetsAt * 1000).toISOString();
    expect(await codexQuota({ limits: {
      ordinaryUsageAllowed: true,
      rateLimits: {
        primary: { usedPercent: 20, resetsAt, windowDurationMins: 10_080 },
        secondary: { usedPercent: 59, resetsAt: resetsAt + 3_600, windowDurationMins: 300 },
        credits: { ...credits, balance: "0.00" }
      }
    } })).toEqual({ plan: "available", credits: false, display: {
      plan_remaining_percent: 41, plan_resets_at: fiveHourReset,
      plan_windows: { five_hour: 41, weekly: 80 },
      reset_windows: { five_hour: fiveHourReset, weekly: weeklyReset },
      credits: { kind: "amount", amount: "0.00", unit: "credits" }
    } });
  });

  it.each([undefined, null, 360, "300"])("keeps the limiting reset when its duration is %j", async windowDurationMins => {
    expect(await codexQuota({ limits: { ordinaryUsageAllowed: true, rateLimits: {
      primary: { usedPercent: 59, resetsAt: 1_893_456_000, windowDurationMins },
      secondary: { usedPercent: 20, resetsAt: 1_893_542_400, windowDurationMins: 10_080 }
    } } })).toEqual({ plan: "available", credits: false, display: {
      plan_remaining_percent: 41, plan_resets_at: "2030-01-01T00:00:00.000Z",
      plan_windows: { weekly: 80 },
      reset_windows: { weekly: "2030-01-02T00:00:00.000Z" }, credits: { kind: "unavailable" }
    } });
  });

  it("reports a recognized Codex reset even when utilization is unavailable", async () => {
    expect(await codexQuota({ limits: { rateLimits: {
      primary: { usedPercent: null, resetsAt: 1_893_456_000, windowDurationMins: 300 }
    } } })).toEqual({ plan: "unknown", credits: false, display: {
      plan_remaining_percent: null, plan_resets_at: null, credits: { kind: "unavailable" },
      reset_windows: { five_hour: "2030-01-01T00:00:00.000Z" }
    } });
  });

  it("reports no reset when it cannot explain the shown percentage", async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    expect(await codexQuota({ limits: {
      ordinaryUsageAllowed: true,
      rateLimits: { primary: { usedPercent: 80, resetsAt }, secondary: { usedPercent: 80, resetsAt: null } }
    } })).toMatchObject({ display: { plan_remaining_percent: 20, plan_resets_at: null } });
    expect(await codexQuota({ limits: {
      ordinaryUsageAllowed: false,
      rateLimits: { primary: { usedPercent: 100, resetsAt, windowDurationMins: 300 } }
    } })).toMatchObject({ display: {
      plan_remaining_percent: 0, plan_resets_at: new Date(resetsAt * 1000).toISOString(),
      plan_windows: { five_hour: 0 }
    } });
  });

  it("omits plan windows when exhaustion occurs below 100% usage", async () => {
    expect(await codexQuota({ limits: {
      ordinaryUsageAllowed: false,
      rateLimits: {
        primary: { usedPercent: 40, resetsAt: 1_893_456_000, windowDurationMins: 300 },
        secondary: { usedPercent: 70, resetsAt: 1_893_542_400, windowDurationMins: 10_080 }
      }
    } })).toEqual({ plan: "exhausted", credits: false, display: {
      plan_remaining_percent: 0, plan_resets_at: null,
      reset_windows: { five_hour: "2030-01-01T00:00:00.000Z", weekly: "2030-01-02T00:00:00.000Z" },
      credits: { kind: "unavailable" }
    } });
  });

  it("reports the later reset when windows are equally used", async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    expect(await codexQuota({ limits: {
      ordinaryUsageAllowed: true,
      rateLimits: { primary: { usedPercent: 30, resetsAt }, secondary: { usedPercent: 30, resetsAt: resetsAt + 7200 } }
    } })).toMatchObject({ display: { plan_remaining_percent: 70, plan_resets_at: new Date((resetsAt + 7200) * 1000).toISOString() } });
  });

  it.each([1e12, 1e20])("preserves usage and credits when reset seconds %s cannot be reported", async (resetsAt) => {
    expect(await codexQuota({ limits: {
      ordinaryUsageAllowed: true,
      rateLimits: { primary: { usedPercent: 80, resetsAt, windowDurationMins: 300 }, credits }
    } })).toEqual({ plan: "available", credits: true, display: {
      plan_remaining_percent: 20, plan_resets_at: null,
      plan_windows: { five_hour: 20 },
      credits: { kind: "amount", amount: "20.2500012345", unit: "credits" }
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

async function claudeFixture(options: { auth?: unknown; authExitCode?: number; limits: unknown; replyToOtherRequest?: boolean; hang?: boolean }) {
  const directory = await mkdtemp(join(tmpdir(), "tmatrix-provider-quota-"));
  const executable = join(directory, "claude");
  await writeFile(executable, `#!/usr/bin/env node
const fixture = ${JSON.stringify(options)};
if (process.argv[2] === 'auth') {
  const auth = fixture.auth ?? { loggedIn: true, authMethod: 'claude.ai' };
  console.log(JSON.stringify(auth, null, 2));
  process.exitCode = fixture.authExitCode ?? (auth.loggedIn ? 0 : 1);
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

function activeWindow(utilization: number, resetsInMs = 60_000) {
  return { utilization, resets_at: new Date(Date.now() + resetsInMs).toISOString() };
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
      plan_remaining_percent: 80, plan_resets_at: subscriptionLimits.five_hour.resets_at, credits: { kind: "disabled" },
      plan_windows: { five_hour: 80, weekly: 90 },
      reset_windows: { five_hour: subscriptionLimits.five_hour.resets_at, weekly: subscriptionLimits.seven_day.resets_at }
    } });
  });

  it("reports included usage before the five-hour session starts", async () => {
    const seven_day = activeWindow(17);
    const limits = {
      ...subscriptionLimits,
      five_hour: { utilization: 0, resets_at: null },
      seven_day
    };
    expect(await quota({ limits }, "claude-opus-5-5")).toEqual({
      plan: "available", display: {
        plan_remaining_percent: 83, plan_resets_at: seven_day.resets_at, credits: { kind: "disabled" },
        plan_windows: { five_hour: 100, weekly: 83 },
        reset_windows: { weekly: seven_day.resets_at }
      }
    });
  });

  it("reports an exhausted subscription even when Claude's purchased credits are enabled", async () => {
    const seven_day = activeWindow(100, 3 * 86_400_000);
    expect(await quota({ limits: { ...subscriptionLimits, seven_day, extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 750 } } })).toEqual({
      plan: "exhausted", display: {
        plan_remaining_percent: 0, plan_resets_at: seven_day.resets_at, credits: { kind: "unavailable" },
        plan_windows: { five_hour: 80, weekly: 0 },
        reset_windows: { five_hour: subscriptionLimits.five_hour.resets_at, weekly: seven_day.resets_at }
      }
    });
  });

  it.each([null, undefined, "unknown"])("reports no limiting reset when an exhausted account window resets at %j", async resets_at => {
    const five_hour = activeWindow(100);
    expect(await quota({ limits: {
      five_hour,
      seven_day: { utilization: 100, resets_at },
      extra_usage: { is_enabled: false }
    } })).toEqual({ plan: "exhausted", display: {
      plan_remaining_percent: 0, plan_resets_at: null, credits: { kind: "disabled" },
      plan_windows: { five_hour: 0 },
      reset_windows: { five_hour: five_hour.resets_at }
    } });
  });

  it.each([
    { utilization: 100, resets_at: "2000-01-01T00:00:00.000Z" },
    { utilization: 90, resets_at: null }
  ])("reports the current exhausted account reset when the other window is %j", async (seven_day) => {
    const five_hour = activeWindow(100);
    expect(await quota({ limits: { five_hour, seven_day, extra_usage: { is_enabled: false } } })).toEqual({
      plan: "exhausted", display: {
        plan_remaining_percent: 0, plan_resets_at: five_hour.resets_at, credits: { kind: "disabled" },
        plan_windows: { five_hour: 0 },
        reset_windows: { five_hour: five_hour.resets_at }
      }
    });
  });

  it("uses the reported model-specific limits for the selected Claude model", async () => {
    const limits = { ...subscriptionLimits, seven_day_sonnet: activeWindow(100), seven_day_opus: activeWindow(20),
      model_scoped: [{ display_name: "Fable 5", ...activeWindow(100) }] };
    expect(await quota({ limits }, "sonnet")).toMatchObject({ plan: "exhausted", display: { plan_remaining_percent: 80 } });
    expect(await quota({ limits }, "claude-opus-4-7")).toMatchObject({ plan: "available" });
    expect(await quota({ limits }, "claude-fable-5")).toMatchObject({ plan: "exhausted" });
  });

  it("keeps a usable account reset when the other reset is invalid and does not relabel model-scoped windows", async () => {
    expect(await quota({ limits: {
      five_hour: { utilization: 20, resets_at: "2030-01-01T08:00:00+08:00" },
      seven_day: { utilization: 20, resets_at: "unknown" },
      seven_day_sonnet: activeWindow(100),
      model_scoped: [{ display_name: "Sonnet", ...activeWindow(100) }],
      extra_usage: { is_enabled: false }
    } })).toEqual({ plan: "exhausted", display: {
      plan_remaining_percent: null, plan_resets_at: null, credits: { kind: "disabled" },
      reset_windows: { five_hour: "2030-01-01T00:00:00.000Z" }
    } });
  });

  it.each([null, undefined])("reports Claude's account deadlines and omits plan windows when utilization is %j", async utilization => {
    expect(await quota({ limits: {
      five_hour: { utilization, resets_at: "2030-01-01T00:00:00Z" },
      seven_day: { utilization: 20, resets_at: "2030-01-02T00:00:00Z" },
      extra_usage: { is_enabled: false }
    } })).toEqual({ plan: "unknown", display: {
      plan_remaining_percent: null, plan_resets_at: null, credits: { kind: "disabled" },
      reset_windows: { five_hour: "2030-01-01T00:00:00.000Z", weekly: "2030-01-02T00:00:00.000Z" }
    } });
  });

  it.each([null, { is_enabled: true }])("refuses to select a plan from unknown or enabled overage settings (%j)", async (extra_usage) => {
    expect(await quota({ limits: { ...subscriptionLimits, extra_usage } })).toMatchObject({ plan: "unknown" });
  });

  it("keeps stale and unmatched response data unknown", async () => {
    expect(await quota({ limits: { ...subscriptionLimits, five_hour: { utilization: 100, resets_at: "2000-01-01T00:00:00.000Z" } } })).toMatchObject({ plan: "unknown" });
    expect(await quota({ limits: subscriptionLimits, replyToOtherRequest: true })).toMatchObject({ plan: "unknown" });
  });

  it("identifies a confirmed signed-out session", async () => {
    expect(await quota({ auth: { loggedIn: false, authMethod: "none" }, limits: subscriptionLimits })).toEqual({ plan: "unavailable" });
  });

  it.each(["api_key", "api_key_helper", "third_party"])("identifies %s as a non-subscription session", async (authMethod) => {
    expect(await quota({ auth: { loggedIn: true, authMethod }, limits: subscriptionLimits })).toEqual({ plan: "unavailable" });
  });

  it.each(["oauth_token", "future_method"])("keeps an unverified %s session unknown", async (authMethod) => {
    expect(await quota({ auth: { loggedIn: true, authMethod }, limits: subscriptionLimits })).toEqual({ plan: "unknown" });
  });

  it("keeps a successful auth command reporting no login unknown", async () => {
    const auth = { loggedIn: false, authMethod: "none" };
    expect(await quota({ auth, authExitCode: 0, limits: subscriptionLimits })).toEqual({ plan: "unknown" });
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
