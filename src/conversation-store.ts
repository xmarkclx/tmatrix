import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open, readFile, readlink, rename, rmdir, symlink, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { LEASE_ENV, legacyLockPredatesBoot, processStart, stopLeaseProcesses } from "./conversation-recovery.js";
import { CGROUP_ENV, createLeaseCgroup, stopLeaseCgroup, validLeaseCgroup } from "./conversation-cgroup.js";
import { WorkerError } from "./errors.js";
import { conversationReferenceSchema, type Ticket, type ConversationReference } from "./types.js";

export function stripConversationReference(summary: string): string {
  return summary.replace(/\n?<!-- tmatrix-conversation:v1:[A-Za-z0-9_-]+\.[a-f0-9]{64} -->/g, "").trim();
}

export function boundContext(summary: string, note?: string): string {
  if (!note) return summary;
  const bounded = summary.slice(0, Math.max(0, 100_000 - note.length - 2)).replace(/[\uD800-\uDBFF]$/, "");
  return `${bounded}\n\n${note}`;
}

export type BootIdentity = { machine: string; boot: string };

/** Linux/WSL boot identity: unavailable platforms deliberately fail closed. */
export async function bootIdentity(): Promise<BootIdentity | undefined> {
  try {
    const machine = (await readFile("/etc/machine-id", "utf8")).trim();
    const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    if (/^[a-f0-9]{32}$/.test(machine) && /^[a-f0-9-]{36}$/.test(boot)) return { machine, boot };
  } catch { /* Recovery needs positive evidence, not a failed process probe. */ }
  return undefined;
}

const threadId = z.string().min(1).max(255);
const recordSchema = z.object({
  version: z.literal(1),
  task: z.string(),
  activeThread: threadId.optional(),
  tickets: z.record(z.string(), threadId),
  comments: z.record(z.string(), threadId),
  replacements: z.record(z.string(), threadId),
  contextHashes: z.record(z.string(), z.record(z.string(), z.string())).default({})
});
const runtimeAttemptSchema = z.object({
  ticket: z.string().regex(/^[a-f0-9]{64}$/),
  runtime: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  conversation: conversationReferenceSchema.optional().catch(undefined)
});
type RuntimeAttempt = z.infer<typeof runtimeAttemptSchema>;

export type ConversationLease = (() => Promise<void>) & {
  environment?: Record<string, string>;
  recovered?: boolean;
  recoveredAttempt?: RuntimeAttempt;
  rememberRuntime?(runtime: string, conversation?: ConversationReference): Promise<void>;
  prepareRuntimeReplacement?(): Promise<void>;
};

type ConversationRecord = z.infer<typeof recordSchema>;

/** Private IDs link task and comment ancestry to a provider's local history. */
export class ConversationStore {
  private readonly directory: string;
  private readonly runtime: string;
  private readonly scope: string;
  private readonly lockDirectory: string;
  private readonly namespace: string;
  private readonly referenceKey: string | undefined;
  private readonly getBootIdentity: () => Promise<BootIdentity | undefined>;
  private readonly trackRuntime: boolean;
  private readonly writes = new Map<string, Promise<void>>();

  constructor(options: { directory: string; namespace: string; referenceKey?: string; adapterId?: string; runtimeHome?: string; trackRuntime?: boolean; bootIdentity?: () => Promise<BootIdentity | undefined> }) {
    this.trackRuntime = options.trackRuntime === true && process.platform === "linux";
    this.getBootIdentity = options.bootIdentity ?? bootIdentity;
    this.lockDirectory = join(options.directory, this.hash(options.namespace));
    // Preserve all existing Codex routes. Other adapters cannot consume their IDs.
    this.namespace = this.hash(!options.adapterId || options.adapterId === "codex"
      ? options.namespace : JSON.stringify([options.namespace, options.adapterId]));
    this.referenceKey = options.referenceKey;
    this.directory = join(options.directory, this.namespace);
    this.runtime = options.adapterId ?? "codex";
    this.scope = this.hash(JSON.stringify([hostname(), this.directory, options.runtimeHome ?? ""]));
  }

  /** Public routing metadata contains no machine path or credentials. */
  reference(conversationId: string): ConversationReference {
    return { thread_id: threadId.parse(conversationId), runtime: this.runtime, scope: this.scope };
  }

