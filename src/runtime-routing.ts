import { z } from "zod";
import { WorkerError } from "./errors.js";
import type { RuntimeQuota } from "./runtime-adapter.js";

export const runtimePolicySchema = z.enum([
  "subscriptions-first", "claude-first", "subscriptions-only", "codex-only", "claude-only"
]);
export type RuntimePolicy = z.infer<typeof runtimePolicySchema>;
export const defaultRuntimePolicy: RuntimePolicy = "subscriptions-first";
export type FundingRoute = "codex-plan" | "claude-plan" | "codex-credits" | "codex" | "claude";
export type Provider = "codex" | "claude";

/** The provider an explicit model ID belongs to, or undefined when the ID names neither. */
export function modelProvider(model: string | undefined): Provider | undefined {
  if (model === undefined) return undefined;
  if (/^(?:claude-|sonnet(?:$|-)|opus(?:$|-)|haiku(?:$|-))/.test(model)) return "claude";
  if (/^(?:gpt-|codex(?:-|$)|o[1-4](?:-|$))/.test(model)) return "codex";
  return undefined;
}

function once<T>(probe: () => Promise<T>): () => Promise<T> {
  let result: Promise<T> | undefined;
  return () => (result ??= probe());
}

const planOrder = {
  "subscriptions-first": ["codex-plan", "claude-plan"],
  "claude-first": ["claude-plan", "codex-plan"],
  "subscriptions-only": ["codex-plan", "claude-plan"]
} as const;

/**
 * The requested model's provider runs first on its included plan; next the runtime that
 * holds the ticket's conversation; then the policy decides the fallback.
 * Without a recognizable model, the policy alone decides.
 */
export async function chooseFundingRoute({ policy, requested, prefer, signal, ...probes }: {
  policy: RuntimePolicy;
  requested?: Provider | undefined;
  /** Runtime that holds this ticket's conversation; kept while its plan is not confirmed spent. */
  prefer?: Provider | undefined;
  codex: () => Promise<RuntimeQuota>;
  claude: () => Promise<RuntimeQuota>;
  signal?: AbortSignal;
}): Promise<FundingRoute> {
  signal?.throwIfAborted();
  const codex = once(probes.codex);
  const claude = once(probes.claude);
  if (requested !== undefined && policy !== `${requested}-only`) {
    const quota = await (requested === "codex" ? codex() : claude());
    signal?.throwIfAborted();
    if (quota.plan === "available") return `${requested}-plan`;
    // An explicitly chosen Claude model still runs when Claude's usage report is unreadable.
    if (requested === "claude" && quota.plan === "unknown" && policy !== "codex-only") return "claude-plan";
  }
  if (policy === "codex-only") return "codex";
  if (policy === "claude-only") return "claude";

  let codexQuota: RuntimeQuota | undefined;
  let claudeQuota: RuntimeQuota | undefined;
  const preferred: FundingRoute | undefined = prefer === "codex" ? "codex-plan" : prefer === "claude" ? "claude-plan" : undefined;
  const order = preferred ? [preferred, ...planOrder[policy].filter(route => route !== preferred)] : planOrder[policy];
  for (const route of order) {
    if (route === "codex-plan") {
      codexQuota = await codex();
      signal?.throwIfAborted();
      if (codexQuota.plan === "available") return route;
    } else {
      claudeQuota = await claude();
      signal?.throwIfAborted();
      if (claudeQuota.plan === "available") return route;
      // Resuming the saved Claude conversation beats switching runtimes on an unreadable usage report.
      if (route === preferred && claudeQuota.plan === "unknown") return route;
    }
  }

  if (policy !== "subscriptions-only" && codexQuota?.plan === "exhausted" &&
      (claudeQuota?.plan === "exhausted" || claudeQuota?.plan === "unavailable") && codexQuota.credits === true) {
    return "codex-credits";
  }

  // Claude's account report is often unreadable (expired probe, usage credits on). Let Claude try the turn; it fails clearly if the plan is spent.
  if (claudeQuota?.plan === "unknown") return "claude-plan";

  const message = codexQuota?.plan === "unknown"
    ? "Codex plan usage could not be verified and no Claude subscription is available. Check the Codex sign-in."
    : policy !== "subscriptions-only" && codexQuota?.plan === "exhausted"
      ? "No included allowance is available. Check your Codex credit balance or Claude subscription."
      : "No included allowance is available under the selected routing policy.";
  throw new WorkerError({ code: "RUNTIME_QUOTA_UNAVAILABLE", stage: "runtime.route", message });
}
