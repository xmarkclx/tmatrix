import { describe, expect, it } from "vitest";
import { assistantActivity, toolResultActivity, type ToolNames } from "../src/adapters/claude/activity.js";
import type { WorkerThreadEvent } from "../src/runtime-adapter.js";

const texts = (events: Iterable<WorkerThreadEvent>) => [...events].map(event => event.type === "local.activity" ? [event.kind, event.text] : []);

describe("Claude console activity", () => {
  it("summarizes tool calls with their inputs", () => {
    const tools: ToolNames = new Map();
    expect(texts(assistantActivity([
      { type: "tool_use", id: "a", name: "Bash", input: { command: "npm test", description: "Run tests" } },
      { type: "tool_use", id: "b", name: "Edit", input: { file_path: "footer.php", old_string: "old", new_string: "new" } },
      { type: "tool_use", id: "c", name: "Grep", input: { pattern: "TODO", path: "src" } },
      { type: "tool_use", id: "d", name: "TodoWrite", input: { todos: [
        { content: "Fix footer", status: "completed" }, { content: "Run tests", status: "in_progress" }, { content: "Ship", status: "pending" }
      ] } },
      { type: "tool_use", id: "e", name: "mcp__tzudo__list", input: { limit: 2 } },
      { type: "tool_use", id: "f", name: "StructuredOutput", input: { user_message: "private handoff" } }
    ], tools))).toEqual([
      ["claude.tool", "$ npm test\n# Run tests"],
      ["claude.tool", "Edit footer.php\n- old\n+ new"],
      ["claude.tool", 'Search "TODO" in src'],
      ["claude.todo", "[x] Fix footer\n[~] Run tests\n[ ] Ship"],
      ["claude.tool", 'mcp__tzudo__list {"limit":2}']
    ]);
    expect(tools.get("a")).toBe("Bash");
  });

  it("previews tool results, marks failures, and skips the handoff tool", () => {
    const tools: ToolNames = new Map([["a", "Bash"], ["b", "Read"], ["h", "StructuredOutput"]]);
    const long = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
    const events = texts(toolResultActivity([
      { type: "tool_result", tool_use_id: "a", is_error: true, content: "exit 1: tests failed" },
      { type: "tool_result", tool_use_id: "b", content: [{ type: "text", text: long }] },
      { type: "tool_result", tool_use_id: "h", content: "Structured output provided" }
    ], tools));
    expect(events[0]).toEqual(["claude.output.failed", "Bash failed\nexit 1: tests failed"]);
    expect(events[1]?.[1]).toMatch(/^Read result\nline 0\n[\s\S]*line 29\n… 10 more lines$/);
    expect(events).toHaveLength(2);
  });
});