  /** The private handoff carries authenticated IDs, never credentials or logs. */
  attachContext(ticket: Ticket, conversationId: string, summary: string, note?: string): string {
    if (!this.referenceKey || ticket.task_id === undefined) return boundContext(summary, note);
    threadId.parse(conversationId);
    const payload = Buffer.from(JSON.stringify({ version: 1, namespace: this.namespace, task: this.task(ticket), ticket: ticket.ticket_id, thread: conversationId })).toString("base64url");
    const signature = createHmac("sha256", this.referenceKey).update(payload).digest("hex");
    const clean = stripConversationReference(summary);
    const marker = `<!-- tmatrix-conversation:v1:${payload}.${signature} -->`;
    return boundContext(clean, note ? `${note}\n\n${marker}` : marker);
  }

  /** Prefer the explicit task route, then the local task route, then legacy reply links. */
  async resolve(ticket: Ticket, history: unknown): Promise<string | undefined> {
    const record = await this.read(ticket);
    const context = this.object(history);
    const serverRoute = context && Object.hasOwn(context, "conversation") ? context.conversation : ticket.conversation;
    const explicit = conversationReferenceSchema.safeParse(serverRoute);
    // An explicit foreign route must not fall back to an obsolete local branch.
    if (explicit.success && (explicit.data.runtime !== this.runtime || explicit.data.scope !== this.scope)) return undefined;
    // Explicit null means the server has no current route (for example after
    // an old worker completed). Recover its legacy handoff, not a stale task pointer.
    let found = explicit.success ? explicit.data.thread_id : serverRoute === null ? undefined : record.activeThread;
    found ??= Object.hasOwn(record.tickets, ticket.ticket_id) ? record.tickets[ticket.ticket_id] : undefined;
    if (!found) {
      const context = this.object(history);
      const trigger = this.object(context?.trigger_comment);
      const inherited = this.object(context?.inherited_context);
      const reference = this.contextReference(ticket, inherited?.content);
      if (reference?.ticket === ticket.ticket_id && this.id(inherited?.sourceCommentId)) {
        found = reference.thread;
        await this.remember(ticket, found);
      }
      let anchor = this.id(ticket.thread_anchor_comment_id) ?? this.id(context?.thread_anchor_comment_id) ?? this.id(trigger?.replyToCommentId);
      const comments = new Map<string, Record<string, unknown>>();
      if (Array.isArray(context?.comments)) {
        for (const entry of context.comments) {
          const comment = this.object(entry);
          const id = this.id(comment?.id);
          if (id && comment) comments.set(id, comment);
        }
      }
      const visited = new Set<string>();
      while (!found && anchor && !visited.has(anchor)) {
        visited.add(anchor);
        if (Object.hasOwn(record.comments, anchor)) {
          found = record.comments[anchor];
          break;
        }
        if (this.id(inherited?.sourceCommentId) === anchor) {
          found = reference?.thread;
          if (found) {
            const sourceCommentId = anchor;
            await this.update(ticket, (saved) => { saved.comments[sourceCommentId] = found!; });
            break;
          }
        }
        const comment = comments.get(anchor);
        // Crossing an unmapped AI response could discard context from a
        // replacement conversation. Unknown ancestry must fail closed.
        if (comment?.isAI !== false) break;
        anchor = this.id(comment.replyToCommentId);
      }
    }
    const visited = new Set<string>();
    while (found && Object.hasOwn(record.replacements, found)) {
      if (visited.has(found)) throw this.invalidState();
      visited.add(found);
      found = record.replacements[found];
    }
    return found;
  }

  /** Persist before turn/start so a daemon crash cannot lose the new thread ID. */
  async remember(ticket: Ticket, conversationId: string, previousThreadId?: string): Promise<void> {
    threadId.parse(conversationId);
    await this.update(ticket, (record) => {
      record.activeThread = conversationId;
      record.tickets[ticket.ticket_id] = conversationId;
      if (previousThreadId && previousThreadId !== conversationId) {
        threadId.parse(previousThreadId);
        record.replacements[previousThreadId] = conversationId;
      }
    });
  }

  /** Compare only durable context fields, never comment history or delivery IDs. */
  async contextChanges(ticket: Ticket, conversationId: string, context: Record<string, unknown>): Promise<Record<string, unknown>> {
    const previous = (await this.read(ticket)).contextHashes[conversationId] ?? {};
    return Object.fromEntries(Object.entries(context).filter(([key, value]) => previous[key] !== this.hash(JSON.stringify(value))));
  }

  /** Commit the baseline only after a completed model turn; store hashes, not text. */
  async rememberContext(ticket: Ticket, conversationId: string, context: Record<string, unknown>): Promise<void> {
    await this.update(ticket, (record) => {
      record.contextHashes[conversationId] = Object.fromEntries(Object.entries(context).map(([key, value]) => [key, this.hash(JSON.stringify(value))]));
    });
  }

