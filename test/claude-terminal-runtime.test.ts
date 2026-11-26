import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeTerminalRuntime, startupAnswer } from "../src/adapters/claude/terminal-runtime.js";
import type { RuntimeThreadOptions, WorkerThreadEvent } from "../src/runtime-adapter.js";

function hasTmux(): boolean {
  try { execFileSync("tmux", ["-V"]); return true; } catch { return false; }
}

// A stand-in for interactive Claude Code: it runs the configured hooks, reads one typed
// line per message from the terminal, and writes the handoff file the message names.
const cli = String.raw`#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const resume = args.includes("--resume");
const session = flag(resume ? "--resume" : "--session-id");
const scenario = process.env.FIXTURE_SCENARIO;
const transcript = join(process.cwd(), "transcript-" + session + ".jsonl");
const settings = JSON.parse(flag("--settings"));
appendFileSync("calls", JSON.stringify({ session, resume, model: flag("--model"), mode: flag("--permission-mode"),
  nested: process.env.CLAUDECODE ?? null, queueKey: process.env.API_KEY ?? null }) + "\n");
const hook = (event, payload) => {
  const command = settings.hooks[event][0].hooks[0].command;
  execFileSync("/bin/sh", ["-c", command], { input: JSON.stringify({ session_id: session, transcript_path: transcript, ...payload }) });
};
if (resume && !existsSync(transcript)) {
  console.log("No conversation found with session ID: " + session);
  process.exit(1);
}
if (scenario === "dialog") {
  console.log(" Quick safety check: Is this a project you trust?");
  console.log(" ❯ No, exit");
  console.log("   Yes, I trust this folder");
  console.log(" Enter to confirm · Esc to cancel");
  await new Promise(resolve => process.stdin.once("data", resolve));
}
writeFileSync(transcript, "", { flag: "a" });
hook("SessionStart", {});
const reply = (id, text) => appendFileSync(transcript, JSON.stringify({ type: "assistant", message: { id,
  content: [{ type: "text", text }, { type: "tool_use", name: "Write", input: {} }],
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 } } }) + "\n");
const finish = (handoff, message) => {
  writeFileSync(handoff, JSON.stringify({ outcome: "AI_DONE", context_summary: "durable state", user_message: message }));
  hook("Stop", { last_assistant_message: message });
};
let waiting;
let count = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const file = /read (\S+)/.exec(line)?.[1];
  if (!file) continue;
  hook("UserPromptSubmit", {});
  count += 1;
  const content = readFileSync(file, "utf8");
  const handoff = /to (\S+\.json)/.exec(content)?.[1];
  appendFileSync("prompts", JSON.stringify(content) + "\n");
  reply("message-" + count, "Working on message " + count + ".");
  if (scenario === "steer" && !waiting) { waiting = handoff; continue; }
  if (waiting) {
    hook("Stop", { last_assistant_message: "first" });
    finish(waiting, "Steered: " + content.split("\n")[0]);
    waiting = undefined;
    continue;
  }
  if (scenario === "limited") {
    hook("Notification", { message: "Claude needs your permission to use Bash" });
    await new Promise(resolve => setTimeout(resolve, 600));
    hook("Stop", { last_assistant_message: "Claude usage limit reached. Your limit will reset at 5pm." });
    continue;
  }
  if (scenario === "forgetful" && count === 1) { hook("Stop", { last_assistant_message: "forgot" }); continue; }
  finish(handoff, "Done: " + content.split("\n")[0]);
}
`;
describe("Claude Code startup menus", () => {
  // Screens captured from Claude Code 2.1.332.
  const trust = [
    " Quick safety check: Is this a project you created or one you trust?",
    " Security guide", " ❯ No, exit", "   Yes, I trust this folder", " Enter to confirm · Esc to cancel", "", ""
  ].join("\n");
  const addDirectory = [
    " Adding a new directory:", " /tmp/tmatrix-claude-QYT23r", " ❯ No, exit", "   Yes, add it", " Enter to confirm · Esc to cancel"
  ].join("\n");

  it("moves to the accept option of known menus", () => {
    expect(startupAnswer(trust)).toEqual(["Down", "Enter"]);
    expect(startupAnswer(addDirectory)).toEqual(["Down", "Enter"]);
    expect(startupAnswer([" Resume this session?", " ❯ Resume from summary (recommended)", "   Resume full session as-is",
      " Enter to confirm · Esc to cancel"].join("\n"))).toEqual(["Down", "Enter"]);
  });

  it("never answers text that only appears in resumed history", () => {
    expect(startupAnswer([" ❯ Earlier prompt", "● Yes, I accept the plan.", "", "❯ ", " ⏵⏵ bypass permissions on"].join("\n"))).toBeUndefined();
    expect(startupAnswer([" ❯ No, exit", "   Yes, I trust this folder", " Enter to confirm · Esc to cancel",
      "● Trusted.", "❯ "].join("\n"))).toBeUndefined();
    expect(startupAnswer([" ❯ No, exit", "   Something else", " Enter to confirm · Esc to cancel"].join("\n"))).toBeUndefined();
  });
});

