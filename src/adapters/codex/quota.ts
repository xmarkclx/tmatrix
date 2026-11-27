import { z } from "zod";
import type { RuntimeLike, RuntimeQuota } from "../../runtime-adapter.js";
import { planResetsAt, resetWindowDisplay, tightestPlanWindow, type ResetCadence } from "../../worker-usage.js";
import { AppServerCodex } from "./app-server.js";

type CodexQuota = RuntimeQuota & { credits: boolean };

const unknownQuota: CodexQuota = { plan: "unknown", credits: false };
const configSchema = z.object({ config: z.object({ model_provider: z.literal("openai").nullish() }) });
const accountSchema = z.object({ account: z.object({ type: z.literal("chatgpt") }) });
const quotaSchema = z.object({
  ordinaryUsageAllowed: z.boolean().nullish(),
  rateLimitsByLimitId: z.object({ codex: z.unknown().optional() }).nullish(),
  rateLimits: z.unknown().optional()
});
const firstExpandedYearSeconds = Date.UTC(10_000, 0, 1) / 1000;
const planWindowSchema = z.object({
  usedPercent: z.number().min(0).max(100).nullish().catch(null),
  resetsAt: z.number().lt(firstExpandedYearSeconds).nullish().catch(null),
  windowDurationMins: z.number().nullish().catch(null)
});
const cadenceByMinutes = new Map<number, ResetCadence>([[300, "five_hour"], [10_080, "weekly"]]);
const balancePattern = /^\d{1,15}(?:\.\d{1,15})?$/;
const bucketSchema = z.object({
  limitId: z.string().nullish(),
  spendControlReached: z.boolean().nullish(),
  primary: planWindowSchema.nullish().catch(undefined),
  secondary: planWindowSchema.nullish().catch(undefined),
  credits: z.object({
    hasCredits: z.boolean(),
    unlimited: z.boolean(),
    balance: z.string().nullable()
  }).nullish()
});

function parseQuota(payload: unknown): CodexQuota {
  const quota = quotaSchema.safeParse(payload);
  if (!quota.success) return unknownQuota;
  const ordinary = quota.data.ordinaryUsageAllowed;
  const plan = ordinary == null ? "unknown" : ordinary ? "available" : "exhausted";
  const bucket = bucketSchema.safeParse(quota.data.rateLimitsByLimitId?.codex ?? quota.data.rateLimits);
  if (!bucket.success || (bucket.data.limitId != null && bucket.data.limitId !== "codex")) return { plan, credits: false };

  const { primary, secondary, spendControlReached, credits } = bucket.data;
  const balance = credits?.balance?.trim() ?? "";
  const now = Date.now();
  const current = [primary, secondary].flatMap(window => {
    const resetsAtMs = window?.resetsAt == null ? null : window.resetsAt * 1000;
    if (!window || (resetsAtMs !== null && resetsAtMs <= now)) return [];
    return [{ usedPercent: window.usedPercent, resetsAtMs, cadence: cadenceByMinutes.get(window.windowDurationMins ?? 0) ?? null }];
  });
  const measured = current.flatMap(({ usedPercent, resetsAtMs }) => usedPercent != null ? [{ usedPercent, resetsAtMs }] : []);
  const limiting = tightestPlanWindow(measured);
  const remaining = plan === "exhausted" ? 0 : limiting ? 100 - limiting.usedPercent : null;
  return {
    plan,
    credits: ordinary != null && !spendControlReached && credits?.hasCredits === true &&
      (credits.unlimited || (/^\d+(?:\.\d+)?$/.test(balance) && Number(balance) > 0)),
    display: {
      plan_remaining_percent: remaining,
      // An exhausted plan below 100% usage was not set by a window, so its reset is unknown.
      plan_resets_at: plan === "exhausted" && limiting?.usedPercent !== 100 ? null : planResetsAt(limiting),
      ...resetWindowDisplay(current),
      credits: credits?.unlimited === true && credits.hasCredits ? { kind: "unlimited" }
        : balancePattern.test(balance) ? { kind: "amount", amount: balance, unit: "credits" } : { kind: "unavailable" }
    }
  };
}

export async function readCodexQuota(runtime: RuntimeLike, signal?: AbortSignal, workingDirectory?: string): Promise<CodexQuota> {
  if (!(runtime instanceof AppServerCodex)) return unknownQuota;
  signal?.throwIfAborted();
  const deadline = AbortSignal.timeout(8_000);
  const probeSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    const transport = await runtime.transport(probeSignal);
    const config = await transport.request("config/read", { includeLayers: false, cwd: workingDirectory }, { signal: probeSignal });
    if (!configSchema.safeParse(config).success) return unknownQuota;
    const account = await transport.request("account/read", { refreshToken: false }, { signal: probeSignal });
    if (z.object({ account: z.null() }).safeParse(account).success) return { ...unknownQuota, authenticated: false };
    if (!accountSchema.safeParse(account).success) return unknownQuota;
    return parseQuota(await transport.request("account/rateLimits/read", { excludeResetCreditDetails: true }, { signal: probeSignal }));
  } catch {
    signal?.throwIfAborted();
    return unknownQuota;
  }
}
