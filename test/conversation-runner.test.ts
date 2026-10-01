import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TicketApi } from "../src/api-client.js";
import { ConversationStore } from "../src/conversation-store.js";
import { RunCancellationError } from "../src/errors.js";
import { nullLogger } from "../src/logger.js";
import { Metrics } from "../src/metrics.js";
import { TicketRunner, type CodexLike, type WorkerThreadEvent } from "../src/runner.js";
import type { Ticket, TicketResult } from "../src/types.js";
import { deferred, makeTicket } from "./helpers.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function stores(referenceKey?: string) {
  const directory = await mkdtemp(join(tmpdir(), "tmatrix-conversation-runner-"));
  directories.push(directory);
  return () => new ConversationStore({ directory, namespace: "https://tasks.example.test", ...(referenceKey ? { referenceKey } : {}) });
}

function harness(store: ConversationStore, options: {
  threadId?: string;
  history?: unknown;
  commentId?: string;
  failTurn?: boolean;
  cannotResume?: boolean;
  beforeTurn?: (id: string) => Promise<void>;
  close?: () => Promise<void>;
  lifecycle?: boolean;
} = {}) {
  const threadSettings: unknown[] = [];
  const calls: { kind: "start" | "resume"; id: string }[] = [];
  const prompts: unknown[] = [];
  const results: TicketResult[] = [];
  const api: TicketApi = {
    markTaken: vi.fn(async () => undefined),
    getHistory: vi.fn(async () => options.history ?? {}),
    reportProgress: vi.fn(async () => undefined),
    reportResult: vi.fn(async (_ticket, result) => {
      results.push(result);
      return { success: true, comment_id: options.commentId ?? "result-root", context_comment_id: options.commentId ?? "result-root" };
    })
  };
  const thread = (id: string) => ({
    async runStreamed(input: unknown) {
      prompts.push(input);
      return { events: (async function* (): AsyncGenerator<WorkerThreadEvent> {
        yield { type: "thread.started", thread_id: id };
        await options.beforeTurn?.(id);
        yield { type: "turn.started" };
        if (options.failTurn) {
          yield { type: "turn.failed", error: { message: "Temporary runtime failure" } };
          return;
        }
        yield { type: "item.completed", item: { id: "result", type: "agent_message", text: JSON.stringify({ outcome: "AI_DONE", context_summary: "Saved handoff", user_message: "Ready." }) } };
        yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } };
      })() };
    }
  });
  const codex: CodexLike = {
    startThread: (settings) => { threadSettings.push(settings); const id = options.threadId ?? "conversation-root"; calls.push({ kind: "start", id }); return thread(id); },
    resumeThread: (id, settings) => { threadSettings.push(settings); calls.push({ kind: "resume", id }); return thread(id); },
    close: options.close ?? (async () => undefined)
  };
  if (options.cannotResume) delete codex.resumeThread;
  const factory = vi.fn(() => codex);
  const runner = new TicketRunner({ api, codexFactory: factory, logger: nullLogger(), metrics: new Metrics(), conversationStore: store, ...(options.lifecycle ? { worktreeLifecycle: { start: async () => "\nFULL_WORKTREE_CHECKLIST", end: async () => undefined } } : {}) });
  return { runner, calls, prompts, results, api, factory, threadSettings };
}

function ticket(id: string, anchor?: string): Ticket {
  return makeTicket({ ticket_id: id, worker_id: `worker-${id}`, task_id: "task-canonical", input_revision: 1,
    ...(anchor ? { thread_anchor_comment_id: anchor } : {}) });
}

