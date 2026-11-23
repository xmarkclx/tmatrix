import type { ReadRuntimeQuota } from "./runtime-adapter.js";

export type UsageProvider = "codex" | "claude";
export type UsageCredits =
  | { kind: "amount"; amount: string; unit: "credits" | "USD" }
  | { kind: "disabled" | "unavailable" | "unlimited" };
export interface UsageDisplay {
  plan_remaining_percent: number | null;
  credits: UsageCredits;
}
export type ProviderUsage = UsageDisplay & { provider: UsageProvider };
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

  constructor(private readonly probes: Partial<Record<UsageProvider, ReadRuntimeQuota>>, private readonly sourceId?: string) {}

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
    const checks = await Promise.allSettled((["codex", "claude"] satisfies UsageProvider[]).map(async provider => {
      const quota = await this.probes[provider]?.(signal);
      if (!quota?.display) return;
      const { plan_remaining_percent, credits } = quota.display;
      return { provider, plan_remaining_percent, credits };
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
