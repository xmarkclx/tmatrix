import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeRuntime } from "../src/adapters/claude/runtime.js";
import { LEASE_ENV, processStart } from "../src/conversation-recovery.js";
import type { RuntimeThreadOptions, ThreadLike, WorkerThreadEvent } from "../src/runtime-adapter.js";

const cli = String.raw`#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const resume = args.includes("--resume");
const session = flag(resume ? "--resume" : "--session-id");
const output = (event) => console.log(JSON.stringify({ session_id: session, ...event }));
let stdin = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) stdin += chunk;
const input = JSON.parse(stdin);
appendFileSync("calls", JSON.stringify({
  session, resume, name: args.find(arg => arg.startsWith("--name=")),
  model: flag("--model"), effort: flag("--effort"),
  schema: JSON.parse(flag("--json-schema")),
  nested: process.env.CLAUDECODE ?? null, queueKey: process.env.API_KEY ?? null,
  autoUpdater: process.env.DISABLE_AUTOUPDATER, content: input.message.content
}) + "\n");
const scenario = process.env.FIXTURE_SCENARIO;
if (resume && !existsSync(session)) {
  output({ type: "result", subtype: "error_during_execution", is_error: true,
    errors: [scenario === "ambiguous" ? "Synthetic provider error" : "No conversation found with session ID: " + session] });
  process.exitCode = 1;
} else if (scenario === "cancel") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  process.on("SIGTERM", () => { child.kill(); });
  child.once("exit", () => process.exit());
  writeFileSync("pids", JSON.stringify([process.pid, child.pid]));
  output({ type: "system", subtype: "init" });
  setInterval(() => {}, 1000);
} else {
  writeFileSync(session, "");
  if (scenario === "inherited-stdout") {
    const orphan = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true, stdio: ["ignore", process.stdout, "ignore"]
    });
    orphan.unref();
    writeFileSync("pids", JSON.stringify([orphan.pid]));
  }
  output({ type: "system", subtype: "init" });
  output({ type: "assistant", message: { content: [
    { type: "thinking", thinking: "hidden reasoning" },
    { type: "text", text: "Working on it." },
    { type: "tool_use", name: "Read", input: { file_path: "private-path" } },
    { type: "tool_use", name: "StructuredOutput", input: { context_summary: "durable state" } },
  ] } });
  output({ type: "result", subtype: "success", is_error: false, result: "fallback chat",
    ...(scenario === "unstructured" ? {} : { structured_output: {
      outcome: "AI_DONE", context_summary: "durable state", user_message: "All set."
    } }),
    usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 5 }
  });
}
`;
const outputSchema = { type: "object", required: ["outcome", "context_summary", "user_message"] };

