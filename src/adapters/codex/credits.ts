import { z } from "zod";
import type { AdapterCreditReading, AdapterCredits } from "../../runtime-adapter.js";
import { AppServerCodex } from "./app-server.js";
import type { CodexExecutableLease } from "./update-manager.js";

const windowSchema = z.object({
  usedPercent: z.number().finite().min(0),
  windowDurationMins: z.number().finite().positive().nullish()
});
const bucketSchema = z.object({
  limitId: z.string().nullish(),
  primary: z.unknown().optional(), secondary: z.unknown().optional()
});
const responseSchema = z.object({
  rateLimits: z.unknown().optional(),
  rateLimitsByLimitId: z.record(z.string(), z.unknown()).nullish()
});

export function parseCodexCredits(value: unknown): AdapterCreditReading | null {
  const response = responseSchema.parse(value);
  const mapped = bucketSchema.safeParse(response.rateLimitsByLimitId?.codex);
  const historical = bucketSchema.safeParse(response.rateLimits);
  for (const bucket of [mapped.success && (!mapped.data.limitId || mapped.data.limitId === "codex") ? mapped.data : null,
    historical.success && (!historical.data.limitId || historical.data.limitId === "codex") ? historical.data : null]) {
    if (!bucket) continue;
    const windows = [{ label: "Primary", value: bucket.primary }, { label: "Secondary", value: bucket.secondary }]
      .flatMap(({ label, value }) => {
        const parsed = windowSchema.safeParse(value);
        if (!parsed.success) return [];
        const window = parsed.data;
        return [{ label: window.windowDurationMins ? durationLabel(window.windowDurationMins) : label,
          remaining_percent: Math.max(0, 100 - window.usedPercent) }];
      });
    if (windows.length) return { windows };
  }
  return null;
}

function durationLabel(minutes: number): string {
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/** A quota read owns a short-lived account transport, never a worker or conversation. */
export function createCodexCredits(options: {
  environment: Record<string, string>;
  acquire(): CodexExecutableLease;
}): AdapterCredits {
  let teardownUnconfirmed = false;
  return {
    displayName: "Codex",
    async fetch({ signal }) {
      signal.throwIfAborted();
      if (teardownUnconfirmed) throw new Error("Credit probe shutdown is unconfirmed");
      const lease = options.acquire();
      let client: AppServerCodex;
      try {
        client = new AppServerCodex({
          executablePath: lease.executablePath, environment: options.environment
        });
      } catch (error) { lease.release(); throw error; }
      try {
        const transport = await client.transport(signal);
        return parseCodexCredits(await transport.request("account/rateLimits/read", {
          excludeResetCreditDetails: true
        }, { signal }));
      } finally {
        try { await client.close(); lease.release(); }
        catch { teardownUnconfirmed = true; throw new Error("Credit probe shutdown is unconfirmed"); }
      }
    }
  };
}
