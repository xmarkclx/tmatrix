import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import adapter from "../src/adapters/gemini/index.js";
import type { RuntimeThreadOptions, ThreadLike, WorkerThreadEvent } from "../src/runtime-adapter.js";

const originalId = "12345678-1234-4234-8234-123456789abc";
const newId = "12345678-1234-4234-8234-123456789def";
const model = "gemini-4-neon-high";
const handoff = { outcome: "AI_DONE", context_summary: "Durable state", user_message: "Finished." };
const outputSchema = { type: "object", properties: { outcome: { type: "string" } } };
const cli = String.raw`#!/usr/bin/env node
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
const flag = key => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
const requested = flag("--conversation");
const scenario = process.env.FIXTURE_SCENARIO;
const id = requested && scenario === "lost" ? process.env.NEW_ID : requested ?? process.env.ORIGINAL_ID;
const record = data => appendFileSync("calls", JSON.stringify(data) + "\n");
const emit = data => console.log(JSON.stringify(data));
record({ args, pid: process.pid, cwd: process.cwd(), queueKeyPresent: Boolean(process.env.API_KEY) });
if (scenario === "auth" || scenario === "invalid-model") {
  const reason = scenario === "auth" ? "authentication required" : "invalid model selection";
  emit({ event: "result", result: {
    conversation_id: "", status: "ERROR", response: "", error: reason + ": synthetic private diagnostic"
  } });
  process.exitCode = 1;
} else if (scenario === "unusable-executable" || scenario === "missing-wrapped-executable") {
  process.exitCode = scenario === "unusable-executable" ? 126 : 127;
} else if (scenario === "stalled-startup") {
  setInterval(() => {}, 1000);
} else {
emit({ event: "init", conversation_id: id, init: { model: flag("--model") } });
for await (const line of createInterface({ input: process.stdin })) {
  const addedDir = flag("--add-dir");
  const staged = addedDir && readdirSync(addedDir);
  record({
    input: JSON.parse(line),
    ...(staged ? { staged, image: readFileSync(join(addedDir, staged[0]), "utf8") } : {})
  });
  if (scenario === "cancel") setInterval(() => {}, 1000);
  if (scenario === "truncated" || scenario === "cancel") continue;
  emit({ event: "step_update", step_update: { text_delta: "private activity", thinking_delta: "private reasoning" } });
  emit({ event: "result", result: {
    conversation_id: scenario === "wrong-result" ? process.env.NEW_ID : id,
    status: scenario === "vendor-error" ? "ERROR" : scenario === "waiting" ? "WAITING" : "SUCCESS",
    response: "private raw response",
    ...(scenario === "unstructured" || scenario === "denied" ? {} : { structured_output: JSON.parse(process.env.HANDOFF) }),
    ...(scenario === "denied" ? { denied_actions: [{ action: "command", display_name: "Bash" }, { action: "command", display_name: "Bash" }] } : {}),
    ...(scenario === "vendor-error" ? { error: "synthetic private diagnostic" } : {}),
    usage: { input_tokens: 15, cache_read_tokens: 7, output_tokens: 20, thinking_tokens: 4 }
  } });
}
if (scenario === "nonzero") process.exitCode = 1;
}
`;

