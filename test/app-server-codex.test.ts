import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import {
  AppServerCodex,
  type AppServerProcess
} from "../src/adapters/codex/app-server.js";
import type {
  CodexThreadOptions,
  WorkerThreadEvent
} from "../src/runner.js";
import { deferred } from "./helpers.js";

type RequestMessage = {
  method: string;
  id: number;
  params: Record<string, unknown>;
};

class FakeAppServer extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: RequestMessage[] = [];
  readonly clientNotifications: Array<{ method: string; params?: unknown }> = [];
  killed = false;
  private input = "";

  constructor(
    private readonly handle: (request: RequestMessage, server: FakeAppServer) => void
  ) {
    super();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => {
      this.input += chunk;
      while (true) {
        const boundary = this.input.indexOf("\n");
        if (boundary < 0) break;
        const line = this.input.slice(0, boundary);
        this.input = this.input.slice(boundary + 1);
        if (!line) continue;
        const input = JSON.parse(line) as Partial<RequestMessage>;
        if (typeof input.id !== "number") {
          if (typeof input.method === "string") {
            this.clientNotifications.push({
              method: input.method,
              ...(input.params !== undefined ? { params: input.params } : {})
            });
          }
          continue;
        }
        const request = input as RequestMessage;
        this.requests.push(request);
        if (request.method === "thread/backgroundTerminals/clean") {
          this.respond(request.id, { cleaned: true });
          continue;
        }
        this.handle(request, this);
      }
    });
    this.stdin.once("finish", () => {
      queueMicrotask(() => this.emit("exit", 0, null));
    });
  }

  respond(id: number, result: unknown = {}): void {
    this.stdout.write(`${JSON.stringify({ id, result })}\n`);
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify({ method, params })}\n`);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }

  asProcess(): AppServerProcess {
    return this as unknown as AppServerProcess;
  }
}

const threadOptions: CodexThreadOptions = {
  model: "gpt-5.6-sol",
  modelReasoningEffort: "medium",
  serviceTier: "default",
  workingDirectory: "/work/project",
  sandboxMode: "danger-full-access",
  approvalPolicy: "never",
  networkAccessEnabled: true,
  threadName: "TASK-5259: PRD: AI Integration"
};

function standardServer(): FakeAppServer {
  return new FakeAppServer((request, server) => {
    if (request.method === "initialize") {
      server.respond(request.id, { userAgent: "test" });
      return;
    }
    if (request.method === "thread/start") {
      server.respond(request.id, { thread: { id: "thread-app-visible" } });
      return;
    }
    if (request.method === "thread/name/set") {
      server.respond(request.id);
      return;
    }
    if (request.method === "thread/unsubscribe") {
      server.respond(request.id);
      return;
    }
    if (request.method === "turn/start") {
      const turnId = `turn-${server.requests.filter((entry) =>
        entry.method === "turn/start").length}`;
      server.respond(request.id, { turn: { id: turnId } });
      queueMicrotask(() => {
        server.notify("item/completed", {
          threadId: "thread-app-visible",
          turnId,
          item: {
            type: "commandExecution",
            id: `command-${turnId}`,
            command: "npm test",
            aggregatedOutput: "all passed",
            exitCode: 0,
            status: "completed"
          }
        });
        server.notify("item/completed", {
          threadId: "thread-app-visible",
          turnId,
          item: {
            type: "fileChange",
            id: `file-${turnId}`,
            changes: [{
              path: "src/example.ts",
              kind: { type: "update", move_path: null },
              diff: "sensitive patch"
            }],
            status: "completed"
          }
        });
        server.notify("item/completed", {
          threadId: "thread-app-visible",
          turnId,
          item: {
            type: "agentMessage",
            id: `message-${turnId}`,
            text: JSON.stringify({
              outcome: "AI_DONE",
              context_summary: "Implemented and tested.",
              user_message: "Ready for testing."
            })
          }
        });
        server.notify("thread/tokenUsage/updated", {
          threadId: "thread-app-visible",
          turnId,
          tokenUsage: {
            last: {
              inputTokens: 21,
              cachedInputTokens: 8,
              cacheWriteInputTokens: 2,
              outputTokens: 13,
              reasoningOutputTokens: 5
            }
          }
        });
        server.notify("turn/completed", {
          threadId: "thread-app-visible",
          turn: { id: turnId, status: "completed", error: null }
        });
      });
      return;
    }
    throw new Error(`Unexpected fake request: ${request.method}`);
  });
}

async function collect(
  events: AsyncGenerator<WorkerThreadEvent>
): Promise<WorkerThreadEvent[]> {
  const result: WorkerThreadEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe("AppServerCodex", () => {
  it("targets live steering to the active turn and stops accepting after its completion notification", async () => {
    const ready = deferred();
    const server = new FakeAppServer((request, server) => {
      if (request.method === "thread/start") server.respond(request.id, { thread: { id: "thread-live" } });
      else if (request.method === "turn/start") { server.respond(request.id, { turn: { id: "turn-live" } }); ready.resolve(undefined); }
      else if (request.method === "turn/steer") server.respond(request.id, { turnId: "turn-live" });
      else server.respond(request.id);
    });
    const codex = new AppServerCodex({ environment: {}, spawnProcess: () => server.asProcess(), closeTimeoutMs: 20 });
    const thread = codex.startThread(threadOptions);
    expect(await thread.steer!("Before start")).toBe(false);
    const streamed = await thread.runStreamed("Initial task");
    expect((await streamed.events.next()).value).toMatchObject({ type: "thread.started" });
    expect((await streamed.events.next()).value).toEqual({ type: "turn.started" });
    await ready.promise;
    expect(await thread.steer!("Check focus")).toBe(true);
    expect(server.requests.find(request => request.method === "turn/steer")?.params).toEqual({
      threadId: "thread-live", expectedTurnId: "turn-live", input: [{ type: "text", text: "Check focus", text_elements: [] }]
    });
    server.notify("turn/completed", { threadId: "another-thread", turn: { id: "turn-live", status: "completed" } });
    expect(await thread.steer!("Still active")).toBe(true);
    server.notify("turn/completed", { threadId: "thread-live", turn: { id: "turn-live", status: "completed" } });
    // No generator advance is necessary to clear the runtime's active target.
    expect(await thread.steer!("Too late")).toBe(false);
    expect(await collect(streamed.events)).toContainEqual(expect.objectContaining({ type: "turn.completed" }));
    expect(server.requests.filter(request => request.method === "turn/steer")).toHaveLength(2);
    await codex.close();
  });

  it.each([
    { code: -32601, message: "Method not found", retry: true },
    { code: -32600, message: "no active turn to steer", retry: true },
    { code: -32600, message: "turn id mismatch", retry: true },
    { code: -32000, message: "private protocol detail", retry: false }
  ])("only retries explicit live-steering rejection $code/$message", async ({ code, message, retry }) => {
    const server = new FakeAppServer((request, server) => {
      if (request.method === "thread/start") server.respond(request.id, { thread: { id: "thread-live" } });
      else if (request.method === "turn/start") server.respond(request.id, { turn: { id: "turn-live" } });
      else if (request.method === "turn/steer") server.stdout.write(`${JSON.stringify({ id: request.id, error: { code, message } })}\n`);
      else server.respond(request.id);
    });
    const codex = new AppServerCodex({ environment: {}, spawnProcess: () => server.asProcess(), closeTimeoutMs: 20 });
    const thread = codex.startThread(threadOptions);
    const events = (await thread.runStreamed("Task")).events;
    await events.next();
    await events.next();
    if (retry) expect(await thread.steer!("Check focus")).toBe(false);
    else await expect(thread.steer!("Check focus")).rejects.toThrow("turn/steer failed");
    await events.return(undefined);
    await codex.close();
  });
  function resumeServer(options: { error?: { code: number; message: string }; resumedId?: string } = {}): FakeAppServer {
    let activeThread = "thread-existing";
    return new FakeAppServer((request, server) => {
      if (request.method === "thread/resume") {
        if (options.error) {
          server.stdout.write(`${JSON.stringify({ id: request.id, error: options.error })}\n`);
        } else {
          activeThread = options.resumedId ?? activeThread;
          server.respond(request.id, { thread: { id: activeThread } });
        }
      } else if (request.method === "thread/start") {
        activeThread = "thread-replacement";
        server.respond(request.id, { thread: { id: activeThread } });
      } else if (request.method === "turn/start") {
        const turnId = `turn-${server.requests.length}`;
        server.respond(request.id, { turn: { id: turnId } });
        queueMicrotask(() => server.notify("turn/completed", {
          threadId: activeThread, turn: { id: turnId, status: "completed" }
        }));
      } else {
        server.respond(request.id);
      }
    });
  }

  it("resumes a persisted conversation and appends all turns to its original ID", async () => {
    const server = resumeServer();
    const codex = new AppServerCodex({ environment: {}, spawnProcess: () => server.asProcess(), closeTimeoutMs: 20 });
    const thread = codex.resumeThread("thread-existing", threadOptions);
    const fallback = vi.fn(async () => "Full task context");
    const first = await collect((await thread.runStreamed("A new ticket replies to the prior result", { missingConversationInput: fallback })).events);
    expect(fallback).not.toHaveBeenCalled();
    await collect((await thread.runStreamed("A second follow-up")).events);
    await codex.close();
    expect(server.requests.filter((entry) => entry.method === "thread/resume")).toHaveLength(1);
    expect(server.requests.some((entry) => entry.method === "thread/start")).toBe(false);
    expect(server.requests.filter((entry) => entry.method === "turn/start").map((entry) => entry.params.threadId)).toEqual(["thread-existing", "thread-existing"]);
    expect(server.requests.find((entry) => entry.method === "thread/resume")?.params).toMatchObject({
      threadId: "thread-existing", cwd: threadOptions.workingDirectory, model: threadOptions.model,
      approvalPolicy: "never", sandbox: "danger-full-access", excludeTurns: true
    });
    expect(first).toContainEqual({ type: "thread.started", thread_id: "thread-existing" });
    expect(first).toContainEqual(expect.objectContaining({ type: "local.activity", kind: "conversation.resumed" }));
  });

  it("rebuilds only a confirmed missing conversation before delivering any task input", async () => {
    const server = resumeServer({ error: { code: -32600, message: "no rollout found for thread id thread-existing" } });
    const codex = new AppServerCodex({ environment: {}, spawnProcess: () => server.asProcess(), closeTimeoutMs: 20 });
    const events = await collect((await codex.resumeThread("thread-existing", threadOptions).runStreamed("Only the new comment", { missingConversationInput: async () => "Task context, comments and saved handoff" })).events);
    await codex.close();
    const methods = server.requests.map((entry) => entry.method);
    expect(methods.indexOf("thread/resume")).toBeLessThan(methods.indexOf("thread/start"));
    expect(methods.indexOf("thread/start")).toBeLessThan(methods.indexOf("turn/start"));
    expect(server.requests.filter((entry) => entry.method === "turn/start")).toHaveLength(1);
    expect(server.requests.find((entry) => entry.method === "turn/start")?.params).toMatchObject({ threadId: "thread-replacement" });
    expect(server.requests.find((entry) => entry.method === "turn/start")?.params.input).toEqual([{ type: "text", text: "Task context, comments and saved handoff", text_elements: [] }]);
    expect(events).toContainEqual(expect.objectContaining({ type: "local.activity", kind: "conversation.rebuilt" }));
    expect(events).toContainEqual({ type: "thread.started", thread_id: "thread-replacement" });
  });

  it.each([
    { code: -32600, message: "Unauthorized: access token expired" },
    { code: -32600, message: "Required MCP server unavailable" },
    { code: -32600, message: "no rollout found for thread id a-different-thread" },
    { code: -32000, message: "no rollout found for thread id thread-existing" },
    { code: -32600, message: "Failed to read conversation: permission denied" }
  ])("preserves the conversation on unconfirmed resume failure: $message", async (error) => {
    const server = resumeServer({ error });
    const codex = new AppServerCodex({ environment: {}, spawnProcess: () => server.asProcess(), closeTimeoutMs: 20 });
    await expect(collect((await codex.resumeThread("thread-existing", threadOptions).runStreamed("Follow-up")).events)).rejects.toThrow("thread/resume failed");
    await codex.close();
    expect(server.requests.some((entry) => ["thread/start", "turn/start"].includes(entry.method))).toBe(false);
  });

  it("rebuilds a rejected resume after safe crash recovery before sending input", async () => {
    const server = resumeServer({ error: { code: -32600, message: "Saved conversation cannot be resumed" } });
    const codex = new AppServerCodex({ environment: {}, spawnProcess: () => server.asProcess(), closeTimeoutMs: 20 });
    const events = await collect((await codex.resumeThread("thread-existing", {
      ...threadOptions, rebuildOnResumeRejection: true
    }).runStreamed("Only the retry", { missingConversationInput: async () => "Full durable recovery handoff" })).events);
    await codex.close();
    expect(server.requests.filter((entry) => entry.method === "thread/start")).toHaveLength(1);
    expect(server.requests.filter((entry) => entry.method === "turn/start")).toHaveLength(1);
    expect(server.requests.find((entry) => entry.method === "turn/start")?.params).toMatchObject({
      threadId: "thread-replacement", input: [{ type: "text", text: "Full durable recovery handoff", text_elements: [] }]
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "local.activity", kind: "conversation.rebuilt" }));
  });

  it("does not rebuild after an ambiguous resume timeout, even during recovery", async () => {
    const server = new FakeAppServer((request, server) => {
      if (request.method !== "thread/resume") server.respond(request.id);
    });
    const codex = new AppServerCodex({ environment: {}, spawnProcess: () => server.asProcess(), requestTimeoutMs: 20, closeTimeoutMs: 20 });
    await expect(collect((await codex.resumeThread("thread-existing", {
      ...threadOptions, rebuildOnResumeRejection: true
    }).runStreamed("retry")).events)).rejects.toThrow();
    await codex.close();
    expect(server.requests.some((entry) => ["thread/start", "turn/start"].includes(entry.method))).toBe(false);
  });

  it("rejects a resume response for another conversation without appending work", async () => {
    const server = resumeServer({ resumedId: "wrong-thread" });
    const codex = new AppServerCodex({ environment: {}, spawnProcess: () => server.asProcess(), closeTimeoutMs: 20 });
    await expect(collect((await codex.resumeThread("thread-existing", threadOptions).runStreamed("Follow-up")).events)).rejects.toThrow("unexpected conversation");
    await codex.close();
    expect(server.requests.some((entry) => ["thread/start", "turn/start"].includes(entry.method))).toBe(false);
  });

  it("repairs App Server JSON split by literal newlines inside a string", async () => {
    const logger = {
      error: vi.fn(),
      warn: vi.fn()
    } as unknown as Pick<Logger, "error" | "warn">;
    const multilineUserAgent = [
      "Shipping to Australian",
      "Capital Territory",
      "Shipping to Australian",
      "Capital Territory"
    ].join("\n");
    let malformedRecord = "";
    const server = new FakeAppServer((request, fake) => {
      if (request.method === "initialize") {
        malformedRecord = `{"id":${request.id},"result":{"userAgent":"${multilineUserAgent}"}}`;
        fake.stdout.write(`${malformedRecord}\n`);
      } else if (request.method === "thread/start") {
        fake.respond(request.id, { thread: { id: "thread-repaired" } });
      } else if (
        request.method === "thread/name/set" ||
        request.method === "thread/unsubscribe"
      ) {
        fake.respond(request.id);
      } else if (request.method === "turn/start") {
        fake.respond(request.id, { turn: { id: "turn-repaired" } });
        queueMicrotask(() => fake.notify("turn/completed", {
          threadId: "thread-repaired",
          turn: { id: "turn-repaired", status: "completed", error: null }
        }));
      }
    });
    const codex = new AppServerCodex({
      environment: {},
      spawnProcess: () => server.asProcess(),
      closeTimeoutMs: 20,
      logger
    });
    const thread = codex.startThread(threadOptions);
    const streamed = await thread.runStreamed("Use the repaired transport");

    const events = await collect(streamed.events);
    await codex.close();

    const fragments = malformedRecord.split("\n");
    expect(events.at(-1)?.type).toBe("turn.completed");
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith({
      event: "codex.protocol_json_repaired",
      protocol_fragments: fragments,
      protocol_fragment_lengths: fragments.map((fragment) => fragment.length),
      protocol_record_length: fragments.join("\\n").length,
      protocol_id: 1
    }, "Repaired Codex App Server JSON split by literal string newlines");
  });

  it.each([
    [["Checking the failing path.", "Then validating the fix."], "Checking the failing path.\nThen validating the fix."],
    [[], ""],
    [undefined, ""]
  ])("exposes only reasoning summaries, never raw content (%j)", async (summary, expected) => {
    const server = standardServer();
    const originalNotify = server.notify.bind(server);
    server.notify = (method, params) => {
      if (method === "turn/completed") {
        originalNotify("item/completed", {
          threadId: params.threadId,
          turnId: (params.turn as { id: string }).id,
          item: { id: "reasoning", type: "reasoning", summary, content: ["RAW_CONTENT_SENTINEL"] }
        });
      }
      originalNotify(method, params);
    };
    const codex = new AppServerCodex({ environment: {}, spawnProcess: () => server.asProcess() });
    const streamed = await codex.startThread(threadOptions).runStreamed("Check the failure");
    const events = await collect(streamed.events);
    await codex.close();
    expect(events).toContainEqual({
      type: "item.completed", item: { id: "reasoning", type: "reasoning", text: expected }
    });
    expect(JSON.stringify(events)).not.toContain("RAW_CONTENT_SENTINEL");
  });

  it("creates, names, and runs a persistent explicitly configured App Server thread", async () => {
    const server = standardServer();
    let launchArguments: readonly string[] | undefined;
    const codex = new AppServerCodex({
      environment: { PATH: "/usr/bin", CODEX_HOME: "/codex-home" },
      spawnProcess: (_environment, arguments_) => {
        launchArguments = arguments_;
        return server.asProcess();
      },
      closeTimeoutMs: 20
    });
    const thread = codex.startThread(threadOptions);
    const streamed = await thread.runStreamed("Do the ticket", {
      outputSchema: { type: "object" }
    });

    const events = await collect(streamed.events);
    await codex.close();

    expect(events).toEqual([
      { type: "thread.started", thread_id: "thread-app-visible" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: {
          id: "command-turn-1",
          type: "command_execution",
          command: "npm test",
          aggregated_output: "all passed",
          exit_code: 0,
          status: "completed"
        }
      },
      {
        type: "item.completed",
        item: {
          id: "file-turn-1",
          type: "file_change",
          changes: [{
            path: "src/example.ts",
            kind: "update",
            diff: "sensitive patch"
          }],
          status: "completed"
        }
      },
      {
        type: "item.completed",
        item: {
          id: "message-turn-1",
          type: "agent_message",
          text: JSON.stringify({
            outcome: "AI_DONE",
            context_summary: "Implemented and tested.",
            user_message: "Ready for testing."
          })
        }
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 21,
          cached_input_tokens: 8,
          cache_write_input_tokens: 2,
          output_tokens: 13,
          reasoning_output_tokens: 5
        }
      }
    ]);

    expect(server.requests.map((request) => request.method)).toEqual([
      "initialize",
      "thread/start",
      "thread/name/set",
      "turn/start",
      "thread/backgroundTerminals/clean",
      "thread/unsubscribe"
    ]);
    expect(launchArguments).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
      "app-server"
    ]);
    expect(server.clientNotifications).toEqual([{ method: "initialized" }]);
    expect(server.requests[0]?.params).toEqual({
      clientInfo: {
        name: "tzu_do_ai_worker",
        title: "Tzu Do AI Worker",
        version: "0.1.0"
      },
      capabilities: { experimentalApi: true }
    });
    expect(server.requests[1]?.params).toMatchObject({
      model: "gpt-5.6-sol",
      serviceTier: "default",
      cwd: "/work/project",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      serviceName: "tzu_do_ai_worker",
      ephemeral: false,
      config: {
        model_reasoning_effort: "medium",
        sandbox_workspace_write: { network_access: true }
      }
    });
    expect(server.requests[2]?.params).toEqual({
      threadId: "thread-app-visible",
      name: "TASK-5259: PRD: AI Integration"
    });
    expect(server.requests[3]?.params).toMatchObject({
      threadId: "thread-app-visible",
      input: [{ type: "text", text: "Do the ticket", text_elements: [] }],
      model: "gpt-5.6-sol",
      effort: "medium",
      summary: "auto",
      serviceTier: "default",
      cwd: "/work/project",
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      outputSchema: { type: "object" }
    });
    expect(server.killed).toBe(false);
  });

  it("sends mixed text and image attachments as separate protocol entries in their original order", async () => {
    const server = standardServer();
    const codex = new AppServerCodex({ environment: {}, spawnProcess: () => server.asProcess() });
    const thread = codex.startThread(threadOptions);
    const streamed = await thread.runStreamed([
      { type: "text", text: "Compare these screenshots." },
      { type: "local_image", path: "/tmp/image one.png" },
      { type: "text", text: "The revised screen follows." },
      { type: "local_image", path: "/tmp/image-two.png" }
    ]);
    const events = await collect(streamed.events);
    await codex.close();
    expect(events.at(-1)?.type).toBe("turn.completed");
    expect(server.requests.find(request => request.method === "turn/start")?.params.input).toEqual([
      { type: "text", text: "Compare these screenshots.", text_elements: [] },
      { type: "localImage", path: "/tmp/image one.png" },
      { type: "text", text: "The revised screen follows.", text_elements: [] },
      { type: "localImage", path: "/tmp/image-two.png" }
    ]);
  });

  it("accepts SDK text arrays without nesting them inside the text field", async () => {
    const server = standardServer();
    const codex = new AppServerCodex({ environment: {}, spawnProcess: () => server.asProcess() });
    const streamed = await codex.startThread(threadOptions).runStreamed([{ type: "text", text: "Do the ticket" }]);
    await collect(streamed.events);
    await codex.close();
    expect(server.requests.find(request => request.method === "turn/start")?.params.input).toEqual([
      { type: "text", text: "Do the ticket", text_elements: [] }
    ]);
  });

  it("keeps follow-up turns on the same named thread", async () => {
    const server = standardServer();
    const codex = new AppServerCodex({
      environment: {},
      spawnProcess: () => server.asProcess(),
      closeTimeoutMs: 20
    });
    const thread = codex.startThread(threadOptions);

    const first = await thread.runStreamed("Initial input");
    const second = await thread.runStreamed("Latest edited input");
    const firstEvents = await collect(first.events);
    const secondEvents = await collect(second.events);
    await codex.close();

    expect(firstEvents.some((event) => event.type === "thread.started")).toBe(true);
    expect(secondEvents.some((event) => event.type === "thread.started")).toBe(false);
    expect(server.requests.filter((entry) => entry.method === "thread/start")).toHaveLength(1);
    expect(server.requests.filter((entry) => entry.method === "thread/name/set")).toHaveLength(1);
    const turnStarts = server.requests.filter((entry) => entry.method === "turn/start");
    expect(turnStarts).toHaveLength(2);
    expect(turnStarts.map((entry) => ({
      approvalPolicy: entry.params.approvalPolicy,
      sandboxPolicy: entry.params.sandboxPolicy
    }))).toEqual([
      { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } },
      { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } }
    ]);
  });

  it("interrupts the active App Server turn when its signal is aborted", async () => {
    const server = new FakeAppServer((request, fake) => {
      if (request.method === "initialize") {
        fake.respond(request.id);
      } else if (request.method === "thread/start") {
        fake.respond(request.id, { thread: { id: "thread-abort" } });
      } else if (request.method === "thread/name/set") {
        fake.respond(request.id);
      } else if (request.method === "thread/unsubscribe") {
        fake.respond(request.id);
      } else if (request.method === "turn/start") {
        fake.respond(request.id, { turn: { id: "turn-abort" } });
      } else if (request.method === "turn/interrupt") {
        fake.respond(request.id);
        queueMicrotask(() => fake.notify("turn/completed", {
          threadId: "thread-abort",
          turn: { id: "turn-abort", status: "interrupted", error: null }
        }));
      }
    });
    const codex = new AppServerCodex({
      environment: {},
      spawnProcess: () => server.asProcess(),
      closeTimeoutMs: 20
    });
    const controller = new AbortController();
    const thread = codex.startThread(threadOptions);
    const streamed = await thread.runStreamed("Long task", { signal: controller.signal });
    const iterator = streamed.events[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: "thread.started", thread_id: "thread-abort" }
    });
    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: "turn.started" }
    });
    controller.abort(new Error("shutdown"));
    expect(await iterator.next()).toEqual({
      done: false,
      value: {
        type: "turn.failed",
        error: { message: "Codex turn was interrupted" }
      }
    });
    expect((await iterator.next()).done).toBe(true);
    await codex.close();

    expect(server.requests.some((entry) =>
      entry.method === "turn/interrupt" &&
      entry.params.threadId === "thread-abort" &&
      entry.params.turnId === "turn-abort"
    )).toBe(true);
  });

  it("cancels while thread creation is still waiting for App Server", async () => {
    const threadStartSeen = deferred<void>();
    const server = new FakeAppServer((request, fake) => {
      if (request.method === "initialize") {
        fake.respond(request.id);
      } else if (request.method === "thread/start") {
        threadStartSeen.resolve();
      }
    });
    const codex = new AppServerCodex({
      environment: {},
      spawnProcess: () => server.asProcess(),
      closeTimeoutMs: 20,
      requestTimeoutMs: 1_000
    });
    const controller = new AbortController();
    const thread = codex.startThread(threadOptions);
    const streamed = await thread.runStreamed("Cancelled before start", {
      signal: controller.signal
    });
    const run = collect(streamed.events);
    await threadStartSeen.promise;
    controller.abort(new Error("shutdown"));

    await expect(run).rejects.toThrow("shutdown");
    await codex.close();
    expect(server.requests.some((entry) => entry.method === "turn/start")).toBe(false);
  });

  it("force-closes promptly when abort arrives before turn/start responds", async () => {
    vi.useFakeTimers();
    try {
      const turnStartSeen = deferred<void>();
      const server = new FakeAppServer((request, fake) => {
        if (request.method === "initialize") {
          fake.respond(request.id);
        } else if (request.method === "thread/start") {
          fake.respond(request.id, { thread: { id: "thread-wedged-turn" } });
        } else if (request.method === "thread/name/set") {
          fake.respond(request.id);
        } else if (request.method === "turn/start") {
          turnStartSeen.resolve();
        }
      });
      const codex = new AppServerCodex({
        environment: {},
        spawnProcess: () => server.asProcess(),
        closeTimeoutMs: 20,
        requestTimeoutMs: 30_000
      });
      const controller = new AbortController();
      const thread = codex.startThread(threadOptions);
      const streamed = await thread.runStreamed("Wedged turn", {
        signal: controller.signal
      });
      const run = collect(streamed.events);
      await turnStartSeen.promise;
      const rejected = expect(run).rejects.toThrow("Codex App Server closed");
      controller.abort(new Error("shutdown"));

      await rejected;
      await codex.close();
      expect(server.requests.some((entry) =>
        entry.method === "turn/interrupt"
      )).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a wedged App Server control request", async () => {
    const server = new FakeAppServer(() => undefined);
    const codex = new AppServerCodex({
      environment: {},
      spawnProcess: () => server.asProcess(),
      closeTimeoutMs: 20,
      requestTimeoutMs: 10
    });
    const thread = codex.startThread(threadOptions);
    const streamed = await thread.runStreamed("Never starts");

    await expect(collect(streamed.events)).rejects.toThrow(
      "Unable to initialize Codex App Server"
    );
    await codex.close();
  });

  it("retains failed startup teardown as an error when cancellation cannot stop the child", async () => {
    const initializing = deferred<void>();
    const server = new FakeAppServer(() => initializing.resolve());
    server.stdin.removeAllListeners("finish");
    server.kill = () => false;
    const codex = new AppServerCodex({ environment: {}, spawnProcess: () => server.asProcess(), closeTimeoutMs: 2 });
    const controller = new AbortController();
    const streamed = await codex.startThread(threadOptions).runStreamed("Never starts", { signal: controller.signal });
    const events = collect(streamed.events);
    await initializing.promise;
    const rejected = expect(events).rejects.toThrow("did not exit after forced termination");
    controller.abort(new Error("cancel"));
    await rejected;
    await expect(codex.close()).rejects.toThrow("did not exit after forced termination");
    expect(server.requests.some((request) => request.method === "thread/start")).toBe(false);
  });

  it("ignores a late completion notification from the previous turn", async () => {
    let turnCount = 0;
    const server = new FakeAppServer((request, fake) => {
      if (request.method === "initialize") {
        fake.respond(request.id);
      } else if (request.method === "thread/start") {
        fake.respond(request.id, { thread: { id: "thread-stale" } });
      } else if (
        request.method === "thread/name/set" ||
        request.method === "thread/unsubscribe"
      ) {
        fake.respond(request.id);
      } else if (request.method === "turn/start") {
        turnCount += 1;
        const turnId = `turn-${turnCount}`;
        fake.respond(request.id, { turn: { id: turnId } });
        queueMicrotask(() => {
          if (turnCount === 2) {
            fake.notify("turn/completed", {
              threadId: "thread-stale",
              turn: { id: "turn-1", status: "completed", error: null }
            });
          }
          fake.notify("item/completed", {
            threadId: "thread-stale",
            turnId,
            item: {
              type: "agentMessage",
              id: `message-${turnId}`,
              text: `response-${turnId}`
            }
          });
          fake.notify("turn/completed", {
            threadId: "thread-stale",
            turn: { id: turnId, status: "completed", error: null }
          });
        });
      }
    });
    const codex = new AppServerCodex({
      environment: {},
      spawnProcess: () => server.asProcess(),
      closeTimeoutMs: 20
    });
    const thread = codex.startThread(threadOptions);
    const first = await thread.runStreamed("first");
    await collect(first.events);
    const second = await thread.runStreamed("second");
    const secondEvents = await collect(second.events);
    await codex.close();

    expect(secondEvents).toContainEqual({
      type: "item.completed",
      item: {
        id: "message-turn-2",
        type: "agent_message",
        text: "response-turn-2"
      }
    });
    expect(secondEvents.at(-1)?.type).toBe("turn.completed");
  });

  it("logs the exact malformed App Server output before failing", async () => {
    const secretOutput = "sensitive-tool-output";
    const logger = {
      error: vi.fn(),
      warn: vi.fn()
    } as unknown as Pick<Logger, "error" | "warn">;
    const server = new FakeAppServer((request, fake) => {
      if (request.method === "initialize") {
        fake.stdout.write(`${secretOutput}\n`);
      }
    });
    const codex = new AppServerCodex({
      environment: {},
      spawnProcess: () => server.asProcess(),
      closeTimeoutMs: 20,
      logger
    });
    const thread = codex.startThread(threadOptions);
    const streamed = await thread.runStreamed("Do not leak");

    let failure: unknown;
    try {
      await collect(streamed.events);
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      "Unable to initialize Codex App Server"
    );
    expect((failure as Error).message).not.toContain(secretOutput);
    expect(logger.error).toHaveBeenCalledWith({
      event: "codex.protocol_invalid_json",
      protocol_line: secretOutput,
      protocol_line_length: secretOutput.length
    }, "Codex App Server returned invalid protocol JSON");
    await codex.close();
  });
});


it("streams local command activity before a running turn completes", async () => {
  const server = new FakeAppServer((request, fake) => {
    if (request.method === "initialize") fake.respond(request.id);
    else if (request.method === "thread/start") fake.respond(request.id, { thread: { id: "thread-live" } });
    else if (request.method === "thread/name/set" || request.method === "thread/unsubscribe") fake.respond(request.id);
    else if (request.method === "turn/start") {
      fake.respond(request.id, { turn: { id: "turn-live" } });
      queueMicrotask(() => {
        fake.notify("item/started", { threadId: "thread-live", turnId: "turn-live", item: { type: "commandExecution", command: "npm test" } });
        fake.notify("item/commandExecution/outputDelta", { threadId: "different-thread", turnId: "turn-live", itemId: "bad", delta: "must ignore" });
        fake.notify("item/commandExecution/outputDelta", { threadId: "thread-live", turnId: "turn-live", itemId: "cmd", delta: "First test passed" });
      });
    }
  });
  const codex = new AppServerCodex({ environment: {}, spawnProcess: () => server.asProcess(), closeTimeoutMs: 20 });
  const { events } = await codex.startThread(threadOptions).runStreamed("Test streaming");
  expect((await events.next()).value).toMatchObject({ type: "thread.started" });
  expect((await events.next()).value).toMatchObject({ type: "turn.started" });
  expect((await events.next()).value).toEqual({ type: "local.activity", kind: "activity.started", text: "$ npm test" });
  expect((await events.next()).value).toEqual({ type: "local.activity", kind: "command.output", text: "First test passed" });
  server.notify("turn/completed", { threadId: "thread-live", turn: { id: "turn-live", status: "completed" } });
  expect((await events.next()).value).toMatchObject({ type: "turn.completed" });
  await events.next();
  await codex.close();
});