const outputSchema = { type: "object", required: ["outcome", "context_summary", "user_message"] };

describe.skipIf(process.platform === "win32" || !hasTmux())("Claude Code terminal runtime", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  });

  async function fixture(scenario = "normal") {
    const dir = await mkdtemp(join(tmpdir(), "tmx-test-"));
    dirs.push(dir);
    const executable = join(dir, "fake-claude.mjs");
    await writeFile(executable, cli, { mode: 0o700 });
    const runtime = createClaudeTerminalRuntime({
      environment: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? dir, FIXTURE_SCENARIO: scenario,
        CLAUDECODE: "nested", API_KEY: "synthetic-queue-key" },
      logger: { warn() {}, error() {} }
    }, executable);
    const options: RuntimeThreadOptions = {
      model: "sonnet", modelReasoningEffort: "high", serviceTier: "default", workingDirectory: dir,
      sandboxMode: "danger-full-access", approvalPolicy: "never", networkAccessEnabled: true, threadName: "Fixture"
    };
    const lines = async (name: string) => (await readFile(join(dir, name), "utf8")).trim().split("\n").map(line => JSON.parse(line) as unknown);
    return { dir, runtime, options, lines };
  }

  async function collect(events: AsyncGenerator<WorkerThreadEvent>, each?: (event: WorkerThreadEvent) => Promise<void>) {
    const seen: WorkerThreadEvent[] = [];
    for await (const event of events) {
      seen.push(event);
      await each?.(event);
    }
    return seen;
  }

  it("runs a turn in tmux, reports its screen, and resumes the same session on follow-up", { timeout: 30_000 }, async () => {
    const { runtime, options, lines } = await fixture("dialog");
    let socket = "";
    try {
      const thread = runtime.startThread(options);
      const first = await collect((await thread.runStreamed("Fix the footer.", { outputSchema })).events);
      const terminal = first.find(event => event.type === "local.terminal");
      expect(terminal).toMatchObject({ socket: expect.stringMatching(/^tmx-[0-9a-f]{12}$/), session: "claude" });
      socket = (terminal as { socket: string }).socket;
      const started = first.find(event => event.type === "thread.started");
      expect(first.filter(event => event.type !== "local.terminal")).toEqual([
        started,
        { type: "turn.started" },
        { type: "local.activity", kind: "claude.assistant", text: "Working on message 1." },
        { type: "local.activity", kind: "claude.tool", text: "Write" },
        { type: "item.completed", item: { type: "agent_message", id: expect.any(String),
          text: '{"outcome":"AI_DONE","context_summary":"durable state","user_message":"Done: Fix the footer."}' } },
        { type: "turn.completed", usage: { input_tokens: 60, cached_input_tokens: 20, cache_write_input_tokens: 30,
          output_tokens: 5, reasoning_output_tokens: 0 } }
      ]);
      const second = await collect((await thread.runStreamed("Also the header.", { outputSchema })).events);
      expect(second.find(event => event.type === "item.completed")).toMatchObject({ item: {
        text: '{"outcome":"AI_DONE","context_summary":"durable state","user_message":"Done: Also the header."}' } });
      // Follow-up turns reuse the running terminal instead of relaunching Claude.
      expect(await lines("calls")).toEqual([{ session: (started as { thread_id: string }).thread_id, resume: false,
        model: "sonnet", mode: "bypassPermissions", nested: null, queueKey: null }]);
    } finally {
      await runtime.close();
    }
    // Closing the runtime removes its private tmux server.
    expect(() => execFileSync("tmux", ["-L", socket, "ls"], { stdio: "ignore" })).toThrow();
  });

  it("delivers a message typed mid-turn and returns the updated handoff", { timeout: 30_000 }, async () => {
    const { runtime, options } = await fixture("steer");
    try {
      const thread = runtime.startThread(options);
      expect(await thread.steer?.("Too early.")).toBe(false);
      let steered = false;
      const events = await collect((await thread.runStreamed("Fix the footer.", { outputSchema })).events, async event => {
        if (event.type === "local.activity" && !steered) {
          steered = true;
          expect(await thread.steer?.("Check the links too.")).toBe(true);
        }
      });
      expect(events.find(event => event.type === "item.completed")).toMatchObject({ item: {
        text: '{"outcome":"AI_DONE","context_summary":"durable state","user_message":"Steered: Check the links too."}' } });
    } finally {
      await runtime.close();
    }
  });

  it("reminds Claude once when a turn ends without the handoff file", { timeout: 30_000 }, async () => {
    const { runtime, options, lines } = await fixture("forgetful");
    try {
      const events = await collect((await runtime.startThread(options).runStreamed("Fix the footer.", { outputSchema })).events);
      expect(events.find(event => event.type === "item.completed")).toMatchObject({ item: {
        text: expect.stringContaining("Done: The turn is not finished") } });
      expect(await lines("prompts")).toHaveLength(2);
    } finally {
      await runtime.close();
    }
  });

  it("surfaces requests for attention and fails clearly at the plan usage limit", { timeout: 30_000 }, async () => {
    const { runtime, options, lines } = await fixture("limited");
    const seen: WorkerThreadEvent[] = [];
    try {
      const events = (await runtime.startThread(options).runStreamed("Fix the footer.", { outputSchema })).events;
      await expect(collect(events, async event => { seen.push(event); })).rejects.toMatchObject({ code: "CLAUDE_USAGE_LIMIT" });
      expect(seen).toContainEqual({ type: "local.activity", kind: "claude.waiting",
        text: "Claude needs your permission to use Bash Attach with a to answer." });
      // No handoff reminders are sent once the limit is reached.
      expect(await lines("prompts")).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });

  it("rebuilds from durable input only when Claude reports the saved session is missing", { timeout: 30_000 }, async () => {
    const { runtime, options, lines } = await fixture();
    const missing = randomUUID();
    try {
      const thread = runtime.resumeThread?.(missing, options);
      if (!thread) throw new Error("Expected resume support");
      const events = await collect((await thread.runStreamed("Short follow-up.", {
        outputSchema, missingConversationInput: async () => "Full durable prompt."
      })).events);
      const started = events.find(event => event.type === "thread.started");
      expect(started).toMatchObject({ thread_id: expect.not.stringMatching(missing) });
      expect(events.find(event => event.type === "item.completed")).toMatchObject({ item: {
        text: expect.stringContaining("Done: Full durable prompt.") } });
      expect((await lines("calls")).map(call => (call as { resume: boolean }).resume)).toEqual([true, false]);
    } finally {
      await runtime.close();
    }
  });
});