describe("conversation continuity across worker tickets", () => {
  it("passes the recovered lease to the runtime and enables a safe resume fallback", async () => {
    const store = (await stores())();
    const previous = ticket("previous");
    await store.remember(previous, "saved-thread");
    const acquire = store.acquire.bind(store);
    vi.spyOn(store, "acquire").mockImplementation(async (...args) => Object.assign(await acquire(...args), {
      environment: { TMATRIX_CONVERSATION_LEASE: "fictional-runtime-lease" }, recovered: true
    }));
    const run = harness(store);
    const observe = vi.fn();
    await run.runner.run(ticket("retry"), { runId: "recovery", recovered: false, observe });
    expect(run.factory).toHaveBeenCalledWith(expect.anything(), { TMATRIX_CONVERSATION_LEASE: "fictional-runtime-lease" });
    expect(run.threadSettings[0]).toMatchObject({ rebuildOnResumeRejection: true });
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ kind: "conversation.recovered" }));
    expect(run.calls).toEqual([{ kind: "resume", id: "saved-thread" }]);
  });

  it("resumes a server task route without local comment links and reports its current reference", async () => {
    const store = (await stores())();
    const conversation = store.reference("server-thread");
    const run = harness(store, { history: { conversation, trigger_comment: { id: "trigger", content: "Continue" } } });
    await run.runner.run({ ...ticket("explicit"), conversation, trigger_comment_id: "trigger" }, { runId: "explicit", recovered: false });
    expect(run.calls).toEqual([{ kind: "resume", id: "server-thread" }]);
    expect(run.prompts[0]).toBe("Continue");
    expect(run.results[0]?.conversation).toEqual(conversation);
  });

  it("uses full recovery on a foreign server route instead of the old local task route", async () => {
    const store = (await stores())();
    await store.remember(ticket("old"), "old-local-thread");
    const conversation = { ...store.reference("foreign-thread"), scope: "other-engine" };
    const run = harness(store, { history: { conversation, task: { description: "Recovery context" }, trigger_comment: { id: "trigger", content: "Continue" } } });
    await run.runner.run({ ...ticket("foreign"), trigger_comment_id: "trigger" }, { runId: "foreign", recovered: false });
    expect(run.calls[0]?.kind).toBe("start");
    expect(run.prompts[0]).toContain("Recovery context");
    expect(run.results[0]?.conversation?.scope).toBe(store.reference("unused").scope);
  });

  it("persists the conversation before work and reuses it for successive replies after restart", async () => {
    const store = await stores();
    const root = ticket("root");
    const first = harness(store(), { beforeTurn: async (id) => { expect(await store().resolve(root, {})).toBe(id); } });
    await first.runner.run(root, { runId: "root-run", recovered: false });
    expect(first.calls).toEqual([{ kind: "start", id: "conversation-root" }]);

    // Each new store/runner models a restarted engine, with an unrelated ticket
    // and reset protocol revision. Reply count must not create new threads.
    let anchor = "result-root";
    for (let index = 1; index <= 4; index++) {
      const nextComment = `reply-result-${index}`;
      const next = harness(store(), { commentId: nextComment });
      await next.runner.run(ticket(`reply-${index}`, anchor), { runId: `reply-run-${index}`, recovered: false });
      expect(next.calls).toEqual([{ kind: "resume", id: "conversation-root" }]);
      expect(next.results[0]).toMatchObject({ status: "completed", input_revision: 1, thread_id: "conversation-root" });
      anchor = nextComment;
    }
  });

  it.each([false, true])("sends only the trigger on resume, retaining full input without resume support (%s)", async (cannotResume) => {
    const store = await stores();
    await harness(store(), { history: { task: { description: "OLD_DESCRIPTION" } } }).runner.run(ticket("root"), { runId: "root", recovered: false });
    const history = {
      input_revision: 1,
      trigger_comment: { id: "new-comment", content: "Please change the button label" },
      task: { description: "OLD_DESCRIPTION" },
      comments: [{ id: "old-comment", content: "OLD_COMMENT" }],
      inherited_context: { content: "OLD_HANDOFF" }
    };
    const reply = harness(store(), { history, cannotResume });
    const followup = { ...ticket("reply", "result-root"), trigger_comment_id: "new-comment", instructions: "FULL_INSTRUCTIONS" };
    await reply.runner.run(followup, { runId: "reply", recovered: false });
    expect(reply.prompts[0]).toContain("Please change the button label");
    for (const oldText of ["OLD_DESCRIPTION", "OLD_COMMENT", "OLD_HANDOFF", "FULL_INSTRUCTIONS"]) {
      if (cannotResume) expect(reply.prompts[0]).toContain(oldText);
      else expect(reply.prompts[0]).not.toContain(oldText);
    }
    expect(reply.results[0]).toMatchObject({ status: "completed", input_revision: 1 });
  });

  it("persists context deltas across restarts and does not repeat delivery rules", async () => {
    const store = await stores();
    const base = { task: { title: "Title", description: "Original" }, global_context: "Standing rules" };
    await harness(store(), { history: base, lifecycle: true }).runner.run(ticket("root"), { runId: "root", recovered: false });
    const run = async (id: string, description: string) => {
      const reply = harness(store(), { lifecycle: true, history: { ...base, task: { ...base.task, description }, input_revision: 1, trigger_comment: { id: "trigger", content: "New comment" } } });
      await reply.runner.run({ ...ticket(id, "result-root"), trigger_comment_id: "trigger" }, { runId: id, recovered: false });
      return reply.prompts[0];
    };
    expect(await run("unchanged", "Original")).toBe("New comment\n\nCurrent worktree session: unchanged");
    const changed = await run("changed", "Revised");
    expect(changed).toContain('"task.description": "Revised"');
    expect(changed).not.toContain("Standing rules");
    expect(changed).not.toContain("FULL_WORKTREE_CHECKLIST");
    expect(await run("again", "Revised")).toBe("New comment\n\nCurrent worktree session: again");
    expect(await run("cleared", "")).toContain('"task.description": ""');
  });

  it("does not advance the context baseline after a failed turn and reuses it across task replies", async () => {
    const store = await stores();
    const base = { task: { description: "Original" } };
    await harness(store(), { history: base, threadId: "a", commentId: "branch-a" }).runner.run(ticket("a"), { runId: "a", recovered: false });
    await harness(store(), { history: base, threadId: "b", commentId: "branch-b" }).runner.run(ticket("b"), { runId: "b", recovered: false });
    const history = { task: { description: "Revised" }, trigger_comment: { id: "trigger", content: "Update" } };
    const followup = { ...ticket("failed", "branch-a"), trigger_comment_id: "trigger" };
    await harness(store(), { history, failTurn: true }).runner.run(followup, { runId: "failed", recovered: false });
    const retry = harness(store(), { history });
    await retry.runner.run(followup, { runId: "retry", recovered: true });
    expect(retry.prompts[0]).toContain("Revised");
    const other = harness(store(), { history });
    await other.runner.run({ ...followup, ticket_id: "other", thread_anchor_comment_id: "branch-b" }, { runId: "other", recovered: false });
    expect(other.prompts[0]).toBe("Update");
    expect(other.calls).toEqual([{ kind: "resume", id: "a" }]);
  });

  it("refreshes unknown legacy context once without replaying history", async () => {
    const store = await stores();
    await store().remember(ticket("root"), "legacy-thread");
    await store().bindResult(ticket("root"), "legacy-thread", { success: true, comment_id: "result-root" });
    const history = { task: { description: "Existing context" }, trigger_comment: { id: "trigger", content: "New comment" }, comments: [{ content: "OLD_COMMENT" }] };
    const followup = { ...ticket("reply", "result-root"), trigger_comment_id: "trigger" };
    const first = harness(store(), { history });
    await first.runner.run(followup, { runId: "one", recovered: false });
    expect(first.prompts[0]).toContain("Existing context");
    expect(first.prompts[0]).not.toContain("OLD_COMMENT");
    const next = harness(store(), { history });
    await next.runner.run({ ...followup, ticket_id: "next" }, { runId: "two", recovered: false });
    expect(next.prompts[0]).toBe("New comment");
  });

  it("continues the task conversation even when replies name older comments", async () => {
    const store = await stores();
    await harness(store(), { commentId: "branch-a", threadId: "thread-a" }).runner.run(ticket("root-a"), { runId: "a", recovered: false });
    await harness(store(), { commentId: "branch-b", threadId: "thread-b" }).runner.run(ticket("root-b"), { runId: "b", recovered: false });
    const reply = harness(store(), { history: { comments: [{ id: "human-followup", isAI: false, replyToCommentId: "branch-a" }] } });
    await reply.runner.run(ticket("reply-a", "human-followup"), { runId: "reply-a", recovered: false });
    expect(reply.calls).toEqual([{ kind: "resume", id: "thread-a" }]);
  });

  it("restores the exact conversation from a signed private handoff on a fresh installation", async () => {
    const firstStore = await stores("test-reference-secret");
    const first = harness(firstStore(), { commentId: "signed-result", threadId: "thread-signed" });
    await first.runner.run(ticket("first-signed"), { runId: "signed", recovered: false });
    const savedContext = first.results[0]?.context_summary;
    expect(savedContext).toContain("<!-- tmatrix-conversation:v1:");
    expect(savedContext).not.toContain("test-reference-secret");
    expect(first.results[0]?.user_message).toBe("Ready.");

    const freshStore = await stores("test-reference-secret");
    const reply = harness(freshStore(), { history: {
      inherited_context: { sourceCommentId: "signed-result", content: savedContext },
      comments: [{ id: "signed-result", isAI: true, replyToCommentId: null }]
    } });
    await reply.runner.run(ticket("signed-reply", "signed-result"), { runId: "signed-reply", recovered: false });
    expect(reply.calls).toEqual([{ kind: "resume", id: "thread-signed" }]);
    expect(await freshStore().resolve(ticket("signed-reply"), {})).toBe("thread-signed");
  });

  it("keeps an accepted result completed when its local comment link cannot be indexed", async () => {
    const store = (await stores("test-reference-secret"))();
    vi.spyOn(store, "bindResult").mockRejectedValue(new Error("Local storage unavailable"));
    const run = harness(store);
    const events: { kind: string; text: string }[] = [];
    expect(await run.runner.run(ticket("index-failed"), { runId: "index-failed", recovered: false, observe: (event) => events.push(event) })).toMatchObject({ status: "completed" });
    expect(run.calls).toHaveLength(1);
    expect(run.results).toHaveLength(1);
    expect(run.results[0]?.context_summary).toContain("<!-- tmatrix-conversation:v1:");
    expect(events).toContainEqual(expect.objectContaining({ kind: "conversation.link_warning" }));
  });

  it("recovers an interrupted ticket in its already-persisted conversation", async () => {
    const store = await stores();
    const interrupted = ticket("interrupted");
    const first = harness(store(), { threadId: "thread-interrupted", failTurn: true });
    await first.runner.run(interrupted, { runId: "failed", recovered: false });
    const retry = harness(store());
    await retry.runner.run(interrupted, { runId: "recover", recovered: true });
    expect(retry.calls).toEqual([{ kind: "resume", id: "thread-interrupted" }]);
  });

  it("does not overwrite successful reply mappings with a failed result receipt", async () => {
    const store = await stores();
    await harness(store(), { threadId: "thread-success" }).runner.run(ticket("success"), { runId: "success", recovered: false });
    const failed = harness(store(), { threadId: "thread-failed", failTurn: true });
    await failed.runner.run(ticket("failed"), { runId: "failed", recovered: false });
    expect(await store().resolve(ticket("reply", "result-root"), {})).toBe("thread-success");
  });

  it("starts from durable context when an older reply has no saved mapping and persists the new link", async () => {
    const store = await stores();
    const history = {
      comments: [{ id: "unknown-old-result", content: "Completed the first step" }],
      inherited_context: { sourceCommentId: "unknown-old-result", content: "Continue with step two" }
    };
    const run = harness(store(), { history });
    const events: { kind: string; text: string }[] = [];
    const legacy = ticket("legacy-reply", "unknown-old-result");
    await run.runner.run(legacy, { runId: "legacy", recovered: false, observe: (event) => events.push(event) });
    expect(run.calls).toEqual([{ kind: "start", id: "conversation-root" }]);
    expect(run.results[0]).toMatchObject({ status: "completed", thread_id: "conversation-root" });
    expect(run.prompts[0]).toContain(legacy.instructions);
    expect(run.prompts[0]).toContain(JSON.stringify(history, null, 2));
    expect(events).toContainEqual(expect.objectContaining({ kind: "conversation.unlinked" }));
    expect(await store().resolve(legacy, {})).toBe("conversation-root");
    const reply = harness(store());
    await reply.runner.run(ticket("next-reply", "result-root"), { runId: "next", recovered: false });
    expect(reply.calls).toEqual([{ kind: "resume", id: "conversation-root" }]);
  });

  it("replaces the saved link when the runtime does not support resume", async () => {
    const store = await stores();
    await harness(store(), { threadId: "old-thread" }).runner.run(ticket("root"), { runId: "root", recovered: false });
    const reply = harness(store(), { cannotResume: true, threadId: "new-thread" });
    await reply.runner.run(ticket("reply", "result-root"), { runId: "reply", recovered: false });
    expect(reply.calls).toEqual([{ kind: "start", id: "new-thread" }]);
    expect(reply.results[0]).toMatchObject({ status: "completed", thread_id: "new-thread" });
    expect(await store().resolve(ticket("next", "result-root"), {})).toBe("new-thread");
  });

  it("holds a task's conversation until teardown and receipt binding, then resumes the waiting reply", async () => {
    const store = await stores();
    const closing = deferred<void>();
    const closed = deferred<void>();
    const first = harness(store(), { close: async () => { closing.resolve(); await closed.promise; } });
    const firstRun = first.runner.run(ticket("first"), { runId: "first", recovered: false });
    await closing.promise;
    const second = harness(store());
    const secondRun = second.runner.run(ticket("second", "result-root"), { runId: "second", recovered: false });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(second.calls).toEqual([]);
    closed.resolve();
    await Promise.all([firstRun, secondRun]);
    expect(second.calls).toEqual([{ kind: "resume", id: "conversation-root" }]);
  });

  it("cancels while waiting for the task conversation without starting another runtime", async () => {
    const store = await stores();
    const release = await store().acquire(ticket("active"));
    const controller = new AbortController();
    const waitingTicket = ticket("waiting", "result-root");
    const waiting = harness(store());
    const pending = waiting.runner.run(waitingTicket, { runId: "waiting", recovered: false, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort(new RunCancellationError({ kind: "user", ticketId: waitingTicket.ticket_id, workerId: waitingTicket.worker_id }));
    expect(await pending).toEqual({ status: "cancelled" });
    expect(waiting.calls).toEqual([]);
    expect(waiting.results).toEqual([]);
    await release();
  });
});
