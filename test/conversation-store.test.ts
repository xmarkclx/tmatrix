import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationStore } from "../src/conversation-store.js";
import { makeTicket } from "./helpers.js";

const directories: string[] = [];
const namespace = "https://tasks.example.test";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const ticket = makeTicket({ task_id: "canonical-task", ticket_id: "first-ticket" });

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "aiworker-conversation-test-"));
  directories.push(directory);
  return { directory, store: new ConversationStore({ directory, namespace }) };
}

afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))); });

describe("ConversationStore", () => {
  it("persists one active conversation per task across restarts", async () => {
    const { directory, store } = await setup();
    await store.remember(ticket, "thread-original");
    await store.bindResult(ticket, "thread-original", { success: true, comment_id: "100" });
    const other = makeTicket({ task_id: ticket.task_id, ticket_id: "other-root" });
    await store.remember(other, "thread-sibling");
    await store.bindResult(other, "thread-sibling", { success: true, comment_id: "200" });
    const reloaded = new ConversationStore({ directory, namespace });
    const reply = makeTicket({ task_id: ticket.task_id, ticket_id: "new-reply", thread_anchor_comment_id: "100" });
    expect(await reloaded.resolve(reply, { comments: [{ id: "200", replyToCommentId: null }] })).toBe("thread-sibling");
    expect(await reloaded.resolve(makeTicket({ ...reply, thread_anchor_comment_id: "200" }), {})).toBe("thread-sibling");
    expect(await reloaded.resolve(makeTicket({ task_id: ticket.task_id, ticket_id: "another-root" }), {})).toBe("thread-sibling");
    expect(await reloaded.resolve(makeTicket({ ...reply, task_id: "different-task" }), {})).toBeUndefined();
    expect(await new ConversationStore({ directory, namespace: "https://other.example.test" }).resolve(reply, {})).toBeUndefined();
  });

  it("recovers legacy ticket and reply mappings without a task-level route", async () => {
    const { store, directory } = await setup();
    await store.remember(ticket, "thread-original");
    const file = join(directory, hash(namespace), `${hash(String(ticket.task_id))}.json`);
    const legacy = JSON.parse(await readFile(file, "utf8"));
    delete legacy.activeThread;
    await writeFile(file, JSON.stringify(legacy));
    expect(await store.resolve(ticket, {})).toBe("thread-original");
    await store.bindResult(ticket, "thread-original", { success: true, result_comment_id: "100" });
    const reply = makeTicket({ task_id: ticket.task_id, ticket_id: "reply", thread_anchor_comment_id: "102" });
    expect(await store.resolve(reply, { comments: [
      { id: "102", replyToCommentId: "101", isAI: false }, { id: "101", replyToCommentId: "100", isAI: false }
    ] })).toBe("thread-original");
    expect(await store.resolve(reply, { comments: [{ id: "102", replyToCommentId: "102" }] })).toBeUndefined();
  });

  it("prefers the server task route and rejects foreign stores or runtimes", async () => {
    const { store, directory } = await setup();
    await store.remember(ticket, "local-old");
    const conversation = store.reference("server-current");
    const reply = makeTicket({ ...ticket, ticket_id: "new", conversation });
    expect(await store.resolve(reply, {})).toBe("server-current");
    expect(await store.resolve(reply, { conversation: store.reference("history-newer") })).toBe("history-newer");
    expect(await store.resolve({ ...reply, conversation: { ...conversation, scope: "foreign-store" } }, {})).toBeUndefined();
    expect(await store.resolve({ ...reply, conversation: { ...conversation, runtime: "another-runtime" } }, {})).toBeUndefined();
    await store.bindResult(ticket, "legacy-current", { success: true, comment_id: "300" });
    expect(await store.resolve({ ...reply, thread_anchor_comment_id: "300" }, { conversation: null })).toBe("legacy-current");
    const reloaded = new ConversationStore({ directory, namespace });
    expect(reloaded.reference("server-current")).toEqual(conversation);
    await store.remember(ticket, "replacement", "server-current");
    expect(await reloaded.resolve(reply, {})).toBe("replacement");
  });

  it("follows confirmed replacements from old comments without changing their mappings", async () => {
    const { store } = await setup();
    await store.remember(ticket, "thread-old");
    await store.bindResult(ticket, "thread-old", { success: true, comment_id: "100" });
    await store.remember(ticket, "thread-new", "thread-old");
    await store.bindResult(ticket, "unrelated-thread", { success: true, comment_id: "100" });
    expect(await store.resolve(makeTicket({ task_id: ticket.task_id, ticket_id: "reply", thread_anchor_comment_id: "100" }), {})).toBe("thread-new");
  });

  it("does not bind cancelled or unconfirmed results or unsafe numeric IDs", async () => {
    const { store } = await setup();
    await store.bindResult(ticket, "cancelled-thread", { success: true, cancelled: true, comment_id: "100" });
    await store.bindResult(ticket, "unknown-thread", { comment_id: "100" });
    await store.bindResult(ticket, "unsafe-thread", { success: true, comment_id: Number.MAX_SAFE_INTEGER + 1 });
    expect(await store.resolve(makeTicket({ task_id: ticket.task_id, ticket_id: "reply", thread_anchor_comment_id: "100" }), {})).toBeUndefined();
  });

  it("writes only private IDs atomically and preserves concurrent updates", async () => {
    const { directory, store } = await setup();
    await Promise.all(Array.from({ length: 12 }, (_, index) => store.remember(makeTicket({ task_id: ticket.task_id, ticket_id: `ticket-${index}` }), `thread-${index}`)));
    const folder = join(directory, hash(namespace));
    const file = join(folder, `${hash(String(ticket.task_id))}.json`);
    const data = JSON.parse(await readFile(file, "utf8"));
    expect(Object.keys(data.tickets)).toHaveLength(12);
    expect(await readdir(folder)).toHaveLength(1);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
    expect(data).not.toHaveProperty("instructions");
    await writeFile(file, "invalid saved metadata");
    await expect(store.resolve(ticket, {})).rejects.toMatchObject({ code: "CONVERSATION_STATE_INVALID" });
  });

  it("waits across store instances, supports cancellation, and releases idempotently", async () => {
    const { directory, store } = await setup();
    const release = await store.acquire(ticket);
    const second = new ConversationStore({ directory, namespace });
    const abort = new AbortController();
    const blocked = second.acquire(ticket, abort.signal);
    abort.abort(new Error("cancelled while waiting"));
    await expect(blocked).rejects.toBeDefined();
    const next = second.acquire(ticket);
    await release();
    const releaseNext = await next;
    await release();
    await releaseNext();
    const after = await store.acquire(ticket);
    await after();
  });

  it("leaves a dead daemon lock intact until runtime teardown is verified", async () => {
    const { directory, store } = await setup();
    const release = await store.acquire(ticket);
    const lock = join(directory, hash(namespace), `${hash(String(ticket.task_id))}.json.lock`);
    await release();
    // This PID is above Linux pid_max and cannot be a current process.
    await symlink(JSON.stringify({ pid: 2147483647, host: hostname(), token: "00000000-0000-4000-8000-000000000000" }), lock);
    await expect(store.acquire(ticket)).rejects.toMatchObject({ code: "CONVERSATION_OWNER_LOST" });
    const owner = JSON.parse(await readlink(lock));
    expect(owner.pid).toBe(2147483647);
    await release();
    expect(JSON.parse(await readlink(lock)).token).toBe(owner.token);
  });

  it("restores exact ancestry from authenticated private handoff metadata without raw logs", async () => {
    const { directory } = await setup();
    const store = new ConversationStore({ directory, namespace, referenceKey: "fictional-reference-key" });
    const summary = store.attachContext(ticket, "thread-from-handoff", "Saved useful operational context.");
    const reply = makeTicket({ task_id: ticket.task_id, ticket_id: "reply", thread_anchor_comment_id: "100" });
    const history = { inherited_context: { sourceCommentId: "100", content: summary } };
    expect(await store.resolve(reply, history)).toBe("thread-from-handoff");
    expect(summary).not.toContain("fictional-reference-key");
    const rotated = new ConversationStore({ directory, namespace, referenceKey: "rotated-fictional-key" });
    expect(await rotated.resolve(reply, {})).toBe("thread-from-handoff");
  });

  it("rejects unauthenticated, cross-task, cross-origin, and wrong-ancestor markers", async () => {
    const { directory } = await setup();
    const store = new ConversationStore({ directory, namespace, referenceKey: "fictional-reference-key" });
    const summary = store.attachContext(ticket, "thread-from-handoff", "context");
    const reply = makeTicket({ task_id: ticket.task_id, ticket_id: "reply", thread_anchor_comment_id: "100" });
    expect(await store.resolve(reply, { inherited_context: { sourceCommentId: "101", content: summary } })).toBeUndefined();
    expect(await store.resolve(reply, { inherited_context: { sourceCommentId: "100", content: summary.replace("v1:", "v1:A") } })).toBeUndefined();
    const history = { inherited_context: { sourceCommentId: "100", content: summary } };
    expect(await store.resolve(makeTicket({ ...reply, task_id: "other-task" }), history)).toBeUndefined();
    expect(await new ConversationStore({ directory, namespace: "different-origin", referenceKey: "fictional-reference-key" }).resolve(reply, history)).toBeUndefined();
    expect(await new ConversationStore({ directory, namespace, referenceKey: "wrong-key" }).resolve(reply, history)).toBeUndefined();
  });

  it("does not cross an unmapped AI ancestor to an older known conversation", async () => {
    const { store } = await setup();
    await store.bindResult(ticket, "old-thread", { success: true, comment_id: "100" });
    const reply = makeTicket({ task_id: ticket.task_id, ticket_id: "reply", thread_anchor_comment_id: "102" });
    expect(await store.resolve(reply, { comments: [
      { id: "102", replyToCommentId: "101", isAI: true }, { id: "101", replyToCommentId: "100", isAI: false }
    ] })).toBeUndefined();
  });

  it("authenticates same-ticket root requeues and replaces old markers within the API bound", async () => {
    const { directory } = await setup();
    const store = new ConversationStore({ directory, namespace, referenceKey: "fictional-reference-key" });
    const previous = store.attachContext(ticket, "older-thread", "saved context");
    const current = store.attachContext(ticket, "current-thread", `${previous}\n${"x".repeat(100_000)}`);
    expect(current.length).toBeLessThanOrEqual(100_000);
    expect(current.match(/tmatrix-conversation/g)).toHaveLength(1);
    expect(await store.resolve(ticket, { inherited_context: { sourceCommentId: "100", content: current } })).toBe("current-thread");
    expect(await store.resolve(makeTicket({ task_id: ticket.task_id, ticket_id: "another-root" }), { inherited_context: { sourceCommentId: "100", content: current } })).toBe("current-thread");
  });
});
