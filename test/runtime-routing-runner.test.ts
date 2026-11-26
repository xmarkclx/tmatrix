import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TicketApi } from "../src/api-client.js";
import { ConversationStore } from "../src/conversation-store.js";
import { WorkerError } from "../src/errors.js";
import { LocalWorkerState } from "../src/local-worker-state.js";
import { nullLogger } from "../src/logger.js";
import { Metrics } from "../src/metrics.js";
import { SteeringMailbox, TicketRunner, type RuntimeSelection } from "../src/runner.js";
import type { Input, ThreadLike, WorkerThreadEvent } from "../src/runtime-adapter.js";
import type { TicketResult } from "../src/types.js";
import { makeTicket } from "./helpers.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const currentBoot = { machine: "fixture-machine", boot: "c880f57f-1051-4e50-9dfd-be26a5998305" };
const previousBoot = { ...currentBoot, boot: "56505428-414a-47db-949a-85f9b1525251" };
const usage = { input_tokens: 12, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 8, reasoning_output_tokens: 0 };

function text(input: Input): string {
  if (typeof input === "string") return input;
  return input.map(part => part.type === "text" ? part.text : part.path).join("\n");
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "tmatrix-runtime-routing-"));
  directories.push(directory);
  const store = (adapterId: string, identity = currentBoot) => new ConversationStore({
    directory, namespace: "fixture-source", adapterId, referenceKey: "fixture-reference-key",
    bootIdentity: async () => identity
  });
  const codex = store("codex");
  const claude = store("claude");
  const calls: string[] = [];
  const inputs: string[] = [];
  const results: TicketResult[] = [];
  const steering = new SteeringMailbox();
  const ticket = makeTicket({ task_id: "fixture-task", input_revision: 3, instructions: "Read the release requirements." });
  const api: TicketApi = {
    markTaken: vi.fn(async () => undefined),
    getHistory: vi.fn(async () => ({
      task: { description: "Launch after approval only." },
      inherited_context: { content: "Previously verified staging." },
      conversation: codex.reference("prior-codex")
    })),
    reportProgress: vi.fn(async () => undefined),
    reportResult: vi.fn(async (_ticket, result) => {
      results.push(result);
      return { success: true, comment_id: "result-comment" };
    })
  };

  function route(id: "codex" | "claude", options: {
    thread?: string;
    followUp?: string;
    failTurn?: boolean;
    failClose?: boolean;
    replacementOnResume?: string;
    assertCurrent?: () => Promise<void>;
    contextSummary?: string;
  } = {}): RuntimeSelection {
    const threadFor = (threadId: string, model: string): ThreadLike => ({
      async runStreamed(input, turnOptions) {
        inputs.push(text(input));
        return {
          events: (async function* (): AsyncGenerator<WorkerThreadEvent> {
            yield { type: "thread.started", thread_id: threadId };
            await turnOptions?.beforeStart?.();
            yield { type: "turn.started" };
            if (options.followUp) steering.enqueueLocal(`follow-up-${threadId}`, options.followUp);
            if (options.failTurn) {
              yield { type: "item.completed", item: {
                type: "command_execution", id: "ran-command", command: "example",
                aggregated_output: "wrote fixture", status: "completed", exit_code: 0
              } };
              yield { type: "turn.failed", error: { message: "Runtime disconnected mid-turn" } };
              return;
            }
            yield { type: "item.completed", item: { type: "agent_message", id: "message", text: JSON.stringify({
              outcome: "AI_DONE", user_message: `Finished with ${model}.`, context_summary: options.contextSummary ?? `Completed fixture step on ${threadId}.`
            }) } };
            yield { type: "turn.completed", usage };
          })()
        };
      }
    });
    return {
      id,
      label: id === "codex" ? "Codex plan" : "Claude plan",
      conversationStore: id === "codex" ? codex : claude,
      ...(options.assertCurrent ? { assertCurrent: options.assertCurrent } : {}),
      ...(id === "claude" ? { model: () => "sonnet" } : {}),
      runtimeFactory() {
        return {
          startThread({ model }) {
            const thread = options.thread ?? `${id}-fresh`;
            calls.push(`start ${thread}`);
            return threadFor(thread, model);
          },
          resumeThread(thread, { model }) {
            calls.push(`resume ${thread}`);
            return threadFor(options.replacementOnResume ?? thread, model);
          },
          async close() {
            calls.push(`close ${id}`);
            if (options.failClose) throw new Error("Runtime process still running");
          }
        };
      }
    };
  }

  function run(selected: (RuntimeSelection | WorkerError)[], recovered = false) {
    const pending = [...selected];
    const local = new LocalWorkerState();
    local.start(ticket);
    const selectRuntime = vi.fn(async () => {
      const next = pending.shift();
      if (!next) throw new Error("Unexpected selection");
      if (next instanceof WorkerError) throw next;
      return next;
    });
    const runner = new TicketRunner({
      api, runtimeFactory: route("codex").runtimeFactory, conversationStore: codex,
      selectRuntime, logger: nullLogger(), metrics: new Metrics()
    });
    const result = runner.run(ticket, {
      runId: "fixture-run", recovered, steering,
      observe: event => local.record(ticket.worker_id, event)
    });
    return { local, result, selectRuntime };
  }

  return { codex, claude, store, ticket, api, calls, inputs, results, route, run };
}

