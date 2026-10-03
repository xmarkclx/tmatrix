import { trimLocalActivity } from "./helpers/trim-local-activity.js";
import { workerTitle } from "./helpers/worker-title.js";
import { localPromptPreview } from "./helpers/local-prompt-preview.js";
import type { Ticket } from "./types.js";

export interface WorkerObservation {
  kind: string;
  text: string;
  thread_id?: string;
  run_kind?: "initial" | "resumed";
  input_revision?: number;
  steering_id?: string;
}

export interface LocalWorkerView {
  id: string;
  ticket_id: string;
  title: string;
  worker_type: string;
  model: string;
  status: "running" | "stopping" | "stopped" | "completed" | "failed" | "stop_unverified";
  pinned: boolean;
  ended_at?: string;
  thread_id?: string;
  run_kind?: "initial" | "resumed";
  input_revision: number;
  started_at: string;
  initial_prompt?: { text: string; at: string; input_revision: number; truncated: boolean; redacted: boolean };
  activity: { sequence: number; at: string; kind: string; text: string; steering_id?: string }[];
  steering: { id: string; message: string; status: "queued" | "runtime_received" | "response_observed" | "failed" }[];
}

/** Opt-in, bounded memory for the local console. Never sent to the task API. */
export class LocalWorkerState {
  constructor(private readonly adapterId = "codex") {}

  private readonly workers = new Map<string, LocalWorkerView>();
  private sequence = 0;

  start(ticket: Ticket): void {
    this.workers.set(ticket.worker_id, {
      id: ticket.worker_id,
      ticket_id: ticket.ticket_id,
      // Instructions may contain credentials and are not a display title.
      title: cleanText(workerTitle(ticket)).slice(0, 4096),
      worker_type: this.adapterId,
      model: ticket.model,
      status: "running",
      pinned: false,
      input_revision: ticket.input_revision ?? 0,
      started_at: new Date().toISOString(),
      activity: [],
      steering: []
    });
    this.record(ticket.worker_id, { kind: "worker.started", text: "Worker started" });
  }

  record(workerId: string, event: WorkerObservation): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;
    // This observer-only input is never an activity/progress event. Keep the
    // first prepared prompt even as steering changes revisions and logs rotate.
    if (event.kind === "prompt.prepared") {
      worker.initial_prompt ??= {
        ...localPromptPreview(event.text),
        at: new Date().toISOString(),
        input_revision: event.input_revision ?? worker.input_revision
      };
      return;
    }
    if (event.thread_id !== undefined) worker.thread_id = event.thread_id;
    if (event.run_kind !== undefined) worker.run_kind = event.run_kind;
    if (event.input_revision !== undefined) worker.input_revision = event.input_revision;
    if (event.steering_id) {
      const receipt = worker.steering.find((entry) => entry.id === event.steering_id);
      if (receipt && event.kind === "steering.runtime_received") receipt.status = "runtime_received";
      if (receipt && event.kind === "steering.response_observed") receipt.status = "response_observed";
      if (receipt && event.kind === "steering.failed") receipt.status = "failed";
      if (receipt) {
        const text = cleanText(`${receipt.message}\n\n${event.text}`);
        const card = worker.activity.find((entry) => entry.steering_id === event.steering_id);
        if (card) {
          card.text = text;
          card.kind = event.kind;
        } else {
          worker.activity.push({ sequence: ++this.sequence, at: new Date().toISOString(), kind: event.kind, text, steering_id: receipt.id });
        }
        trimLocalActivity(worker.activity, 128 * 1024);
        return;
      }
    }
    worker.activity.push({ sequence: ++this.sequence, at: new Date().toISOString(), kind: event.kind, text: cleanText(event.text) });
    // Bytes, rather than fixed line/entry counts, determine how much fits.
    trimLocalActivity(worker.activity, 128 * 1024);
  }

  queue(workerId: string, id: string, message = ""): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;
    const preview = localPromptPreview(message);
    worker.steering.push({ id, message: preview.text + (preview.truncated ? "\n[Message preview truncated]" : ""), status: "queued" });
    if (worker.steering.length > 100) worker.steering.shift();
    this.record(workerId, { kind: "steering.queued", text: "Message queued for delivery to this conversation. Waiting for runtime receipt.", steering_id: id });
  }

  status(workerId: string, status: LocalWorkerView["status"]): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;
    worker.status = status;
    if (["completed", "stopped", "failed"].includes(status)) {
      worker.ended_at ??= new Date().toISOString();
    }
    if (this.removeIfEligible(worker)) return;
    if (!["running", "stopping"].includes(status)) {
      for (const receipt of worker.steering) {
        if (receipt.status === "queued" || receipt.status === "runtime_received") {
          const text = receipt.status === "runtime_received"
            ? "Runtime received the message, but the worker ended without a confirmed visible response."
            : "Worker ended before runtime receipt was confirmed.";
          this.record(workerId, { kind: "steering.failed", text, steering_id: receipt.id });
        }
      }
    }
    this.record(workerId, { kind: `worker.${status}`, text: status === "stopped" ? "Runtime teardown confirmed" : `Worker ${status.replaceAll("_", " ")}` });
  }

  setPinned(workerId: string, options: { pinned: boolean }): boolean {
    const worker = this.workers.get(workerId);
    if (!worker) return false;
    worker.pinned = options.pinned;
    this.removeIfEligible(worker);
    return true;
  }

  private removeIfEligible(worker: LocalWorkerView): boolean {
    // Pinning retains the local view, never the execution or a capacity slot.
    if (worker.pinned || !["completed", "stopped", "failed"].includes(worker.status)) return false;
    this.workers.delete(worker.id);
    return true;
  }

  snapshot(): LocalWorkerView[] {
    return structuredClone([...this.workers.values()]);
  }
}

/** Drop terminal control sequences so runtime text cannot manipulate the TUI. */
function cleanText(value: string): string {
  return value.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}