describe.skipIf(process.platform === "win32")("Claude Code runtime", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  });

  async function fixture(scenario = "normal", environment: Record<string, string> = {}) {
    const dir = await mkdtemp(join(tmpdir(), "tmatrix-claude-test-"));
    dirs.push(dir);
    const executable = join(dir, "fake-claude.mjs");
    await writeFile(executable, cli, { mode: 0o700 });
    const runtime = createClaudeRuntime({
      environment: {
        PATH: process.env.PATH ?? "",
        FIXTURE_SCENARIO: scenario,
        CLAUDECODE: "nested",
        API_KEY: "synthetic-queue-key",
        ...environment
      },
      logger: { warn() {}, error() {} }
    }, executable);
    const options: RuntimeThreadOptions = {
      model: "gpt-6-sol",
      modelReasoningEffort: "ultra",
      serviceTier: "default",
      workingDirectory: dir,
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      networkAccessEnabled: true,
      threadName: "A Claude conversation"
    };
    const calls = async (): Promise<unknown[]> => (await readFile(join(dir, "calls"), "utf8"))
      .trim().split("\n").map(line => JSON.parse(line));
    return { dir, runtime, options, calls };
  }

  async function collect(events: AsyncGenerator<WorkerThreadEvent>): Promise<WorkerThreadEvent[]> {
    const items: WorkerThreadEvent[] = [];
    for await (const event of events) items.push(event);
    return items;
  }

  async function run(thread: ThreadLike, input = "Finish the ticket.") {
    return collect((await thread.runStreamed(input, { outputSchema })).events);
  }

  it("streams local activity, delivers the structured result, and keeps the same session on follow-up", async () => {
    const { dir, runtime, options, calls } = await fixture();
    const photo = join(dir, "ticket.png");
    await writeFile(photo, "a fixture image");
    try {
      const thread = runtime.startThread(options);
      const first = await collect((await thread.runStreamed([
        { type: "text", text: "Look at this image." }, { type: "local_image", path: photo }
      ], { outputSchema })).events);
      const connected = first[0];
      if (connected?.type !== "thread.started") throw new Error("Expected a session ID");
      expect(first).toEqual([
        { type: "thread.started", thread_id: connected.thread_id },
        { type: "turn.started" },
        { type: "local.activity", kind: "claude.assistant", text: "Working on it." },
        { type: "local.activity", kind: "claude.tool", text: "Read" },
        { type: "item.completed", item: {
          type: "agent_message", id: expect.any(String),
          text: '{"outcome":"AI_DONE","context_summary":"durable state","user_message":"All set."}'
        } },
        { type: "turn.completed", usage: {
          input_tokens: 60, cached_input_tokens: 20, cache_write_input_tokens: 30,
          output_tokens: 5, reasoning_output_tokens: 0
        } }
      ]);
      expect((await run(thread, "Here is a follow-up."))[0]).toEqual(connected);
      expect(await calls()).toEqual([
        {
          session: connected.thread_id, resume: false, name: "--name=A Claude conversation",
          model: "sonnet", effort: "max", schema: outputSchema, nested: null, queueKey: null, autoUpdater: "1",
          content: [
            { type: "text", text: "Look at this image." },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "YSBmaXh0dXJlIGltYWdl" } }
          ]
        },
        {
          session: connected.thread_id, resume: true,
          model: "sonnet", effort: "max", schema: outputSchema, nested: null, queueKey: null, autoUpdater: "1",
          content: "Here is a follow-up."
        }
      ]);
    } finally {
      await runtime.close();
    }
  });

  it("rebuilds a rejected resume with durable input only after Claude confirms the session is missing", async () => {
    const { runtime, options, calls } = await fixture();
    const missing = randomUUID();
    const thread = runtime.resumeThread?.(missing, { ...options, model: "claude-opus-4-8" });
    if (!thread) throw new Error("Expected resume support");
    try {
      const events = await collect((await thread.runStreamed("Existing conversation input", {
        outputSchema, missingConversationInput: async () => "Full durable input"
      })).events);
      const connected = events[0];
      if (connected?.type !== "thread.started") throw new Error("Expected a replacement session ID");
      expect(connected.thread_id).not.toBe(missing);
      expect(await calls()).toEqual([
        expect.objectContaining({ session: missing, resume: true, content: "Existing conversation input", model: "claude-opus-4-8" }),
        expect.objectContaining({ session: connected.thread_id, resume: false, content: "Full durable input", model: "claude-opus-4-8" })
      ]);
    } finally {
      await runtime.close();
    }
  });

  it("does not rebuild after an ambiguous provider error", async () => {
    const { runtime, options, calls } = await fixture("ambiguous");
    const requested = randomUUID();
    const thread = runtime.resumeThread?.(requested, options);
    if (!thread) throw new Error("Expected resume support");
    try {
      await expect(collect((await thread.runStreamed("Existing conversation input", {
        outputSchema, missingConversationInput: async () => "Full durable input"
      })).events)).rejects.toThrow("Claude Code ended the turn with an error");
      expect(await calls()).toEqual([expect.objectContaining({ session: requested, resume: true, content: "Existing conversation input" })]);
    } finally {
      await runtime.close();
    }
  });

  it("fails a successful process exit without a structured handoff", async () => {
    const { runtime, options } = await fixture("unstructured");
    try {
      await expect(run(runtime.startThread(options))).rejects.toThrow("Claude Code finished without a structured handoff");
    } finally {
      await runtime.close();
    }
  });

  it.skipIf(process.platform !== "linux")("finishes a result when a descendant keeps stdout open", async () => {
    const { dir, runtime, options } = await fixture("inherited-stdout", { [LEASE_ENV]: randomUUID() });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4_000);
    try {
      const { events } = await runtime.startThread(options).runStreamed("Finish with a background command.", {
        outputSchema, signal: controller.signal
      });
      expect((await collect(events)).at(-1)).toMatchObject({ type: "turn.completed", usage: { output_tokens: 5 } });
      const [orphan]: number[] = JSON.parse(await readFile(join(dir, "pids"), "utf8"));
      if (!orphan) throw new Error("Expected a descendant PID");
      expect(await processStart(orphan)).toMatch(/^[0-9]+$/);
      await runtime.close();
      expect(await processStart(orphan)).toBeUndefined();
    } finally {
      clearTimeout(timeout);
      await runtime.close();
    }
  });

  it("stops the worker and its subprocess before resolving close", async () => {
    const { dir, runtime, options } = await fixture("cancel");
    const controller = new AbortController();
    const thread = runtime.startThread(options);
    try {
      const { events } = await thread.runStreamed("Run a long task.", { outputSchema, signal: controller.signal });
      expect((await events.next()).value).toEqual({ type: "thread.started", thread_id: expect.any(String) });
      expect((await events.next()).value).toEqual({ type: "turn.started" });
      const pids: number[] = JSON.parse(await readFile(join(dir, "pids"), "utf8"));
      expect(pids).toHaveLength(2);
      for (const pid of pids) expect(process.kill(pid, 0)).toBe(true);
      controller.abort(new Error("Cancelled fixture turn"));
      await expect(events.next()).rejects.toThrow("Cancelled fixture turn");
      await runtime.close();
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
    } finally {
      await runtime.close();
    }
  });
});
