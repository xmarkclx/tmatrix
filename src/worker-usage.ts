import type { Logger } from "pino";
import { defaultAccount, type AccountReading } from "./runtime-accounts.js";
import { isProvider, type Provider } from "./runtime-routing.js";

export type UsageCredits =
  | { kind: "amount"; amount: string; unit: "credits" | "USD" }
  | { kind: "disabled" | "unavailable" | "unlimited" };
export type ResetCadence = "five_hour" | "weekly";
export interface UsageDisplay {
  plan_remaining_percent: number | null;
  /** When the window that sets plan_remaining_percent resets. */
  plan_resets_at: string | null;
  reset_windows?: Partial<Record<ResetCadence, string>>;
  credits: UsageCredits;
}
export interface PlanWindow { usedPercent: number; resetsAtMs: number | null }

const firstExpandedYearMs = Date.UTC(10_000, 0, 1);

export function currentResetTime(value: string | null | undefined, now: number): number | null {
  const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return time > now && time < firstExpandedYearMs ? time : null;
}

export function resetWindowDisplay(windows: readonly { cadence: ResetCadence | null; resetsAtMs: number | null }[]):
  Pick<UsageDisplay, "reset_windows"> {
  const reset_windows: NonNullable<UsageDisplay["reset_windows"]> = {};
  for (const cadence of ["five_hour", "weekly"] as const) {
    const dates = new Set(windows.flatMap(window =>
      window.cadence === cadence && window.resetsAtMs !== null ? [window.resetsAtMs] : []));
    const time = dates.values().next().value;
    if (dates.size === 1 && time !== undefined) reset_windows[cadence] = new Date(time).toISOString();
  }
  return Object.keys(reset_windows).length ? { reset_windows } : {};
}

/** Picks the most-used window. A tie picks the later (or unknown) reset, the earliest the shown percentage can rise. */
export function tightestPlanWindow(windows: PlanWindow[]): PlanWindow | undefined {
  return windows.reduce<PlanWindow | undefined>((tightest, window) => !tightest ||
    window.usedPercent > tightest.usedPercent ||
    (window.usedPercent === tightest.usedPercent && (window.resetsAtMs ?? Infinity) > (tightest.resetsAtMs ?? Infinity))
    ? window : tightest, undefined);
}

export function planResetsAt(window: PlanWindow | undefined): string | null {
  return window?.resetsAtMs == null ? null : new Date(window.resetsAtMs).toISOString();
}
export type ProviderUsage = UsageDisplay & { provider: Provider };
export type AccountUsage = Omit<ProviderUsage, "plan_resets_at"> & { account: string; plan_resets_at?: string | null };
type UsageProbe = (signal: AbortSignal) => Promise<readonly AccountReading[]>;
type PublishUsage = (providers: ProviderUsage[], signal: AbortSignal) => Promise<void>;
type PublishAccountUsage = (accounts: AccountUsage[], signal: AbortSignal) => Promise<"unsupported" | void>;
type ReportingSource = { origin: string; publish: PublishUsage; publishAccounts: PublishAccountUsage };

function providerUsage(provider: Provider, display: UsageDisplay): ProviderUsage {
  const { plan_remaining_percent, plan_resets_at, reset_windows, credits } = display;
  return { provider, plan_remaining_percent, plan_resets_at, ...(reset_windows ? { reset_windows } : {}), credits };
}

function accountSnapshot(accounts: AccountUsage[]): AccountUsage[] {
  const maxAccounts = 64;
  if (accounts.length <= maxAccounts) return accounts;
  const defaults = accounts.filter(({ account }) => account === defaultAccount);
  const extras = accounts.filter(({ account }) => account !== defaultAccount);
  return [...defaults, ...extras.slice(0, maxAccounts - defaults.length)];
}

export function workerUsageEndpoint(pollUrl: string): URL | undefined {
  const url = new URL(pollUrl);
  const trusted = url.hostname === "tzudo.app" || url.hostname === "tzd.mc-lopez.com" ||
    /^pr-[1-9]\d*\.tzd\.mc-lopez\.com$/.test(url.hostname);
  if (!trusted || url.protocol !== "https:" || url.port || url.username || url.password ||
      url.pathname !== "/api/v1/ai/poll" || url.search || url.hash) return;
  return new URL("/api/v1/ai/worker-usage", url.origin);
}

export class WorkerUsageReporter {
  private readonly sources = new Map<string, ReportingSource>();
  private readonly controller = new AbortController();
  private timer?: NodeJS.Timeout;
  private pending: Promise<void> | undefined;
  private accountUsageSupported = true;

  constructor(private readonly probes: Partial<Record<Provider, UsageProbe>>,
    private readonly logger: Pick<Logger, "info">, private readonly sourceId?: string) {}

  addSource(source: Omit<ReportingSource, "origin"> & { id: string; pollUrl: string }): void {
    const url = workerUsageEndpoint(source.pollUrl);
    if (!url || this.sources.has(source.id)) return;
    const previous = this.selectedSource();
    this.sources.set(source.id, { origin: url.origin, publish: source.publish, publishAccounts: source.publishAccounts });
    if (this.timer && !previous) this.refresh();
  }

  private selectedSource(): ReportingSource | undefined {
    if (this.sourceId !== undefined) return this.sources.get(this.sourceId);
    const eligible = [...this.sources.values()].filter(source => source.origin === "https://tzudo.app");
    if (eligible.length === 1) return eligible[0];
  }

  start(): void {
    if (this.timer || this.controller.signal.aborted || !Object.values(this.probes).some(Boolean)) return;
    this.timer = setInterval(() => this.refresh(), 5 * 60_000);
    this.timer.unref();
    this.refresh();
  }

  private refresh(): void {
    const source = this.selectedSource();
    if (this.pending || !source || this.controller.signal.aborted) return;
    this.pending = this.report(source).catch(() => undefined).finally(() => { this.pending = undefined; });
  }

  private async report(source: ReportingSource): Promise<void> {
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(25_000)]);
    const checks = await Promise.allSettled(Object.keys(this.probes).filter(isProvider).map(async provider => {
      const readings = await this.probes[provider]?.(signal) ?? [];
      const byLabel = new Map(readings.map(({ account, quota }) => [account, quota.display]));
      const accounts: AccountUsage[] = [];
      let best: ProviderUsage | undefined;
      for (const account of [...byLabel.keys()].sort()) {
        const display = byLabel.get(account);
        if (!display) {
          accounts.push({ provider, account, plan_remaining_percent: null, credits: { kind: "unavailable" } });
          continue;
        }
        const usage = providerUsage(provider, display);
        accounts.push({ ...usage, account });
        if (!best || (usage.plan_remaining_percent ?? -1) > (best.plan_remaining_percent ?? -1)) best = usage;
      }
      return { best, accounts };
    }));
    const reports = checks.flatMap(check => check.status === "fulfilled" ? [check.value] : []);
    if (signal.aborted || this.selectedSource() !== source) return;
    const providers = reports.flatMap(({ best }) => best ? [best] : []);
    if (providers.length) await source.publish(providers, signal).catch(() => undefined);
    if (!this.accountUsageSupported || signal.aborted || this.selectedSource() !== source) return;
    const accounts = reports.flatMap(report => report.accounts);
    if (accounts.length && await source.publishAccounts(accountSnapshot(accounts), signal) === "unsupported") {
      this.accountUsageSupported = false;
      this.logger.info({ event: "worker_usage.accounts_unsupported" }, "Tzu Do does not support account usage reporting");
    }
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    this.controller.abort();
    await this.pending;
  }
}