  /** Bind only server-confirmed comment IDs; cancelled results write no handoff. */
  async bindResult(ticket: Ticket, conversationId: string, receipt: unknown): Promise<void> {
    const response = this.object(receipt);
    if (!response || response.cancelled === true || response.success !== true) return;
    const ids = [response.comment_id, response.context_comment_id, response.result_comment_id]
      .map((id) => this.id(id)).filter((id): id is string => id !== undefined);
    if (!ids.length) return;
    threadId.parse(conversationId);
    await this.update(ticket, (record) => {
      record.tickets[ticket.ticket_id] = conversationId;
      // An idempotent result acknowledgement can name an older handoff. Keep
      // its original identity; confirmed replacements follow the alias map.
      for (const id of ids) if (!Object.hasOwn(record.comments, id)) record.comments[id] = conversationId;
    });
  }

  /** Hold through runtime teardown and result binding to serialize task replies. */
  async acquire(ticket: Ticket, signal?: AbortSignal): Promise<ConversationLease> {
    signal?.throwIfAborted();
    await this.prepare();
    await mkdir(this.lockDirectory, { recursive: true, mode: 0o700 });
    const path = join(this.lockDirectory, `${this.hash(this.task(ticket))}.json.lock`);
    const ticketKey = this.hash(ticket.ticket_id);
    const identity = await this.getBootIdentity();
    const start = this.trackRuntime ? await processStart(process.pid) : undefined;
    const tracked = this.trackRuntime && identity !== undefined && start !== undefined;
    const token = randomUUID();
    const cgroup = tracked ? await createLeaseCgroup(token) : undefined;
    const ownerDetails = { pid: process.pid, host: hostname(), token, identity,
      ...(tracked ? { tracking: cgroup ? 2 : 1, start, ...(cgroup ? { cgroup } : {}) } : {}) };
    let owner = JSON.stringify(ownerDetails);
    let acquired = false;
    try {
      let recovered = false;
      let recoveredAttempt: RuntimeAttempt | undefined;
      for (;;) {
        signal?.throwIfAborted();
        try {
          // A symlink publishes the entire owner atomically, without a partially
          // written owner file that can become stranded after a crash.
          owner = JSON.stringify({ ...ownerDetails, ...recoveredAttempt });
          await symlink(owner, path);
          if (signal?.aborted) {
            if (cgroup && !await stopLeaseCgroup(cgroup, token)) throw this.ownerLost();
            await unlink(path);
            signal.throwIfAborted();
          }
          let released = false;
          const release: ConversationLease = async () => {
            if (released) return;
            if (cgroup && !await stopLeaseCgroup(cgroup, token)) throw this.ownerLost();
            if (await readlink(path).catch(() => undefined) === owner) await unlink(path);
            released = true;
          };
          if (tracked) {
            release.environment = { [LEASE_ENV]: token, ...(cgroup ? { [CGROUP_ENV]: cgroup } : {}) };
            release.prepareRuntimeReplacement = async () => {
              if (released || await readlink(path) !== owner) throw this.busy();
              const stopped = cgroup ? await stopLeaseCgroup(cgroup, token) : await stopLeaseProcesses(token, undefined, start);
              if (!stopped) throw this.ownerLost();
              if (cgroup && !await createLeaseCgroup(token, cgroup)) throw new WorkerError({
                message: "Could not create the replacement runtime's process group.",
                code: "CONVERSATION_GROUP_UNAVAILABLE", stage: "conversation.lock"
              });
            };
          }
          release.rememberRuntime = async (runtime, conversation) => {
            if (released || await readlink(path) !== owner) throw this.busy();
            const updated = JSON.stringify({ ...ownerDetails, ticket: ticketKey, runtime, conversation });
            if (updated === owner) return;
            const replacement = `${path}.${token}.runtime`;
            await symlink(updated, replacement);
            try {
              await rename(replacement, path);
              owner = updated;
            } catch (error) {
              await unlink(replacement).catch(() => undefined);
              throw error;
            }
          };
          acquired = true;
          release.recovered = recovered;
          if (recoveredAttempt !== undefined) release.recoveredAttempt = recoveredAttempt;
          return release;
        } catch (error) {
          if (!this.isCode(error, "EEXIST")) throw error;
        }

        let stale: string;
        try { stale = await readlink(path); } catch (error) {
          // The holder may release between our EEXIST and this read.
          if (this.isCode(error, "ENOENT")) continue;
          throw this.busy();
        }
        const previous = this.lockOwner(stale);
        if (this.fromPreviousBoot(previous, identity) ||
            (previous.identity === undefined && await legacyLockPredatesBoot(path))) {
          await this.removeStaleLock(path, stale);
          recovered = true;
          if (previous.ticket === ticketKey) recoveredAttempt = runtimeAttemptSchema.safeParse(previous).data;
          continue;
        }
        if (await this.ownerAlive(previous)) {
          await delay(250, undefined, signal ? { signal } : {});
          continue;
        }
        if (this.canTrack(previous, identity)) {
          await this.removeStaleLock(path, stale, async () => {
            if (!await this.stopOwner(previous, signal)) throw this.ownerLost();
          });
          recovered = true;
          if (previous.ticket === ticketKey) recoveredAttempt = runtimeAttemptSchema.safeParse(previous).data;
          continue;
        }
        throw this.ownerLost();
      }
    } finally {
      if (!acquired && cgroup && !await stopLeaseCgroup(cgroup, token)) throw this.ownerLost();
    }
  }

