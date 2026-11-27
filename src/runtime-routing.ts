import { WorkerError } from "./errors.js";
import type { ReadRuntimeQuota, RuntimeFactory, RuntimeQuota } from "./runtime-adapter.js";
import { defaultAccount, probeAccount, type AccountReading, type RuntimeAccount } from "./runtime-accounts.js";
import type { ConversationStore } from "./conversation-store.js";
import type { RuntimeSelection, RuntimeSelectionContext } from "./runner.js";

export type FundingRoute = { provider: string; account: string; funding?: "plan" | "credits" };

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

export function requestedProvider(model: string | undefined): Provider {
  const provider = modelProvider(model);
  if (provider) return provider;
  throw new WorkerError({
    code: "MODEL_PROVIDER_UNKNOWN", stage: "runtime.route",
    message: model === undefined
      ? "This task has no model. Choose a Codex, Claude or Gemini model in Tzu Do AI settings."
      : `Model "${model}" is not a recognized Codex, Claude or Gemini model ID.`
  });
}

export async function chooseFundingRoute({ model, provider, accounts, cursors, signal }: {
  model: string | undefined;
  provider?: string;
  accounts: (provider: string) => Promise<{ readings: AccountReading[]; preferred?: string; pinned?: boolean }>;
  cursors: Map<string, string>;
  signal?: AbortSignal;
}): Promise<FundingRoute> {
  signal?.throwIfAborted();
  provider ??= requestedProvider(model);
  const { readings, preferred, pinned } = await accounts(provider);
  signal?.throwIfAborted();
  const route = (account: string, funding?: FundingRoute["funding"]): FundingRoute =>
    ({ provider, account, ...(funding ? { funding } : {}) });
  const fixed = pinned ? readings.find(({ account }) => account === preferred)
    : readings.length === 1 && readings[0]?.account === defaultAccount ? readings[0] : undefined;
  if (fixed) {
    const { plan, credits } = fixed.quota;
    return route(fixed.account, provider !== "codex" ? undefined
      : plan === "available" ? "plan" : plan === "exhausted" && credits ? "credits" : undefined);
  }

  const loggedIn = readings.filter(({ quota }) => quota.authenticated !== false);
  const usable = loggedIn.filter(({ quota }) => quota.plan !== "exhausted" && usedPercent(quota) !== 100);
  const selected = usable.find(({ account }) => account === preferred) ?? leastUsed(usable, provider, cursors);
  if (selected) return route(selected.account, provider === "codex" && selected.quota.plan === "available" ? "plan" : undefined);
  if (provider === "codex") {
    const credits = loggedIn.filter(({ quota }) => quota.plan === "exhausted" && quota.credits === true);
    const paid = credits.find(({ account }) => account === preferred) ?? leastUsed(credits, provider, cursors);
    return paid ? route(paid.account, "credits") : route(defaultAccount);
  }
  throw new WorkerError({
    code: "PROVIDER_ACCOUNTS_UNAVAILABLE", stage: "runtime.route",
    message: `No signed-in ${isProvider(provider) ? providers[provider].label : provider} account has capacity for this turn.`
  });
}

function usedPercent(quota: RuntimeQuota): number | undefined {
  const remaining = quota.display?.plan_remaining_percent;
  return quota.usedPercent ?? (remaining == null ? undefined : 100 - remaining);
}

function leastUsed(readings: AccountReading[], provider: string, cursors: Map<string, string>): AccountReading | undefined {
  const candidates = [...readings].sort((left, right) => left.account < right.account ? -1 : left.account === right.account ? 0 : 1);
  let best: { reading: AccountReading; used: number } | undefined;
  for (const reading of candidates) {
    const used = usedPercent(reading.quota);
    if (used !== undefined && (!best || used < best.used)) best = { reading, used };
  }
  if (best) return best.reading;
  const cursor = cursors.get(provider);
  const next = (cursor && candidates.find(({ account }) => account > cursor)) || candidates[0];
  if (next) cursors.set(provider, next.account);
  return next;
}

export async function selectAccountRuntime(options: {
  provider: string;
  model: string;
  cwd: string;
  signal: AbortSignal | undefined;
  accounts: RuntimeAccount[];
  cursors: Map<string, string>;
  readQuota: ReadRuntimeQuota | undefined;
  runtimeFactory: RuntimeFactory;
  storeFor: (account: RuntimeAccount) => ConversationStore;
  context: RuntimeSelectionContext;
}): Promise<RuntimeSelection> {
  const { provider, model, cwd, signal, accounts, context } = options;
  const { ticket, history, active, reference, recovering } = context;
  const candidates = accounts.map(account => ({ account, store: options.storeFor(account) }));
  const matching = reference && candidates.find(({ store }) => store.matches(reference));
  const preferred = active?.id === provider ? active.account ?? defaultAccount : reference ? matching?.account.label
    : candidates.find(({ store }) => store.hasHandoff(ticket, history))?.account.label
      ?? await candidates[0]?.store.recordedAccount(ticket);
  const route = await chooseFundingRoute({ model, provider, cursors: options.cursors, ...(signal ? { signal } : {}),
    accounts: async () => ({
      readings: await Promise.all(accounts.map(account => probeAccount(account,
        accounts.length > 1 || provider === "codex" ? options.readQuota : undefined,
        { cwd, model, ...(signal ? { signal } : {}) }))),
      ...(preferred !== undefined ? { preferred } : {}),
      pinned: !active && recovering && matching !== undefined
    })
  });
  const selected = candidates.find(({ account }) => account.label === route.account);
  if (!selected) throw new Error("Selected account is missing from the registry");
  const { account, store } = selected;
  const providerLabel = isProvider(provider) ? providers[provider].label : provider;
  const fundingLabel = route.funding === "plan" ? "Codex subscription" : route.funding === "credits" ? "Codex credits" : providerLabel;
  return {
    id: provider,
    ...(account.directory ? { account: account.label } : {}),
    ...(preferred !== undefined && preferred !== account.label ? { rebuild: true } : {}),
    label: account.directory ? `${fundingLabel} (${account.label})` : fundingLabel,
    conversationStore: store,
    runtimeFactory: account.directory ? (profile, leaseEnvironment) =>
      options.runtimeFactory(profile, leaseEnvironment, account.environment) : options.runtimeFactory
  };
}
