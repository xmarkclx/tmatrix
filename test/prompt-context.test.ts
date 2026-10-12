import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConversationStore } from "../src/conversation-store.js";
import { nullLogger } from "../src/logger.js";
import { Metrics } from "../src/metrics.js";
import { TicketRunner, type CodexLike, type WorkerThreadEvent } from "../src/runner.js";
import type { Ticket } from "../src/types.js";
import { promptFixture } from "./fixtures/prompt-ticket.js";

async function preparedPrompt(ticket: Ticket, history: unknown, options: {
  store?: ConversationStore;
  rebuildMissingThread?: boolean;
} = {}): Promise<string> {
  let prepared = "";
  const thread = {
    async runStreamed(input, turnOptions) {
      const actual = options.rebuildMissingThread && turnOptions?.missingConversationInput
        ? await turnOptions.missingConversationInput()
        : input;
      if (typeof actual !== "string") throw new Error("Expected a text-only synthetic prompt");
      prepared = actual;
      return { events: (async function* (): AsyncGenerator<WorkerThreadEvent> {
        yield { type: "item.completed", item: {
          id: "handoff", type: "agent_message",
          text: JSON.stringify({ outcome: "AI_DONE", context_summary: "Synthetic checkpoint.", user_message: "Ready for review." })
        } };
        yield { type: "turn.completed", usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } };
      })() };
    }
  } satisfies ReturnType<CodexLike["startThread"]>;
  const runtime: CodexLike = { startThread: () => thread, resumeThread: () => thread };
  const runner = new TicketRunner({
    api: { markTaken: async () => undefined, getHistory: async () => history, reportProgress: async () => undefined, reportResult: async () => undefined },
    codexFactory: () => runtime, logger: nullLogger(), metrics: new Metrics(),
    ...(options.store ? { conversationStore: options.store } : {})
  });
  expect(await runner.run(ticket, { runId: "synthetic-prompt", recovered: false })).toMatchObject({ status: "completed" });
  return prepared;
}

function residualHistory(prompt: string): unknown {
  const section = prompt.split("## Durable ticket history\n")[1]?.split("\n\nReturn the required structured handoff.")[0];
  if (section === undefined) throw new Error("Missing durable context in prepared input");
  const parsed: unknown = JSON.parse(section);
  return parsed;
}