  /** Offline recovery never starts a runtime or contacts the task API. */
  async recover(taskId: string, confirmRuntimeStopped = false): Promise<boolean> {
    if (!taskId.trim()) throw new Error("A canonical task ID is required.");
    const path = join(this.lockDirectory, `${this.hash(taskId)}.json.lock`);
    let stale: string;
    try { stale = await readlink(path); } catch (error) {
      if (this.isCode(error, "ENOENT")) return false;
      throw this.busy();
    }
    const previous = this.lockOwner(stale);
    const identity = await this.getBootIdentity();
    if (!this.fromPreviousBoot(previous, identity) &&
        !(previous.identity === undefined && await legacyLockPredatesBoot(path))) {
      if (await this.ownerAlive(previous)) throw this.busy();
      if (!confirmRuntimeStopped) {
        if (!this.canTrack(previous, identity)) throw this.ownerLost();
        await this.removeStaleLock(path, stale, async () => {
          if (!await this.stopOwner(previous)) throw this.ownerLost();
        });
        return true;
      }
    }
    await this.removeStaleLock(path, stale);
    return true;
  }

  private lockOwner(encoded: string): Record<string, unknown> {
    let previous: Record<string, unknown> | undefined;
    try { previous = this.object(JSON.parse(encoded)); } catch { throw this.busy(); }
    if (previous?.host !== hostname() || !Number.isSafeInteger(previous.pid) || Number(previous.pid) <= 0 ||
        typeof previous.token !== "string" || !/^[a-f0-9-]{36}$/.test(previous.token)) throw this.busy();
    return previous;
  }

  private fromPreviousBoot(owner: Record<string, unknown>, current: BootIdentity | undefined): boolean {
    const saved = this.object(owner.identity);
    return !!current && saved?.machine === current.machine && typeof saved.boot === "string" &&
      /^[a-f0-9-]{36}$/.test(saved.boot) && saved.boot !== current.boot;
  }

  private canTrack(owner: Record<string, unknown>, current: BootIdentity | undefined): boolean {
    const saved = this.object(owner.identity);
    return (owner.tracking === 1 || (owner.tracking === 2 && typeof owner.cgroup === "string" &&
      validLeaseCgroup(owner.cgroup, String(owner.token)))) && typeof owner.start === "string" && /^\d+$/.test(owner.start) && !!current && saved?.machine === current.machine && saved.boot === current.boot;
  }

  private stopOwner(owner: Record<string, unknown>, signal?: AbortSignal): Promise<boolean> {
    return owner.tracking === 2
      ? stopLeaseCgroup(String(owner.cgroup), String(owner.token), signal)
      : stopLeaseProcesses(String(owner.token), signal, String(owner.start));
  }

  private async ownerAlive(owner: Record<string, unknown>): Promise<boolean> {
    try {
      process.kill(Number(owner.pid), 0);
      if (typeof owner.start === "string") {
        const current = await processStart(Number(owner.pid));
        if (current && current !== owner.start) return false;
      }
      return true;
    } catch (error) {
      if (this.isCode(error, "ESRCH")) return false;
      throw this.busy();
    }
  }