describe.skipIf(process.platform === "win32")("Gemini Antigravity runtime", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function fixture(scenario = "normal", userInstall = false) {
    const dir = await mkdtemp(join(tmpdir(), "tmatrix-gemini-test-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const executable = join(dir, "fake-agy.mjs");
    await writeFile(executable, cli, { mode: 0o700 });
    const bin = join(dir, "bin");
    await mkdir(bin);
    await symlink(process.execPath, join(bin, "node"));
    const home = join(dir, "home");
    if (userInstall) {
      const userBin = join(home, ".local", "bin");
      await mkdir(userBin, { recursive: true });
      await symlink(executable, join(userBin, "agy"));
    }
    const runtime = adapter.create({
      environment: {
        HOME: home,
        PATH: bin,
        ...(userInstall ? {} : { TMATRIX_AGY_PATH: executable }),
        API_KEY: "synthetic queue credential",
        FIXTURE_SCENARIO: scenario,
        ORIGINAL_ID: scenario === "lost" ? newId : originalId,
        NEW_ID: newId,
        HANDOFF: JSON.stringify(handoff)
      },
      logger: { warn() {}, error() {} }
    });
    cleanups.push(() => runtime.close());
    const options: RuntimeThreadOptions = {
      model,
      modelReasoningEffort: "high",
      serviceTier: "default",
      workingDirectory: dir,
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      networkAccessEnabled: true,
      threadName: "Gemini fixture conversation"
    };
    const calls = async () => (await readFile(join(dir, "calls"), "utf8"))
      .trimEnd().split("\n").map(line => JSON.parse(line));
    return { runtime, options, calls };
  }

  async function collect(
    thread: ThreadLike,
    input = "Original prompt",
    turn: Parameters<ThreadLike["runStreamed"]>[1] = { outputSchema }
  ): Promise<WorkerThreadEvent[]> {
    const result: WorkerThreadEvent[] = [];
    for await (const event of (await thread.runStreamed(input, turn)).events) result.push(event);
    return result;
  }

  it("runs the pinned model in the selected cwd and emits only the completed structured handoff", async () => {
    const { runtime, options, calls } = await fixture();
    const thread = runtime.startThread(options);
    const events = await collect(thread);
    expect(events).toEqual([
      { type: "thread.started", thread_id: originalId },
      { type: "turn.started" },
      { type: "item.completed", item: { id: expect.any(String), type: "agent_message", text: JSON.stringify(handoff) } },
      { type: "turn.completed", usage: {
        input_tokens: 15, cached_input_tokens: 7, cache_write_input_tokens: 0,
        output_tokens: 20, reasoning_output_tokens: 4
      } }
    ]);
    const [launch, prompt] = await calls();
    expect(launch).toMatchObject({ cwd: options.workingDirectory, queueKeyPresent: false, args: [
      "--input-format", "stream-json", "--output-format", "stream-json", "--disable-slash-commands",
      "--dangerously-skip-permissions", "--model", model, "--json-schema", JSON.stringify(outputSchema)
    ] });
    expect(prompt).toEqual({ input: { event: "user", message: { content: "Original prompt" } } });
    expect((await collect(thread, "Next revision"))[0]).toEqual({ type: "thread.started", thread_id: originalId });
    expect((await calls())[2].args).toContain(originalId);
  });

  it("lets agy select the configured orchestrator model without overriding its effort", async () => {
    const { runtime, options, calls } = await fixture();
    const orchestrator = "gemini-pro-orchestrator-neon";
    const thread = runtime.startThread({ ...options, model: orchestrator, modelReasoningEffort: "max" });
    expect((await collect(thread)).at(-1)?.type).toBe("turn.completed");
    const [launch] = await calls();
    expect(launch.args).toEqual(expect.arrayContaining(["--model", orchestrator]));
    expect(launch.args).not.toContain("--effort");
  });

  it("runs an agy symlink in the worker's user bin when its service PATH omits that directory", async () => {
    const { runtime, options, calls } = await fixture("normal", true);
    expect((await collect(runtime.startThread(options))).at(-1)?.type).toBe("turn.completed");
    expect((await calls())[0]).toMatchObject({ cwd: options.workingDirectory });
  });

  it("reports an actionable error if agy is missing or the override is relative", () => {
    const logger = { warn() {}, error() {} };
    for (const environment of [
      { PATH: ".", HOME: "relative-home" },
      { PATH: dirname(process.execPath), TMATRIX_AGY_PATH: "./fake-agy.mjs" }
    ]) {
      expect(() => adapter.create({ environment, logger })).toThrow(/set TMATRIX_AGY_PATH to the absolute path/);
    }
  });

  it("uses the durable input only after explicit resume initializes a different ID", async () => {
    const { runtime, options, calls } = await fixture("lost");
    const rebuild = vi.fn(async () => "Durable history and new prompt");
    const thread = runtime.resumeThread!(originalId, options);
    expect((await collect(thread, "Revision without durable history", { outputSchema, missingConversationInput: rebuild }))[0])
      .toEqual({ type: "thread.started", thread_id: newId });
    const [resume, fresh, prompt] = await calls();
    expect(rebuild).toHaveBeenCalledOnce();
    expect(resume.args).toEqual(expect.arrayContaining(["--conversation", originalId]));
    expect(fresh.args).not.toContain("--conversation");
    expect(prompt.input.message.content).toBe("Durable history and new prompt");
  });

  it("does not send existing revision input to an unrecognized fresh conversation", async () => {
    const { runtime, options, calls } = await fixture("lost");
    await expect(collect(runtime.resumeThread!(originalId, options))).rejects.toThrow("could not be found");
    expect(await calls()).toHaveLength(1);
  });

  it.each(["truncated", "unstructured", "nonzero", "wrong-result", "vendor-error", "auth"])(
    "rejects %s output without emitting a handoff or leaking diagnostics",
    async (scenario) => {
      const { runtime, options } = await fixture(scenario);
      const events: WorkerThreadEvent[] = [];
      const run = async () => {
        for await (const event of (await runtime.startThread(options).runStreamed("Prompt", { outputSchema })).events) {
          events.push(event);
        }
      };
      await expect(run()).rejects.toThrow(scenario === "auth" ? "authentication failed" : /^Antigravity CLI /);
      expect(events.every(event => event.type === "thread.started" || event.type === "turn.started")).toBe(true);
    }
  );

  it.each([
    ["invalid-model", /Run agy models/],
    ["unusable-executable", /TMATRIX_AGY_PATH/],
    ["missing-wrapped-executable", /TMATRIX_AGY_PATH/],
    ["waiting", /waiting for input/],
    ["denied", /^Antigravity CLI denied Bash because the tool needed approval/]
  ] as const)("provides actionable diagnostics for %s", async (scenario, hint) => {
    const { runtime, options } = await fixture(scenario);
    const run = collect(runtime.startThread(options));
    await expect(run).rejects.toThrow(hint);
    await expect(run).rejects.not.toThrow("synthetic private diagnostic");
  });

  it("times out stalled initialization, withholds the prompt and confirms the process stopped", async () => {
    const { runtime, options, calls } = await fixture("stalled-startup");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const run = collect(runtime.startThread(options));
      const failed = expect(run).rejects.toThrow("Update agy and verify sign-in");
      await vi.waitFor(async () => expect(await calls()).toHaveLength(1));
      const [launch] = await calls();
      await vi.advanceTimersByTimeAsync(60_000);
      await failed;
      await runtime.close();
      expect(() => process.kill(launch.pid, 0)).toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gates submission after init and does not send a prompt if policy changed", async () => {
    const { runtime, options, calls } = await fixture();
    const denied = new Error("The current route no longer allows submission");
    const beforeStart = vi.fn(async () => { throw denied; });
    const { events } = await runtime.startThread(options).runStreamed("Sensitive test prompt", { outputSchema, beforeStart });
    await expect(events.next()).resolves.toEqual({
      value: { type: "thread.started", thread_id: originalId },
      done: false
    });
    expect(beforeStart).not.toHaveBeenCalled();
    await expect(events.next()).rejects.toBe(denied);
    expect(beforeStart).toHaveBeenCalledOnce();
    expect(await calls()).toHaveLength(1);
  });

  it("stages only the intended attachments in a private additional workspace and preserves the prompt", async () => {
    const { runtime, options, calls } = await fixture();
    const source = join(options.workingDirectory, "example.png");
    await writeFile(source, "Fixture image bytes");
    await writeFile(join(options.workingDirectory, "unrelated.txt"), "Not an attachment");
    const thread = runtime.startThread(options);
    const { events } = await thread.runStreamed([
      { type: "text", text: "Original prompt" },
      { type: "local_image", path: source }
    ], { outputSchema });
    for await (const _event of events) { /* drain */ }
    const [launch, prompt] = await calls();
    const stagedPath = launch.args[launch.args.indexOf("--add-dir") + 1];
    expect(stagedPath).not.toBe(options.workingDirectory);
    expect(prompt.staged).toEqual(["image-1.png"]);
    expect(prompt.image).toBe("Fixture image bytes");
    expect(prompt.input.message.content).toBe(
      `Original prompt\n\nLocal image attachments (inspect these files):\n@${join(stagedPath, "image-1.png")}`
    );
    await expect(readdir(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stops an aborted process and preserves the caller's cancellation reason", async () => {
    const { runtime, options, calls } = await fixture("cancel");
    const controller = new AbortController();
    const reason = new Error("Requested stop");
    const thread = runtime.startThread(options);
    const running = collect(thread, "Wait for cancellation", { outputSchema, signal: controller.signal });
    await vi.waitFor(async () => expect(await calls()).toHaveLength(2));
    const stopped = expect(running).rejects.toBe(reason);
    controller.abort(reason);
    await stopped;
    await runtime.close();
    const [launch] = await calls();
    expect(() => process.kill(launch.pid, 0)).toThrow();
  });
});
