import { z } from "zod";
import type { WorkerThreadEvent } from "../../runtime-adapter.js";

/*
 * Turns Claude Code's stream into local console activity: replies, each tool call with
 * a readable summary of its input, and a preview of each tool result. Console only;
 * the task API receives just the structured handoff.
 */

const MAX_INPUT_CHARS = 1_200;
const MAX_RESULT_CHARS = 1_500;
const MAX_RESULT_LINES = 30;
/** Carries the private handoff, which the console shows as the final message instead. */
const HANDOFF_TOOL = "StructuredOutput";

const textBlock = z.object({ type: z.literal("text"), text: z.string() });
const toolBlock = z.object({
  type: z.literal("tool_use"),
  id: z.string().optional(),
  name: z.string().regex(/^[a-zA-Z0-9_:.-]{1,120}$/),
  input: z.record(z.string(), z.unknown()).optional().catch(undefined)
});
const resultBlock = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string().optional(),
  is_error: z.boolean().optional().catch(undefined),
  content: z.union([z.string(), z.array(z.unknown())]).optional().catch(undefined)
});
const todoSchema = z.array(z.object({ content: z.string(), status: z.string() }));

/** Tool call IDs to names within one conversation, so results can say what produced them. */
export type ToolNames = Map<string, string>;

export function* assistantActivity(blocks: unknown[], tools: ToolNames = new Map()): Iterable<WorkerThreadEvent> {
  for (const block of blocks) {
    const text = textBlock.safeParse(block);
    if (text.success && text.data.text.trim()) {
      yield { type: "local.activity", kind: "claude.assistant", text: text.data.text };
      continue;
    }
    const tool = toolBlock.safeParse(block);
    if (!tool.success) continue;
    const { id, name, input = {} } = tool.data;
    if (id) tools.set(id, name);
    if (name === HANDOFF_TOOL) continue;
    const todos = name === "TodoWrite" ? todoSchema.safeParse(input.todos).data : undefined;
    if (todos) {
      yield { type: "local.activity", kind: "claude.todo", text: todos.map(todo =>
        `${todo.status === "completed" ? "[x]" : todo.status === "in_progress" ? "[~]" : "[ ]"} ${todo.content}`).join("\n") };
      continue;
    }
    yield { type: "local.activity", kind: "claude.tool", text: clip(describeTool(name, input), MAX_INPUT_CHARS) };
  }
}

export function* toolResultActivity(blocks: unknown[], tools: ToolNames): Iterable<WorkerThreadEvent> {
  for (const block of blocks) {
    const result = resultBlock.safeParse(block);
    if (!result.success) continue;
    const name = result.data.tool_use_id ? tools.get(result.data.tool_use_id) : undefined;
    if (name === HANDOFF_TOOL || name === "TodoWrite") continue;
    const output = resultText(result.data.content).trim();
    const failed = result.data.is_error === true;
    yield {
      type: "local.activity",
      kind: failed ? "claude.output.failed" : "claude.output",
      text: `${name ?? "Tool"} ${failed ? "failed" : "result"}${output ? `\n${preview(output)}` : " (no output)"}`
    };
  }
}

function describeTool(name: string, input: Record<string, unknown>): string {
  const field = (key: string) => typeof input[key] === "string" ? input[key] : undefined;
  switch (name) {
    case "Bash": return `$ ${field("command") ?? ""}${field("description") ? `\n# ${field("description")}` : ""}`;
    case "Read": return `Read ${field("file_path") ?? ""}`;
    case "Write": return `Write ${field("file_path") ?? ""} (${(field("content") ?? "").split("\n").length} lines)`;
    case "Edit": return `Edit ${field("file_path") ?? ""}\n${diff(field("old_string") ?? "", field("new_string") ?? "")}`;
    case "MultiEdit": return `Edit ${field("file_path") ?? ""} (${Array.isArray(input.edits) ? input.edits.length : 0} changes)`;
    case "NotebookEdit": return `Edit notebook ${field("notebook_path") ?? ""}`;
    case "Grep": return `Search ${JSON.stringify(field("pattern") ?? "")}${field("path") ? ` in ${field("path")}` : ""}${field("glob") ? ` (${field("glob")})` : ""}`;
    case "Glob": return `Find ${field("pattern") ?? ""}${field("path") ? ` in ${field("path")}` : ""}`;
    case "WebFetch": return `Fetch ${field("url") ?? ""}`;
    case "WebSearch": return `Search the web: ${field("query") ?? ""}`;
    case "Task":
    case "Agent": return `Agent: ${field("description") ?? field("prompt") ?? ""}`;
    default: {
      const args = JSON.stringify(input);
      return args === "{}" ? name : `${name} ${args}`;
    }
  }
}

function diff(before: string, after: string): string {
  const lines = (text: string, mark: string) => text.split("\n").slice(0, 8).map(line => `${mark} ${line}`);
  return [...lines(before, "-"), ...lines(after, "+")].join("\n");
}

function resultText(content: string | unknown[] | undefined): string {
  if (typeof content === "string") return content;
  return (content ?? []).map(part => {
    const text = textBlock.safeParse(part);
    if (text.success) return text.data.text;
    return typeof part === "object" && part !== null && "type" in part && part.type === "image" ? "[image]" : "";
  }).filter(Boolean).join("\n");
}

function preview(output: string): string {
  const lines = output.split("\n");
  const shown = lines.slice(0, MAX_RESULT_LINES).join("\n");
  const more = lines.length > MAX_RESULT_LINES ? `\n… ${lines.length - MAX_RESULT_LINES} more lines` : "";
  return clip(shown, MAX_RESULT_CHARS) + more;
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
