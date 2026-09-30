import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open, readFile, readlink, rename, symlink, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { WorkerError } from "./errors.js";
import { conversationReferenceSchema, type Ticket, type ConversationReference } from "./types.js";

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
type ConversationRecord = z.infer<typeof recordSchema>;

/** Private IDs only: task/comment ancestry points to Codex's own local history. */
export class ConversationStore {
  private readonly directory: string;
  private readonly runtime: string;
  private readonly scope: string;
  private readonly lockDirectory: string;
  private readonly namespace: string;
  private readonly referenceKey: string | undefined;
  private readonly writes = new Map<string, Promise<void>>();

  constructor(options: { directory: string; namespace: string; referenceKey?: string; adapterId?: string; runtimeHome?: string }) {
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
  attachContext(ticket: Ticket, conversationId: string, summary: string): string {
    if (!this.referenceKey || ticket.task_id === undefined) return summary;
    threadId.parse(conversationId);
    const payload = Buffer.from(JSON.stringify({ version: 1, namespace: this.namespace, task: this.task(ticket), ticket: ticket.ticket_id, thread: conversationId })).toString("base64url");
    const signature = createHmac("sha256", this.referenceKey).update(payload).digest("hex");
    const clean = summary.replace(/\n?<!-- tmatrix-conversation:v1:[A-Za-z0-9_-]+\.[a-f0-9]{64} -->/g, "").trim();
    const marker = `<!-- tmatrix-conversation:v1:${payload}.${signature} -->`;
    const bounded = clean.slice(0, Math.max(0, 100_000 - marker.length - 2)).replace(/[\uD800-\uDBFF]$/, "");
    return `${bounded}\n\n${marker}`;
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
  async acquire(ticket: Ticket, signal?: AbortSignal): Promise<() => Promise<void>> {
    signal?.throwIfAborted();
    await this.prepare();
    await mkdir(this.lockDirectory, { recursive: true, mode: 0o700 });
    const path = join(this.lockDirectory, `${this.hash(this.task(ticket))}.json.lock`);
    const owner = JSON.stringify({ pid: process.pid, host: hostname(), token: randomUUID() });
    for (;;) {
      signal?.throwIfAborted();
      try {
        // A symlink publishes the entire owner atomically, without a partially
        // written owner file that can become stranded after a crash.
        await symlink(owner, path);
        if (signal?.aborted) {
          await unlink(path);
          signal.throwIfAborted();
        }
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          if (await readlink(path).catch(() => undefined) === owner) await unlink(path);
        };
      } catch (error) {
        if (!this.isCode(error, "EEXIST")) throw error;
      }

      let stale: string;
      try { stale = await readlink(path); } catch (error) {
        // The holder may release between our EEXIST and this read.
        if (this.isCode(error, "ENOENT")) continue;
        throw this.busy();
      }
      let parsed: unknown;
      try { parsed = JSON.parse(stale); } catch { throw this.busy(); }
      const previous = this.object(parsed);
      if (previous?.host !== hostname() || !Number.isSafeInteger(previous.pid) || Number(previous.pid) <= 0 ||
          typeof previous.token !== "string" || !/^[a-f0-9-]{36}$/.test(previous.token)) throw this.busy();
      let alive = true;
      try { process.kill(Number(previous.pid), 0); } catch (error) {
        if (!this.isCode(error, "ESRCH")) throw this.busy();
        alive = false;
      }
      if (alive) {
        await delay(250, undefined, signal ? { signal } : {});
        continue;
      }

      // A dead daemon does not prove that its detached runtime descendants
      // stopped. Leave the lease intact until a human verifies teardown.
      throw new WorkerError({ message: "The previous daemon exited while holding this conversation. Confirm its runtime stopped, then remove the stale conversation lock before retrying.", code: "CONVERSATION_OWNER_LOST", stage: "conversation.lock" });
    }
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