describe("automatic runtime routing at turn boundaries", () => {
  it("explains a fresh conversation on another provider when the saved one's plan is spent", async () => {
    const { calls, inputs, route, run } = await fixture();
    const { result } = run([route("claude")]);
    await expect(result).resolves.toMatchObject({ status: "completed" });
    expect(calls[0]).toBe("start claude-fresh");
    expect(inputs[0]).toMatch(/^# Provider change\nContinued on Claude because the Codex plan allowance/);
    expect(inputs[0]).toContain("Previously verified staging.");
  });

  it("uses one claim and continues from the previous handoff when switching providers", async () => {
    const { codex, claude, ticket, api, calls, inputs, results, route, run } = await fixture();
    const first = route("codex", { followUp: "Add the staging summary." });
    const second = route("claude", { followUp: "Add the release link." });
    const last = { ...route("codex", { thread: "codex-credits" }), label: "Codex credits" };
    const { local, result, selectRuntime } = run([first, second, last]);
    await expect(result).resolves.toEqual({ status: "completed", threadId: "codex-credits" });
    expect(api.markTaken).toHaveBeenCalledTimes(1);
    expect(selectRuntime).toHaveBeenCalledTimes(3);
    // Routing is asked to keep the runtime that holds the saved, then the active, conversation.
    expect(selectRuntime.mock.calls.map(call => (call as unknown[])[3])).toEqual(["codex", "codex", "claude"]);
    expect(calls).toEqual([
      "resume prior-codex", "close codex", "start claude-fresh", "close claude", "start codex-credits", "close codex"
    ]);
    // Each switch tells the runtime why the task moved and asks it to tell the person.
    expect(inputs[0]).not.toContain("# Provider change");
    expect(inputs[1]).toContain("# Provider change\nContinued on Claude because the Codex plan allowance was used up or could not be confirmed. Current route: Claude plan.");
    expect(inputs[1]).toContain("Start user_message with one short sentence telling the person that this reply continued on Claude and why.");
    expect(inputs[2]).toContain("Continued on Codex because the Claude plan allowance was used up or could not be confirmed. Current route: Codex credits.");
    expect(local.snapshot()[0]?.activity.filter(entry => entry.kind === "runtime.switched")).toHaveLength(2);
    expect(inputs[1]).toContain("Previously verified staging.");
    expect(inputs[1]).toContain("Completed fixture step on prior-codex.");
    expect(inputs[1]).toContain("Add the staging summary.");
    expect(inputs[2]).toContain("Completed fixture step on claude-fresh.");
    expect(inputs[2]).toContain("Add the release link.");
    expect(results).toEqual([expect.objectContaining({
      conversation: codex.reference("codex-credits"), input_revision: 3, status: "completed"
    })]);
    expect(await claude.resolve({ ...ticket, ticket_id: "another-ticket" }, {})).toBe("claude-fresh");
    expect(local.snapshot()[0]).toMatchObject({
      worker_type: "codex", model: "gpt-5.6-sol", thread_id: "codex-credits",
      activity: expect.arrayContaining([
        expect.objectContaining({ kind: "runtime.selected", text: "Claude plan" }),
        expect.objectContaining({ kind: "runtime.selected", text: "Codex credits" })
      ])
    });
  });

  it("creates a Claude conversation from durable context when the saved provider is Codex", async () => {
    const { claude, calls, inputs, results, route, run } = await fixture();
    const { local, result } = run([route("claude")]);
    await expect(result).resolves.toEqual({ status: "completed", threadId: "claude-fresh" });
    expect(calls).toEqual(["start claude-fresh", "close claude"]);
    expect(inputs[0]).toContain("Read the release requirements.");
    expect(inputs[0]).toContain("Previously verified staging.");
    expect(local.snapshot()[0]).toMatchObject({ worker_type: "claude", model: "sonnet" });
    expect(results[0]).toMatchObject({
      conversation: claude.reference("claude-fresh"), user_message: "Finished with sonnet."
    });
  });

  it("does not start another runtime after a failed turn that may have written changes", async () => {
    const { calls, results, route, run } = await fixture();
    const { result, selectRuntime } = run([route("codex", { followUp: "Try the alternate provider.", failTurn: true }), route("claude")]);
    await expect(result).resolves.toEqual({ status: "failed", threadId: "prior-codex" });
    expect(selectRuntime).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["resume prior-codex", "close codex"]);
    expect(results[0]).toMatchObject({ status: "failed", error: { code: "CODEX_TURN_FAILED" } });
  });

  it("saves completed work and the pending follow-up when the next quota check cannot select a provider", async () => {
    const { codex, calls, inputs, results, route, run } = await fixture();
    const hold = new WorkerError({ code: "RUNTIME_QUOTA_UNAVAILABLE", stage: "runtime.route", message: "No verified plan allowance." });
    const { result } = run([route("codex", {
      followUp: "Add the staging summary.", contextSummary: "A".repeat(100_000)
    }), hold]);
    await expect(result).resolves.toEqual({ status: "completed", threadId: "prior-codex" });
    expect(calls).toEqual(["resume prior-codex", "close codex"]);
    expect(inputs).toHaveLength(1);
    expect(results[0]).toMatchObject({
      status: "completed", outcome: "AI_NEEDS_FEEDBACK", conversation: codex.reference("prior-codex"),
      user_message: expect.stringContaining("Finished with gpt-5.6-sol."),
      context_summary: expect.stringContaining("Queued local message: Add the staging summary.")
    });
    expect(results[0]?.user_message).toContain("The queued follow-up did not start.");
    expect(results[0]?.context_summary).toHaveLength(100_000);
    expect(results[0]?.context_summary).toMatch(/<!-- tmatrix-conversation:v1:/);
  });

  it("preserves the established route when a replacement is rejected before dispatch", async () => {
    const { codex, ticket, results, route, run } = await fixture();
    const { result } = run([route("codex", {
      replacementOnResume: "empty-codex",
      async assertCurrent() {
        throw new WorkerError({ code: "RUNTIME_QUOTA_UNAVAILABLE", stage: "runtime.route", message: "No included allowance." });
      }
    })]);
    await expect(result).resolves.toMatchObject({ status: "failed" });
    expect(results[0]).toMatchObject({ status: "failed", error: { code: "RUNTIME_QUOTA_UNAVAILABLE" } });
    expect(results[0]?.thread_id).toBeUndefined();
    expect(await codex.resolve(ticket, { conversation: codex.reference("prior-codex") })).toBe("prior-codex");
  });

  it("resumes the interrupted provider's exact thread even if the server still reports a completed Codex route", async () => {
    const { claude, store, ticket, calls, inputs, results, route, run } = await fixture();
    const previous = await store("codex", previousBoot).acquire(ticket);
    await previous.rememberRuntime?.("claude", claude.reference("interrupted-claude"));
    const { result } = run([route("claude")], true);
    await expect(result).resolves.toEqual({ status: "completed", threadId: "interrupted-claude" });
    expect(calls).toEqual(["resume interrupted-claude", "close claude"]);
    expect(inputs[0]).toContain("Verify earlier side effects before acting");
    expect(results[0]).toMatchObject({ conversation: claude.reference("interrupted-claude") });
  });

  it("recovers the saved provider after another interruption before dispatch", async () => {
    const { claude, store, ticket, calls, route, run } = await fixture();
    const stalled = await store("codex", { ...previousBoot, boot: "4adc1e64-761b-481a-b125-bfe01ffcd268" }).acquire(ticket);
    await stalled.rememberRuntime?.("claude", claude.reference("interrupted-claude"));
    const second = await store("codex", previousBoot).acquire(ticket);
    expect(second.recoveredAttempt?.conversation).toEqual(claude.reference("interrupted-claude"));

    const { result } = run([route("claude")], true);
    await expect(result).resolves.toEqual({ status: "completed", threadId: "interrupted-claude" });
    expect(calls).toEqual(["resume interrupted-claude", "close claude"]);
  });

  it("allows a new ticket to switch providers after recovering an older ticket's stale task lock", async () => {
    const { codex, store, ticket, calls, route, run } = await fixture();
    const previous = await store("codex", previousBoot).acquire({ ...ticket, ticket_id: "prior-ticket" });
    await previous.rememberRuntime?.("codex", codex.reference("prior-codex"));
    const { result } = run([route("claude")]);
    await expect(result).resolves.toEqual({ status: "completed", threadId: "claude-fresh" });
    expect(calls).toEqual(["start claude-fresh", "close claude"]);
  });

  it("declines ambiguous recovery on a different provider before sending the ticket prompt", async () => {
    const { store, ticket, calls, results, route, run } = await fixture();
    const previous = await store("codex", previousBoot).acquire(ticket);
    await previous.rememberRuntime?.("codex");
    const { result } = run([route("claude")], true);
    await expect(result).resolves.toEqual({ status: "failed" });
    expect(calls).toEqual([]);
    expect(results[0]).toMatchObject({ status: "failed", error: { code: "RUNTIME_RECOVERY_PROVIDER_CHANGED" } });
  });

  it("does not continue on a replacement thread during interrupted-run recovery", async () => {
    const { codex, store, ticket, calls, results, route, run } = await fixture();
    const previous = await store("codex", previousBoot).acquire(ticket);
    await previous.rememberRuntime?.("codex", codex.reference("interrupted-codex"));
    const { result } = run([route("codex", { replacementOnResume: "another-codex" })], true);
    await expect(result).resolves.toEqual({ status: "failed" });
    expect(calls).toEqual(["resume interrupted-codex", "close codex"]);
    expect(results[0]).toMatchObject({ status: "failed", error: { code: "RUNTIME_RECOVERY_UNVERIFIED" } });
  });

  it("keeps the task lease when the old runtime cannot confirm its teardown", async () => {
    const { claude, ticket, calls, results, route, run } = await fixture();
    const { result } = run([route("codex", { followUp: "Add the staging link.", failClose: true }), route("claude")]);
    await expect(result).resolves.toEqual({ status: "failed", threadId: "prior-codex" });
    expect(calls).toEqual(["resume prior-codex", "close codex"]);
    await expect(claude.acquire(ticket, AbortSignal.timeout(50))).rejects.toMatchObject({ name: "AbortError" });
    expect(results[0]).toMatchObject({ status: "failed", error: { code: "CODEX_RUN_FAILED" } });
  });
});