describe("model-facing durable context", () => {
  it("sends authoritative text once while retaining private continuation and all original routing data", async () => {
    const { ticket, history } = promptFixture(12);
    const original = structuredClone(history);
    const prompt = await preparedPrompt(ticket, history);
    expect(prompt).toContain(ticket.instructions);
    expect(prompt.split("TASK_DESCRIPTION:")).toHaveLength(2);
    expect(prompt.split("GLOBAL_CONTEXT:")).toHaveLength(9);
    expect(prompt.split("COMMENT_11:")).toHaveLength(2);
    expect(prompt).toContain("SAVED_HANDOFF: The branch exists. Do not repeat the external write.");
    expect(prompt.length).toBeLessThan(25_000);
    expect(history).toEqual(original);
  });

  it("preserves unique progress, extensions, metadata and empty values", async () => {
    const { ticket, history } = promptFixture(0);
    const prompt = await preparedPrompt(ticket, {
      ...history,
      progress: { context_summary: "LEGACY_CHECKPOINT: The external operation already ran." },
      inherited_context: { sourceCommentId: "branch-a", content: "PRIVATE_CHECKPOINT: Verify the existing PR." },
      extension: { instruction: "CUSTOM_REQUIREMENT: Retain this future field.", empty: "", cleared: null },
      task: { ...history.task, priority: "urgent", deadline: null, source: "https://example.test/specification" }
    });
    expect(residualHistory(prompt)).toMatchObject({
      progress: { context_summary: "LEGACY_CHECKPOINT: The external operation already ran." },
      inherited_context: { sourceCommentId: "branch-a", content: "PRIVATE_CHECKPOINT: Verify the existing PR." },
      extension: { instruction: "CUSTOM_REQUIREMENT: Retain this future field.", empty: "", cleared: null },
      task: { priority: "urgent", deadline: null, source: "https://example.test/specification" }
    });
  });

  it("keeps newer history text even when a human quotes it outside its source section", async () => {
    const { ticket, history } = promptFixture(0);
    const updated = "UPDATED_REQUIREMENT: " + "This newer requirement must remain the task body. ".repeat(8);
    const newComment = { id: "new-comment", authorName: "Reviewer", content: "NEW_REQUEST: Keep all canonical links.", isAI: false };
    const prompt = await preparedPrompt({ ...ticket, instructions: ticket.instructions + `\n\nReview note quotes ${updated}` }, {
      ...history, task: { ...history.task, description: updated }, comments: [newComment],
      context_project: { ...history.context_project, context: "NEW_PROJECT_REQUIREMENT: Check the updated project instructions." }
    });
    expect(residualHistory(prompt)).toMatchObject({
      task: { description: updated }, comments: [newComment],
      context_project: { context: "NEW_PROJECT_REQUIREMENT: Check the updated project instructions." }
    });
  });

  it("preserves unknown JSON keys when copying records for projection", async () => {
    const { ticket, history } = promptFixture(12);
    const extension: unknown = JSON.parse('{"__proto__":{"instruction":"UNIQUE_EXTENSION_REQUIREMENT"}}');
    const combined = Object.fromEntries([
      ...Object.entries(history),
      ["__proto__", extension],
      ["task", Object.fromEntries([...Object.entries(history.task), ["__proto__", extension]])],
      ["context_project", Object.fromEntries([...Object.entries(history.context_project), ["__proto__", extension]])],
      ["comments", history.comments.map(comment => Object.fromEntries([...Object.entries(comment), ["__proto__", extension]]))]
    ]);
    const prompt = await preparedPrompt(ticket, combined);
    expect(prompt.split("TASK_DESCRIPTION:")).toHaveLength(2);
    expect(prompt.split('"__proto__":{"__proto__":{"instruction":"UNIQUE_EXTENSION_REQUIREMENT"}}')).toHaveLength(16);
  });

  it("retains history when source headings are ambiguous", async () => {
    const { ticket, history } = promptFixture(0);
    const prompt = await preparedPrompt({ ...ticket, instructions: `${ticket.instructions}\n\n# Task\n\nA quoted task.` }, history);
    expect(residualHistory(prompt)).toEqual(history);
  });

  it.each([
    { value: { task: { description: "GENERIC_TASK_TEXT" }, summary: "GENERIC_CHECKPOINT", comments: [{ content: "GENERIC_COMMENT" }] } },
    { value: ["LEGACY_ARRAY_ENTRY"] },
    { value: null },
    { value: 42 }
  ])("preserves nonstandard JSON history $value", async ({ value }) => {
    const { ticket } = promptFixture(0);
    expect(residualHistory(await preparedPrompt({ ...ticket, instructions: "A generic task instruction." }, value))).toEqual(value);
  });

  it("keeps opaque legacy text intact", async () => {
    const { ticket } = promptFixture(0);
    expect(await preparedPrompt(ticket, "LEGACY_TEXT\n  preserve indentation\n")).toContain("LEGACY_TEXT\n  preserve indentation\n");
  });

  it("uses compact complete recovery input when a resumed conversation is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tmatrix-prompt-recovery-"));
    try {
      const { ticket, history } = promptFixture(12);
      const store = new ConversationStore({ directory, namespace: "https://example.test" });
      await store.remember(ticket, "saved-thread");
      const trigger = { id: "trigger", content: "Continue with the existing branch." };
      const continuationTicket = { ...ticket, trigger_comment_id: trigger.id };
      const continuationHistory = { ...history, conversation: store.reference("saved-thread"), trigger_comment: trigger };
      expect(await preparedPrompt(continuationTicket, continuationHistory, { store })).toContain("Continue with the existing branch.");
      const rebuilt = await preparedPrompt(continuationTicket, continuationHistory, { store, rebuildMissingThread: true });
      expect(rebuilt).toContain(ticket.instructions);
      expect(rebuilt.split("TASK_DESCRIPTION:")).toHaveLength(2);
      expect(rebuilt).toContain("SAVED_HANDOFF: The branch exists. Do not repeat the external write.");
      expect(rebuilt).toContain("Continue with the existing branch.");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
