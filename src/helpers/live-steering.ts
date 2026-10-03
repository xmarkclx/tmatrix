import type { WorkerObservation } from "../local-worker-state.js";

interface LocalMessage { id: string; message: string }
interface LocalMailbox {
  takeLocal(): LocalMessage | undefined;
  returnLocal(message: LocalMessage): void;
  hasLocal(): boolean;
  subscribeLocal(listener: () => void): () => void;
}

/** Serial delivery alongside the event stream, including quiet tools/sleeps.
 * Only an explicit rejection may go back to the queue; ambiguous failures must
 * never replay input that the runtime might already have received. */
export class LiveSteering {
  private active = false;
  private pending: Promise<void> | undefined;
  private readonly received = new Set<string>();
  private readonly unsubscribe: () => void;

  constructor(private readonly options: {
    mailbox: LocalMailbox;
    deliver: (message: string) => Promise<boolean>;
    observe: (event: WorkerObservation) => Promise<void>;
  }) {
    this.unsubscribe = options.mailbox.subscribeLocal(() => this.pump());
  }

  start(): void { this.active = true; this.pump(); }
  end(): void { this.active = false; }

  async responseObserved(): Promise<void> {
    // An acknowledgement arriving while we report this response belongs to a
    // later response, not to the one we are currently observing.
    for (const id of [...this.received]) {
      this.received.delete(id);
      await this.options.observe({ kind: "steering.response_observed", text: "A response was observed after the local message", steering_id: id });
    }
  }

  async close(): Promise<void> {
    this.end();
    this.unsubscribe();
    await this.pending;
  }

  private pump(): void {
    if (!this.active || this.pending) return;
    this.pending = this.deliverQueued().finally(() => {
      this.pending = undefined;
      if (this.active && this.options.mailbox.hasLocal()) this.pump();
    });
  }

  private async deliverQueued(): Promise<void> {
    while (this.active) {
      const local = this.options.mailbox.takeLocal();
      if (!local) return;
      try {
        if (!await this.options.deliver(local.message)) {
          this.options.mailbox.returnLocal(local);
          this.end();
          await this.options.observe({ kind: "steering.deferred", text: "Live steering was not accepted. Message will be sent in this conversation's next turn.", steering_id: local.id });
          return;
        }
        this.received.add(local.id);
        await this.options.observe({ kind: "steering.runtime_received", text: "Runtime accepted the local message in the active turn. Waiting for a visible response.", steering_id: local.id });
      } catch {
        await this.options.observe({ kind: "steering.failed", text: "Could not confirm message delivery. It will not be resent automatically because the runtime may have received it.", steering_id: local.id });
      }
    }
  }
}
