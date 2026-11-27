import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { chooseFundingRoute, geminiModel, selectAccountRuntime } from "../src/runtime-routing.js";
import type { Input, ReadRuntimeQuota, ThreadLike, WorkerThreadEvent } from "../src/runtime-adapter.js";
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
  const store = (adapterId: string, identity = currentBoot, account?: string) => new ConversationStore({
    directory, namespace: "fixture-source", adapterId, referenceKey: "fixture-reference-key",
    ...(account ? { account, runtimeHome: join(directory, account) } : {}),
    bootIdentity: async () => identity
  });
  const codex = store("codex");
  const claude = store("claude");
  const gemini = store("gemini");
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

  function route(id: "codex" | "claude" | "gemini", options: {
    thread?: string;
    followUp?: string;
    failTurn?: boolean;
    turnError?: WorkerError;
    failClose?: boolean;
    replacementOnResume?: string;
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
            if (options.turnError) throw options.turnError;
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
      label: { codex: "Codex plan", claude: "Claude plan", gemini: "Gemini" }[id],
      conversationStore: { codex, claude, gemini }[id],
      ...(id === "claude" ? { model: () => "sonnet" } : id === "gemini" ? { model: geminiModel } : {}),
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

  function run(selected: (RuntimeSelection | WorkerError)[] | NonNullable<ConstructorParameters<typeof TicketRunner>[0]["selectRuntime"]>, recovered = false) {
    const pending = Array.isArray(selected) ? [...selected] : [];
    const local = new LocalWorkerState();
    local.start(ticket);
    const selectRuntime = vi.fn(typeof selected === "function" ? selected : async () => {
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

  return { directory, codex, claude, gemini, store, ticket, api, calls, inputs, results, route, run };
}

async function accountFixture() {
  const fixtureState = await fixture();
  const { store, claude, route, ticket } = fixtureState;
  ticket.model = "sonnet";
  const work = store("claude", currentBoot, "work");
  const accounts = [{ label: "default", environment: {} },
    { label: "work", directory: "/fixture/work", environment: { CLAUDE_CONFIG_DIR: "/fixture/work" } }];
  const cursors = new Map<string, string>();
  function select(readQuota: ReadRuntimeQuota, workFollowUp?: string): NonNullable<ConstructorParameters<typeof TicketRunner>[0]["selectRuntime"]> {
    return (signal, cwd, model, context) => selectAccountRuntime({
      provider: "claude", accounts, cursors, signal, cwd, model, context, readQuota,
      storeFor: account => account.directory ? work : claude,
      runtimeFactory: (profile, lease, environment) => route("claude", {
        thread: environment?.CLAUDE_CONFIG_DIR === "/fixture/work" ? "work-fresh" : "default-fresh",
        ...(environment && workFollowUp ? { followUp: workFollowUp } : {})
      }).runtimeFactory(profile, lease)
    });
  }
  return { ...fixtureState, work, select };
}

describe("conversation account routing", () => {
  it("resumes a recorded account even when another has lower usage", async () => {
    const { api, ticket, work, select, run, calls, results } = await accountFixture();
    await work.remember(ticket, "prior-work");
    vi.mocked(api.getHistory).mockResolvedValue({ task: { description: "Keep the existing session." } });
    const { result, local } = run(select(async (_signal, _cwd, _model, environment) => ({
      plan: "available", usedPercent: environment ? 90 : 5
    })));
    await expect(result).resolves.toMatchObject({ status: "completed" });
    expect(calls).toEqual(["resume prior-work", "close claude"]);
    expect(results[0]).toMatchObject({ conversation: work.reference("prior-work") });
    expect(local.snapshot()).toEqual(expect.arrayContaining([expect.objectContaining({
      account: "work", runtime_label: "Claude (work)",
      activity: expect.arrayContaining([expect.objectContaining({ text: "Claude (work)" })])
    })]));
  });

  it("resumes a legacy conversation from the implicit default account", async () => {
    const { api, directory, ticket, claude, select, run, calls, results } = await accountFixture();
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    const legacyDirectory = join(directory, hash(JSON.stringify(["fixture-source", "claude"])));
    await mkdir(legacyDirectory, { mode: 0o700 });
    await writeFile(join(legacyDirectory, `${hash("fixture-task")}.json`), JSON.stringify({
      version: 1, task: "fixture-task", activeThread: "legacy-claude", tickets: { [ticket.ticket_id]: "legacy-claude" },
      comments: {}, replacements: {}
    }), { mode: 0o600 });
    vi.mocked(api.getHistory).mockResolvedValue({ task: { description: "Keep the legacy session." } });
    const { result } = run(select(async (_signal, _cwd, _model, environment) => ({
      plan: "available", usedPercent: environment ? 5 : 90
    })));
    await expect(result).resolves.toMatchObject({ status: "completed" });
    expect(calls).toEqual(["resume legacy-claude", "close claude"]);
    expect(results[0]).toMatchObject({ conversation: claude.reference("legacy-claude") });
  });

  it("rebuilds from the durable handoff when the recorded account is exhausted", async () => {
    const { api, ticket, work, claude, select, run, calls, inputs, results } = await accountFixture();
    await claude.remember(ticket, "older-default");
    await work.remember(ticket, "prior-work");
    vi.mocked(api.getHistory).mockResolvedValue({
      task: { description: "Launch after approval only." },
      inherited_context: { content: "Previously verified staging." },
      conversation: work.reference("prior-work")
    });
    const { result } = run(select(async (_signal, _cwd, _model, environment) => ({
      plan: environment ? "exhausted" : "available"
    })));
    await expect(result).resolves.toMatchObject({ status: "completed" });
    expect(calls).toEqual(["start default-fresh", "close claude"]);
    expect(inputs[0]).toContain("Previously verified staging.");
    expect(results[0]).toMatchObject({ conversation: claude.reference("default-fresh") });
    await expect(work.recordedAccount(ticket)).resolves.toBe("default");
  });

  it("changes accounts before a queued follow-up and carries the previous turn's handoff", async () => {
    const { api, select, run, calls, inputs } = await accountFixture();
    vi.mocked(api.getHistory).mockResolvedValue({ task: { description: "Use the least-used account." } });
    let workProbes = 0;
    const { result } = run(select(async (_signal, _cwd, _model, environment) => {
      if (environment) return ++workProbes === 1 ? { plan: "available", usedPercent: 1 } : { plan: "exhausted" };
      return { plan: "available", usedPercent: 50 };
    }, "Check the result once more."));
    await expect(result).resolves.toMatchObject({ status: "completed" });
    expect(calls).toEqual(["start work-fresh", "close claude", "start default-fresh", "close claude"]);
    expect(inputs[1]).toContain("Completed fixture step on work-fresh.");
    expect(inputs[1]).toContain("Check the result once more.");
  });
});

describe("Gemini model selection through the ticket runner", () => {
  it("dispatches a Neon model with its original ID and resumes the provider-scoped conversation", async () => {
    const { gemini, ticket, api, calls, inputs, results, route, run } = await fixture();
    ticket.model = "gemini-4-neon-xhigh";
    vi.mocked(api.getHistory).mockResolvedValue({
      conversation: gemini.reference("prior-gemini"), context_summary: "Gemini context."
    });
    const otherProviderProbe = vi.fn(async () => ({ plan: "available" as const }));
    const { result } = run(async (signal, _cwd, model) => {
      const funding = await chooseFundingRoute({ model, ...(signal ? { signal } : {}), cursors: new Map(),
        accounts: async provider => ({ readings: [{ account: "default",
          quota: provider === "codex" ? await otherProviderProbe() : { plan: "unknown" } }] }) });
      if (funding.provider !== "gemini") throw new Error(`Unexpected provider: ${funding.provider}`);
      return route(funding.provider);
    });

    await expect(result).resolves.toMatchObject({ status: "completed" });
    expect(otherProviderProbe).not.toHaveBeenCalled();
    expect(calls).toEqual(["resume prior-gemini", "close gemini"]);
    expect(inputs[0]).toContain("Read the release requirements.");
    expect(results[0]).toMatchObject({
      user_message: "Finished with gemini-4-neon-xhigh.", conversation: gemini.reference("prior-gemini")
    });
  });

  it("resumes a Gemini attempt after recovering the shared task lease", async () => {
    const { gemini, store, ticket, calls, results, route, run } = await fixture();
    ticket.model = "gemini-4-neon-low";
    const previous = await store("codex", previousBoot).acquire(ticket);
    await previous.rememberRuntime?.("gemini", gemini.reference("interrupted-gemini"));
    const { result, selectRuntime } = run([route("gemini")], true);
    await expect(result).resolves.toMatchObject({ status: "completed", threadId: "interrupted-gemini" });
    expect(selectRuntime).toHaveBeenCalledWith(undefined, expect.any(String), "gemini-4-neon-low", expect.any(Object));
    expect(calls).toEqual(["resume interrupted-gemini", "close gemini"]);
    expect(results[0]).toMatchObject({ conversation: gemini.reference("interrupted-gemini") });
  });

  it("reports an agy turn failure without changing providers", async () => {
    const { ticket, calls, results, route, run } = await fixture();
    ticket.model = "gemini-4-neon-high";
    const unavailable = new WorkerError({ code: "GEMINI_UNAVAILABLE", stage: "gemini.run", message: "Could not start Antigravity." });
    const { result, selectRuntime } = run([route("gemini", { turnError: unavailable }), route("codex")]);
    await expect(result).resolves.toMatchObject({ status: "failed" });
    expect(selectRuntime).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["start gemini-fresh", "close gemini"]);
    expect(results[0]).toMatchObject({ error: { code: "GEMINI_UNAVAILABLE" } });
  });
});

describe("automatic runtime routing at turn boundaries", () => {
  it("explains a fresh conversation on another provider when the task's model runs there", async () => {
    const { calls, inputs, route, run } = await fixture();
    const { result } = run([route("claude")]);
    await expect(result).resolves.toMatchObject({ status: "completed" });
    expect(calls[0]).toBe("start claude-fresh");
    expect(inputs[0]).toMatch(/^# Provider change\nContinued on Claude because the task's selected model runs there; the earlier conversation was on Codex\./);
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
    expect(calls).toEqual([
      "resume prior-codex", "close codex", "start claude-fresh", "close claude", "start codex-credits", "close codex"
    ]);
    // Each switch tells the runtime why the task moved and asks it to tell the person.
    expect(inputs[0]).not.toContain("# Provider change");
    expect(inputs[1]).toContain("# Provider change\nContinued on Claude because the task's selected model runs there; the earlier conversation was on Codex. Current route: Claude plan.");
    expect(inputs[1]).toContain("Start user_message with one short sentence telling the person that this reply continued on Claude and why.");
    expect(inputs[2]).toContain("Continued on Codex because the task's selected model runs there; the earlier conversation was on Claude. Current route: Codex credits.");
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

  it("fails a Claude usage-limit turn instead of switching to another model", async () => {
    const { calls, results, route, run } = await fixture();
    const limit = new WorkerError({ code: "CLAUDE_USAGE_LIMIT", stage: "claude.turn", message: "Usage limit reached" });
    const { result, selectRuntime } = run([route("claude", { turnError: limit }), route("codex")]);
    await expect(result).resolves.toEqual({ status: "failed", threadId: "claude-fresh" });
    expect(selectRuntime).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["start claude-fresh", "close claude"]);
    expect(results[0]).toMatchObject({ status: "failed", error: { code: "CLAUDE_USAGE_LIMIT" } });
  });

  it("does not start another runtime after a non-limit Claude failure", async () => {
    const { calls, results, route, run } = await fixture();
    const error = new WorkerError({ code: "CLAUDE_TURN_FAILED", stage: "claude.turn", message: "Claude Code disconnected" });
    const { result, selectRuntime } = run([route("claude", { turnError: error }), route("codex")]);
    await expect(result).resolves.toEqual({ status: "failed", threadId: "claude-fresh" });
    expect(selectRuntime).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["start claude-fresh", "close claude"]);
    expect(results[0]).toMatchObject({ status: "failed", error: { code: "CLAUDE_TURN_FAILED" } });
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
