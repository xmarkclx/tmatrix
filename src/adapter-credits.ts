import { z } from "zod";
import type { AdapterCreditControl, AdapterCredits, AdapterCreditStatus } from "./runtime-adapter.js";

export const ADAPTER_CREDIT_INTERVAL_MS = 60_000;
const safeLabel = z.string().trim().min(1).max(48).regex(/^[^\u0000-\u001f\u007f-\u009f]*$/u);
export const adapterCreditReadingSchema = z.object({
  windows: z.array(z.object({ label: safeLabel, remaining_percent: z.number().finite().min(0).max(100) })).max(4)
});
const capabilitySchema = z.object({ displayName: safeLabel, fetch: z.function() });
interface Options { intervalMs?: number; timeoutMs?: number; closeTimeoutMs?: number; now?: () => number }
interface Flight { controller: AbortController; result: Promise<void>; settled: Promise<void> }

/** Owns reporting only. A cancelled provider operation retains its slot until it settles. */
export class AdapterCreditService implements AdapterCreditControl {
  private state: AdapterCreditStatus;
  private timer?: NodeJS.Timeout;
  private flight: Flight | undefined;
  private stopped = false;
  private readonly intervalMs: number;
  private readonly now: () => number;

  constructor(private readonly adapterId: string, private readonly credits: AdapterCredits, private readonly options: Options = {}) {
    const capability = capabilitySchema.parse(credits);
    this.intervalMs = options.intervalMs ?? ADAPTER_CREDIT_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.state = { adapter_id: adapterId, display_name: capability.displayName, status: "unavailable", refreshing: false };
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.refresh(); }, this.intervalMs);
    this.timer.unref();
    void this.refresh();
  }

  snapshot(): AdapterCreditStatus {
    const state = this.state;
    if (state.status !== "unavailable") {
      return { ...state, status: state.status === "stale" || this.now() - Date.parse(state.last_successful_at) >= this.intervalMs * 2
        ? "stale" : "ready", windows: state.windows.map(window => ({ ...window })) };
    }
    return { ...state };
  }

  refresh(): Promise<void> {
    if (this.flight) return this.flight.result;
    if (this.stopped) return Promise.resolve();
    const controller = new AbortController();
    let accepted = true;
    let finish!: () => void;
    const result = new Promise<void>(resolve => { finish = resolve; });
    this.state = { ...this.state, refreshing: true };
    const fail = () => {
      const state = this.state;
      const checked_at = new Date(this.now()).toISOString();
      this.state = state.status === "unavailable" ? { ...state, refreshing: false, checked_at }
        : { ...state, status: "stale", refreshing: false, checked_at };
    };
    const deadline = setTimeout(() => {
      accepted = false;
      controller.abort();
      if (!this.stopped) fail();
      finish();
    }, this.options.timeoutMs ?? 15_000);
    deadline.unref();
    const settled = Promise.resolve().then(() => this.credits.fetch({ signal: controller.signal })).then(reading => {
      if (!accepted || this.stopped) return;
      const parsed = reading === null ? null : adapterCreditReadingSchema.parse(reading);
      const checked_at = new Date(this.now()).toISOString();
      const common = { adapter_id: this.adapterId, display_name: this.state.display_name, refreshing: false, checked_at };
      this.state = parsed && parsed.windows.length > 0
        ? { ...common, status: "ready", last_successful_at: checked_at, windows: parsed.windows }
        : { ...common, status: "unavailable" };
    }).catch(() => { if (accepted && !this.stopped) fail(); }).finally(() => {
      clearTimeout(deadline);
      this.flight = undefined;
      finish();
    });
    this.flight = { controller, result, settled };
    return result;
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    const flight = this.flight;
    if (!flight) return;
    flight.controller.abort();
    this.state = { ...this.state, refreshing: false };
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([flight.settled, new Promise<void>(resolve => {
      timeout = setTimeout(resolve, this.options.closeTimeoutMs ?? 2_000);
    })]);
    if (timeout) clearTimeout(timeout);
  }
}
