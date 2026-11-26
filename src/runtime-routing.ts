import { WorkerError } from "./errors.js";
import type { RuntimeQuota } from "./runtime-adapter.js";

export type FundingRoute = "codex-plan" | "codex-credits" | "codex" | "claude" | "gemini";

export const providers = {
  codex: { label: "Codex", model: /^(?:gpt-|codex(?:-|$)|o[1-4](?:-|$))/ },
  claude: { label: "Claude", model: /^(?:claude-|sonnet(?:$|-)|opus(?:$|-)|haiku(?:$|-))/ },
  gemini: { label: "Gemini", model: /^gemini-/ }
} as const;
export type Provider = keyof typeof providers;

export function isProvider(id: string): id is Provider {
  return Object.hasOwn(providers, id);
}

export function modelProvider(model: string | undefined): Provider | undefined {
  if (model === undefined) return undefined;
  for (const id in providers) {
    if (isProvider(id) && providers[id].model.test(model)) return id;
  }
  return undefined;
}

export function geminiModel(model: string): string {
  return providers.gemini.model.test(model) ? model : "gemini-4-neon-high";
}

/**
 * Run the requested model on its own provider. Never substitute another model:
 * an unrecognized ID or an unavailable provider fails the turn.
 * Codex uses its plan first, then paid credits. Claude and Gemini use their own
 * account limits and fail clearly when they are spent.
 */
export async function chooseFundingRoute({ model, codex, signal }: {
  model: string | undefined;
  codex: () => Promise<RuntimeQuota>;
  signal?: AbortSignal;
}): Promise<FundingRoute> {
  signal?.throwIfAborted();
  const provider = modelProvider(model);
  if (provider === undefined) {
    throw new WorkerError({
      code: "MODEL_PROVIDER_UNKNOWN", stage: "runtime.route",
      message: model === undefined
        ? "This task has no model. Choose a Codex, Claude or Gemini model in Tzu Do AI settings."
        : `Model "${model}" is not a recognized Codex, Claude or Gemini model ID.`
    });
  }
  if (provider !== "codex") return provider;
  const quota = await codex();
  signal?.throwIfAborted();
  if (quota.plan === "available") return "codex-plan";
  if (quota.plan === "exhausted" && quota.credits === true) return "codex-credits";
  return "codex";
}
