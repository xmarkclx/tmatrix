import { z } from "zod";
import type { RuntimeLike } from "../../runtime-adapter.js";
import { AppServerCodex } from "./app-server.js";

export type CodexQuota = { plan: "available" | "exhausted" | "unknown"; credits: boolean };

const unknownQuota: CodexQuota = { plan: "unknown", credits: false };
const configSchema = z.object({ config: z.object({ model_provider: z.literal("openai").nullish() }) });
const accountSchema = z.object({ account: z.object({ type: z.literal("chatgpt") }) });
const quotaSchema = z.object({
  ordinaryUsageAllowed: z.boolean().nullish(),
  rateLimitsByLimitId: z.object({ codex: z.unknown().optional() }).nullish(),
  rateLimits: z.unknown().optional()
});
const bucketSchema = z.object({
  limitId: z.string().nullish(),
  spendControlReached: z.boolean().nullish(),
  credits: z.object({
    hasCredits: z.boolean(),
    unlimited: z.boolean(),
    balance: z.string().nullable()
  }).nullish()
});

function parseQuota(payload: unknown): CodexQuota {
  const quota = quotaSchema.safeParse(payload);
  if (!quota.success || quota.data.ordinaryUsageAllowed == null) return unknownQuota;
  const plan = quota.data.ordinaryUsageAllowed ? "available" : "exhausted";
  const bucket = bucketSchema.safeParse(quota.data.rateLimitsByLimitId?.codex ?? quota.data.rateLimits);
  if (!bucket.success || (bucket.data.limitId != null && bucket.data.limitId !== "codex") || bucket.data.spendControlReached) {
    return { plan, credits: false };
  }
  const credits = bucket.data.credits;
  const balance = credits?.balance?.trim() ?? "";
  return {
    plan,
    credits: credits?.hasCredits === true && (credits.unlimited || (/^\d+(?:\.\d+)?$/.test(balance) && Number(balance) > 0))
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
    if (!accountSchema.safeParse(account).success) return unknownQuota;
    return parseQuota(await transport.request("account/rateLimits/read", { excludeResetCreditDetails: true }, { signal: probeSignal }));
  } catch {
    signal?.throwIfAborted();
    return unknownQuota;
  }
}
