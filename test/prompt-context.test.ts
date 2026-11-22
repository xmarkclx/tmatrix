import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConversationStore } from "../src/conversation-store.js";
import { nullLogger } from "../src/logger.js";
import type { TicketHistoryReader } from "../src/helpers/ticket-history.js";
import { Metrics } from "../src/metrics.js";
import { TicketRunner, type CodexLike, type WorkerThreadEvent } from "../src/runner.js";
import type { Ticket } from "../src/types.js";
import { promptFixture } from "./fixtures/prompt-ticket.js";

async function preparedPrompt(ticket: Ticket, history: unknown, options: {
  store?: ConversationStore;
  rebuildMissingThread?: boolean;
  prepareHistory?: (read: TicketHistoryReader) => Promise<boolean>;
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
  const runtime: CodexLike = {
    startThread: () => thread,
    resumeThread: () => thread,
    ...(options.prepareHistory ? { prepareTicketHistory: options.prepareHistory } : {})
  };
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

describe("ticket history lookup", () => {
  it("keeps the current task and request in a fresh prompt and retrieves only the requested history", async () => {
    const { ticket, history } = promptFixture(25);
    const currentRequest = "Please check the existing branch and use the new colors.";
    const marker = `<!-- tmatrix-conversation:v1:synthetic.${"a".repeat(64)} -->`;
    if (!history.inherited_context) throw new Error("Expected a saved checkpoint");
    history.inherited_context.content += `\n\n${marker}`;
    const original = structuredClone(history);
    const prompt = await preparedPrompt({
      ...ticket,
      instructions: ticket.instructions.replace("This is an explicit initial task handoff.", currentRequest)
    }, history, {
      prepareHistory: async read => {
        expect(read({})).toMatchObject({
          comments: Array.from({ length: 20 }, (_, index) => ({ id: String(25 - index) })),
          next_before_comment_id: "6"
        });
        expect(JSON.stringify(read({}))).not.toContain("COMMENT_24:");
        expect(read({ before_comment_id: "6" })).toMatchObject({
          comments: [{ id: "5" }, { id: "4" }, { id: "3" }, { id: "2" }, { id: "1" }],
          next_before_comment_id: null
        });
        expect(read({ comment_id: "2" })).toMatchObject({
          comment: { id: "2", content: expect.stringContaining("COMMENT_1:") },
          continuation_context: {
            sourceCommentId: "2", content: "SAVED_HANDOFF: The branch exists. Do not repeat the external write."
          }
        });
        expect(read({ comment_id: "3" })).toMatchObject({ comment: { id: "3" }, continuation_context: null });
        expect(read({ comment_id: "999" })).toEqual({ error: "Unknown comment ID for this task." });
        return true;
      }
    });
    expect(prompt).toContain(currentRequest);
    expect(prompt).toContain("TASK_DESCRIPTION:");
    expect(prompt).toContain("The saved continuation is attached to comment #2.");
    expect(prompt).toContain("read_ticket_history");
    expect(prompt).not.toContain("COMMENT_24:");
    expect(prompt).not.toContain("SAVED_HANDOFF:");
    expect(history).toEqual(original);
  });

  it("uses the eager prompt when the runtime cannot provide the lookup", async () => {
    const { ticket, history } = promptFixture(12);
    const prompt = await preparedPrompt(ticket, history, { prepareHistory: async () => false });
    expect(prompt).toContain("COMMENT_11:");
    expect(prompt).toContain("SAVED_HANDOFF:");
    expect(prompt).not.toContain("read_ticket_history");
  });

  it("preserves a copy of history quoted in the task instructions", async () => {
    const { ticket, history } = promptFixture(1);
    const section = ticket.instructions.split("# Complete Comment History\n\n")[1]?.split("\n\n# Required Result")[0];
    if (!section) throw new Error("Expected a comment section");
    const quotation = `The prompt reproducer reads # Complete Comment History\n\n${section}\n\n`;
    const quoted = ticket.instructions.replace("# AI Work Item", `${quotation}# AI Work Item`);
    const prompt = await preparedPrompt({ ...ticket, instructions: quoted }, history, { prepareHistory: async () => true });
    expect(prompt).toContain(quotation);
    expect(prompt).toContain("# Ticket history lookup");
    expect(prompt).not.toMatch(/^# Complete Comment History$/m);
  });

  it("keeps differing or image-bearing history in the initial prompt", async () => {
    const { ticket, history } = promptFixture(12);
    const attachment = "\n\n![Earlier screenshot](/api/uploads/images/markdown-images/1/1af9be84-be0a-47ed-8480-ea7fa7cbbbb8.png)";
    const first = history.comments[0];
    if (!first) throw new Error("Expected a previous comment");
    const withAttachment = { ...history, comments: [{ ...first, content: first.content + attachment }, ...history.comments.slice(1)] };
    const prompt = await preparedPrompt({ ...ticket, instructions: ticket.instructions.replace(first.content, first.content + attachment) }, withAttachment, { prepareHistory: async () => true });
    expect(prompt).toContain(attachment.trim());
    expect(prompt).toContain("SAVED_HANDOFF:");
    expect(prompt).not.toContain("read_ticket_history");

    const changed = await preparedPrompt(ticket, { ...history, comments: [{ ...first, content: "A newer edit." }, ...history.comments.slice(1)] }, { prepareHistory: async () => true });
    expect(changed).toContain("A newer edit.");
    expect(changed).toContain("SAVED_HANDOFF:");
    expect(changed).not.toContain("read_ticket_history");
  });

  it("does not expose a lookup for another task or input revision", async () => {
    const { ticket, history } = promptFixture(12);
    for (const mismatched of [{ ...history, input_revision: 2 }, { ...history, task: { ...history.task, id: "77" } }]) {
      const prompt = await preparedPrompt(ticket, mismatched, { prepareHistory: async () => { throw new Error("Mismatched snapshot offered to runtime"); } });
      expect(prompt).toContain("SAVED_HANDOFF:");
    }
  });

  it("offers the same lookup when resuming and when the conversation must be rebuilt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tmatrix-prompt-lookup-"));
    try {
      const { ticket, history } = promptFixture(12);
      const store = new ConversationStore({ directory, namespace: "https://example.test" });
      await store.remember(ticket, "saved-thread");
      const trigger = { id: "12", content: "Keep the new label." };
      const continuationTicket = {
        ...ticket, trigger_comment_id: trigger.id,
        instructions: ticket.instructions.replace("This is an explicit initial task handoff.", trigger.content)
      };
      const continuationHistory = { ...history, conversation: store.reference("saved-thread"), trigger_comment: trigger };
      const prepareHistory = async (read: TicketHistoryReader) => {
        expect(read({ comment_id: "2" })).toMatchObject({ continuation_context: { sourceCommentId: "2" } });
        return true;
      };
      const resumed = await preparedPrompt(continuationTicket, continuationHistory, { store, prepareHistory });
      expect(resumed).toContain(trigger.content);
      expect(resumed).not.toContain("# Ticket history lookup");
      expect(resumed).not.toContain("SAVED_HANDOFF:");
      const rebuilt = await preparedPrompt(continuationTicket, continuationHistory, { store, prepareHistory, rebuildMissingThread: true });
      expect(rebuilt).toContain(trigger.content);
      expect(rebuilt).toContain("The saved continuation is attached to comment #2.");
      expect(rebuilt).not.toContain("COMMENT_11:");
      expect(rebuilt).not.toContain("SAVED_HANDOFF:");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
