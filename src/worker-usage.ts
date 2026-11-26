import type { ReadRuntimeQuota } from "./runtime-adapter.js";
import { isProvider, type Provider } from "./runtime-routing.js";

export type UsageCredits =
  | { kind: "amount"; amount: string; unit: "credits" | "USD" }
  | { kind: "disabled" | "unavailable" | "unlimited" };
export interface UsageDisplay {
  plan_remaining_percent: number | null;
  /** When the window that sets plan_remaining_percent resets. */
  plan_resets_at: string | null;
  credits: UsageCredits;
}
export interface PlanWindow { usedPercent: number; resetsAtMs: number | null }

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
type PublishUsage = (providers: ProviderUsage[], signal: AbortSignal) => Promise<void>;
type ReportingSource = { origin: string; publish: PublishUsage };

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

  constructor(private readonly probes: Partial<Record<Provider, ReadRuntimeQuota>>, private readonly sourceId?: string) {}

  addSource(source: { id: string; pollUrl: string; publish: PublishUsage }): void {
    const url = workerUsageEndpoint(source.pollUrl);
    if (!url || this.sources.has(source.id)) return;
    const previous = this.selectedSource();
    this.sources.set(source.id, { origin: url.origin, publish: source.publish });
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
      const quota = await this.probes[provider]?.(signal);
      if (!quota?.display) return;
      const { plan_remaining_percent, plan_resets_at, credits } = quota.display;
      return { provider, plan_remaining_percent, plan_resets_at, credits };
    }));
    const providers = checks.flatMap(check => check.status === "fulfilled" && check.value ? [check.value] : []);
    if (!providers.length || signal.aborted || this.selectedSource() !== source) return;
    await source.publish(providers, signal);
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    this.controller.abort();
    await this.pending;
  }
}
