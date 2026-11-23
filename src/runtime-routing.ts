import { z } from "zod";
import { WorkerError } from "./errors.js";
import type { RuntimeQuota } from "./runtime-adapter.js";

export const runtimePolicySchema = z.enum([
  "subscriptions-first", "claude-first", "subscriptions-only", "codex-only", "claude-only"
]);
export type RuntimePolicy = z.infer<typeof runtimePolicySchema>;
export const defaultRuntimePolicy: RuntimePolicy = "subscriptions-first";
export type FundingRoute = "codex-plan" | "claude-plan" | "codex-credits" | "codex" | "claude";

const planOrder = {
  "subscriptions-first": ["codex-plan", "claude-plan"],
  "claude-first": ["claude-plan", "codex-plan"],
  "subscriptions-only": ["codex-plan", "claude-plan"]
} as const;

export async function chooseFundingRoute({ policy, codex, claude, signal }: {
  policy: RuntimePolicy;
  codex: () => Promise<RuntimeQuota>;
  claude: () => Promise<RuntimeQuota>;
  signal?: AbortSignal;
}): Promise<FundingRoute> {
  signal?.throwIfAborted();
  if (policy === "codex-only") return "codex";
  if (policy === "claude-only") return "claude";

  let codexQuota: RuntimeQuota | undefined;
  let claudeQuota: RuntimeQuota | undefined;
  for (const route of planOrder[policy]) {
    if (route === "codex-plan") {
      codexQuota = await codex();
      signal?.throwIfAborted();
      if (codexQuota.plan === "available") return route;
    } else {
      claudeQuota = await claude();
      signal?.throwIfAborted();
      if (claudeQuota.plan === "available") return route;
    }
  }

  if (policy !== "subscriptions-only" && codexQuota?.plan === "exhausted" &&
      claudeQuota?.plan === "exhausted" && codexQuota.credits === true) {
    return "codex-credits";
  }

  const message = claudeQuota?.plan === "unavailable"
    ? "No verified Codex plan allowance. Install Claude Code and sign in with a subscription to use Claude fallback."
    : claudeQuota?.plan === "unknown" || codexQuota?.plan === "unknown"
      ? "Provider plan usage could not be verified. Check both sign-ins and turn off Claude Usage credits for automatic routing."
      : "No included allowance is available under the selected routing policy.";
  throw new WorkerError({ code: "RUNTIME_QUOTA_UNAVAILABLE", stage: "runtime.route", message });
}