  private async removeStaleLock(path: string, expected: string, teardown?: () => Promise<void>): Promise<void> {
    // Serialize recoverers, including the offline command. Without this guard,
    // two stale readers could unlink a newly acquired lease (check/unlink race).
    const guard = `${path}.recovery`;
    try { await mkdir(guard, { mode: 0o700 }); } catch (error) {
      if (this.isCode(error, "EEXIST")) throw new WorkerError({
        message: "Conversation recovery is in progress or was interrupted. If it was interrupted, confirm all recovery commands stopped before removing the .json.lock.recovery directory.",
        code: "CONVERSATION_RECOVERY_BUSY", stage: "conversation.lock", retryable: true
      });
      throw error;
    }
    try {
      const current = await readlink(path).catch((error: unknown) => {
        if (this.isCode(error, "ENOENT")) return undefined;
        throw error;
      });
      if (current !== expected) throw this.busy();
      await teardown?.();
      await unlink(path);
    } finally { await rmdir(guard); }
  }

  private ownerLost(): WorkerError {
    return new WorkerError({
      message: "Automatic conversation recovery could not verify that the previous runtime stopped. This older or inaccessible runtime cannot safely be bypassed by starting another conversation. After confirming it stopped, run tmatrix conversation recover <canonical-task-id> --confirm-runtime-stopped outside this conversation.",
      code: "CONVERSATION_OWNER_LOST", stage: "conversation.lock"
    });
  }

  private contextReference(ticket: Ticket, summary: unknown): { thread: string; ticket: string } | undefined {
    if (!this.referenceKey || ticket.task_id === undefined || typeof summary !== "string") return undefined;
    const markers = [...summary.matchAll(/<!-- tmatrix-conversation:v1:([A-Za-z0-9_-]{1,4096})\.([a-f0-9]{64}) -->/g)];
    if (markers.length !== 1) return undefined;
    const payload = markers[0]?.[1];
    const signature = markers[0]?.[2];
    if (!payload || !signature) return undefined;
    const expected = createHmac("sha256", this.referenceKey).update(payload).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) return undefined;
    try {
      const reference = this.object(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
      if (reference?.version !== 1 || reference.namespace !== this.namespace || reference.task !== this.task(ticket) || typeof reference.ticket !== "string") return undefined;
      const parsed = threadId.safeParse(reference.thread);
      return parsed.success ? { thread: parsed.data, ticket: reference.ticket } : undefined;
    } catch { return undefined; }
  }

  private async prepare(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
  }

  private task(ticket: Ticket): string {
    // Legacy generic tickets without task IDs can recover themselves, but must
    // never accidentally share reply mappings with another task.
    return this.id(ticket.task_id) ?? `ticket:${ticket.ticket_id}`;
  }

  private path(ticket: Ticket): string { return join(this.directory, `${this.hash(this.task(ticket))}.json`); }
  private hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

  private async read(ticket: Ticket): Promise<ConversationRecord> {
    let encoded: string;
    try { encoded = await readFile(this.path(ticket), "utf8"); } catch (error) {
      if (this.isCode(error, "ENOENT")) return { version: 1, task: this.task(ticket), tickets: {}, comments: {}, replacements: {}, contextHashes: {} };
      throw error;
    }
    try {
      const record = recordSchema.parse(JSON.parse(encoded));
      if (record.task !== this.task(ticket)) throw this.invalidState();
      return record;
    } catch { throw this.invalidState(); }
  }

  private async update(ticket: Ticket, mutate: (record: ConversationRecord) => void): Promise<void> {
    const path = this.path(ticket);
    const pending = this.writes.get(path) ?? Promise.resolve();
    const write = pending.catch(() => undefined).then(async () => {
      await this.prepare();
      const record = await this.read(ticket);
      mutate(record);
      const temporary = `${path}.${randomUUID()}.tmp`;
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(record));
        await file.sync();
      } finally { await file.close(); }
      try { await rename(temporary, path); } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    });
    this.writes.set(path, write);
    try { await write; } finally { if (this.writes.get(path) === write) this.writes.delete(path); }
  }

  private id(value: unknown): string | undefined {
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
    return undefined;
  }
  private object(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  }
  private isCode(error: unknown, code: string): boolean { return this.object(error)?.code === code; }
  private busy(): WorkerError {
    return new WorkerError({ message: "Another worker holds this task's conversation; retry after it finishes.", code: "CONVERSATION_BUSY", stage: "conversation.lock", retryable: true });
  }
  private invalidState(): WorkerError {
    return new WorkerError({ message: "Saved conversation metadata is invalid; restore it before resuming this task.", code: "CONVERSATION_STATE_INVALID", stage: "conversation.resolve" });
  }
}
