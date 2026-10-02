import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { Logger } from "pino";
import type { AdapterUpdateControl, AdapterUpdates, AdapterUpdateState, AdapterUpdateStatus } from "./runtime-adapter.js";

const states = new Set(["idle", "checking", "installing", "verifying", "updated", "up_to_date", "failed", "disabled"]);

/** Isolate optional updater failures from worker admission, control and drain. */
export class AdapterUpdateService implements AdapterUpdateControl {
  readonly rollback?: () => Promise<void>;
  private lastState: AdapterUpdateState = { status: "idle", current_version: "unknown" };
  private failed = false;

  constructor(
    private readonly adapterId: string,
    private readonly updates: AdapterUpdates,
    private readonly logger: Pick<Logger, "warn">
  ) {
    if (typeof updates.displayName !== "string" || !updates.displayName.trim() || updates.displayName.length > 100 ||
        [updates.snapshot, updates.start, updates.close, updates.checkNow].some(method => typeof method !== "function") ||
        (updates.rollback !== undefined && typeof updates.rollback !== "function")) {
      throw new Error("Adapter updates must provide a name, status, lifecycle and check action");
    }
    if (updates.rollback) this.rollback = () => this.run(() => updates.rollback!());
  }

  snapshot(): AdapterUpdateStatus {
    try {
      const state = this.updates.snapshot();
      if (!state || !states.has(state.status) || typeof state.current_version !== "string") {
        throw new Error("Invalid adapter update status");
      }
      // Copy only the public update fields. Provider-specific objects and raw
      // runtime data must not accidentally enter the terminal control response.
      this.lastState = {
        status: state.status,
        current_version: state.current_version,
        ...(typeof state.previous_version === "string" ? { previous_version: state.previous_version } : {}),
        ...(typeof state.latest_version === "string" ? { latest_version: state.latest_version } : {}),
        ...(typeof state.blocked_version === "string" ? { blocked_version: state.blocked_version } : {}),
        ...(typeof state.last_checked_at === "string" ? { last_checked_at: state.last_checked_at } : {}),
        ...(typeof state.next_check_at === "string" ? { next_check_at: state.next_check_at } : {}),
        ...(typeof state.error === "string" ? { error: state.error } : {}),
        can_rollback: state.can_rollback === true
      };
    } catch {
      this.lastState = { ...this.lastState, status: "disabled", error: "Runtime update status is unavailable." };
    }
    const status = this.lastState.status === "disabled" ? "disabled" : this.failed ? "failed" : this.lastState.status;
    return {
      ...this.lastState,
      ...(this.failed && status !== "disabled"
        ? { error: "Runtime update operation failed; the current version remains available." } : {}),
      status,
      adapter_id: this.adapterId,
      display_name: this.updates.displayName,
      can_rollback: !!this.rollback && this.lastState.can_rollback === true && status !== "disabled"
    };
  }

  start(): void { void this.run(() => this.updates.start()); }
  close(): Promise<void> { return this.run(() => this.updates.close()); }
  checkNow(): Promise<void> { return this.run(() => this.updates.checkNow()); }

  private async run(action: () => void | Promise<void>): Promise<void> {
    try { await action(); this.failed = false; }
    catch {
      this.failed = true;
      this.logger.warn({ event: "adapter.update_failed", adapter_id: this.adapterId },
        "Runtime update operation failed; workers retain their runtime");
    }
  }
}

export function resolveAdapterUpdateDirectory(
  adapterId: string,
  pollOrigin: string,
  instanceId: string,
  environment: NodeJS.ProcessEnv = process.env
): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(adapterId)) throw new Error("Invalid adapter update namespace");
  return environment.TMATRIX_CONTROL_FILE
    ? resolve(dirname(environment.TMATRIX_CONTROL_FILE), adapterId)
    : resolve(environment.XDG_STATE_HOME || resolve(homedir(), ".local", "state"), "tmatrix", adapterId,
      createHash("sha256").update(`${pollOrigin}\n${instanceId}`).digest("hex"));
}
