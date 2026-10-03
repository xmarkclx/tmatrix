import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Input } from "@openai/codex-sdk";
import { describe, expect, it, vi } from "vitest";
import type { TicketApi } from "../src/api-client.js";
import { RunCancellationError } from "../src/errors.js";
import { nullLogger } from "../src/logger.js";
import { Metrics } from "../src/metrics.js";
import type { CodexLike } from "../src/runner.js";
import {
  SteeringMailbox,
  TicketRunner,
  type WorkerThreadEvent
} from "../src/runner.js";
import type { ExecutionProfile, ProgressEvent, TicketResult } from "../src/types.js";
import { deferred, makeTicket } from "./helpers.js";

function apiMock() {
  return {
    markTaken: vi.fn(async () => undefined),
    getHistory: vi.fn(async (): Promise<unknown> => ({
      summary: "Prior worker created the branch."
    })),
    reportProgress: vi.fn(async (_ticket, _event: ProgressEvent) => undefined),
    reportResult: vi.fn(async (_ticket, _result: TicketResult) => undefined)
  } satisfies TicketApi;
}

interface CodexCapture {
  profiles?: ExecutionProfile[];
  prompts?: Input[];
  threadOptions?: unknown;
  turnOptions?: unknown[];
  startThreadCalls?: number;
}

function codexMock(turns: WorkerThreadEvent[][], capture: CodexCapture): CodexLike {
  let turnIndex = 0;
  return {
    startThread(options) {
      capture.threadOptions = options;
      capture.startThreadCalls = (capture.startThreadCalls ?? 0) + 1;
      return {
        async runStreamed(prompt, options) {
          capture.prompts = [...(capture.prompts ?? []), prompt];
          capture.turnOptions = [...(capture.turnOptions ?? []), options];
          const events = turns[turnIndex++] ?? [];
          return {
            events: (async function* () {
              for (const event of events) yield event;
            })()
          };
        }
      };
    }
  };
}

const usage = {
  input_tokens: 10,
  cached_input_tokens: 2,
  cache_write_input_tokens: 1,
  output_tokens: 5,
  reasoning_output_tokens: 3
};

function handoffText(
  outcome: "AI_DONE" | "AI_NEEDS_FEEDBACK",
  contextSummary: string,
  userMessage: string
): string {
  return JSON.stringify({
    outcome,
    context_summary: contextSummary,
    user_message: userMessage
  });
}

describe("TicketRunner", () => {
  it("screens initial and steering text before executable turns without holding a flagged job", async () => {
    const screened: string[] = [];
    const api = apiMock();
    const mailbox = new SteeringMailbox();
    mailbox.enqueue({ worker_id: makeTicket().worker_id, input_revision: 2, content: "Changed suspicious instructions" });
    const runner = new TicketRunner({
      api, logger: nullLogger(), metrics: new Metrics(),
      screenPrompt: async (_ticket, text) => { screened.push(text); },
      runtimeFactory: () => ({ startThread: () => ({ runStreamed: async (input) => {
        expect(screened).toContain(input);
        return { events: (async function* () {
          yield { type: "item.completed" as const, item: { id: "answer", type: "agent_message" as const,
            text: handoffText("AI_DONE", "done", "done") } };
          yield { type: "turn.completed" as const, usage };
        })() };
      } }) }),
    });
    await runner.run(makeTicket({ input_revision: 1 }), { runId: "screen-test", recovered: false, steering: mailbox });
    expect(screened.some(text => text.includes("Changed suspicious instructions"))).toBe(true);
    expect(api.reportResult).toHaveBeenCalled();
  });

  it.each([
    ["FAST", "low", "priority"],
    ["NORMAL", "medium", "default"],
    ["HIGH", "ultra", "default"]
  ] as const)(
    "passes the %s execution snapshot to Codex as gpt-5.6-sol/%s/%s",
    async (executionMode, reasoningEffort, serviceTier) => {
      const api = apiMock();
      const capture: CodexCapture = {};
      const codex = codexMock([
        [
          {
            type: "item.completed",
            item: {
              id: `message-${executionMode}`,
              type: "agent_message",
              text: handoffText("AI_DONE", "Completed.", "Ready for review.")
            }
          },
          { type: "turn.completed", usage }
        ]
      ], capture);
      const runner = new TicketRunner({
        codexFactory: (profile) => {
          capture.profiles = [...(capture.profiles ?? []), profile];
          return codex;
        },
        api,
        logger: nullLogger(),
        metrics: new Metrics()
      });

      await runner.run(makeTicket({
        execution_mode: executionMode,
        model: "gpt-5.6-sol",
        reasoning_effort: reasoningEffort,
        service_tier: serviceTier
      }), { runId: `run-${executionMode}`, recovered: false });

      expect(capture.profiles).toEqual([{
        execution_mode: executionMode,
        model: "gpt-5.6-sol",
        reasoning_effort: reasoningEffort,
        service_tier: serviceTier
      }]);
      expect(capture.threadOptions).toMatchObject({
        model: "gpt-5.6-sol",
        modelReasoningEffort: reasoningEffort,
        serviceTier
      });
    }
  );

  it("hydrates durable history, streams progress, and reports the final result", async () => {
    const api = apiMock();
    const capture: CodexCapture = {};
    const projectDirectory = await mkdtemp(join(tmpdir(), "aiworker-project-"));
    const codex = codexMock([
      [
        { type: "thread.started", thread_id: "thread-1" },
        { type: "turn.started" },
        {
          type: "item.completed",
          item: {
            id: "file-1",
            type: "file_change",
            status: "completed",
            changes: [{
              path: "HelloWorld.md",
              kind: "add",
              diff: [
                "--- /dev/null",
                "+++ b/HelloWorld.md",
                "@@ -0,0 +1 @@",
                "+# Hello World"
              ].join("\n")
            }]
          }
        },
        {
          type: "item.completed",
          item: {
            id: "command-1",
            type: "command_execution",
            command: "deploy --credential top-secret-command",
            aggregated_output: "top-secret-output",
            exit_code: 0,
            status: "completed"
          }
        },
        {
          type: "item.completed",
          item: {
            id: "message-1",
            type: "agent_message",
            text: handoffText(
              "AI_DONE",
              "Created HelloWorld.md and verified it.",
              "Created HelloWorld.md; it is ready for review."
            )
          }
        },
        { type: "turn.completed", usage }
      ]
    ], capture);
    const runner = new TicketRunner({
      codexFactory: (profile) => {
        capture.profiles = [...(capture.profiles ?? []), profile];
        return codex;
      },
      api,
      logger: nullLogger(),
      metrics: new Metrics()
    });

    const outcome = await runner.run(makeTicket({
      input_revision: 7,
      project_path: projectDirectory,
      task_id: 5259,
      instructions: [
        "# Instructions",
        "",
        "Title this LLM chat as `TASK-5259: PRD: AI Integration`.",
        "",
        "# Task",
        "",
        "Create HelloWorld.md"
      ].join("\n")
    }), { runId: "run-1", recovered: false });

    expect(outcome).toEqual({ status: "completed", threadId: "thread-1" });
    expect(capture.prompts?.[0]).toContain("Create HelloWorld.md");
    expect(capture.prompts?.[0]).toContain("Prior worker created the branch.");
    expect(capture.threadOptions).toMatchObject({
      model: "gpt-5.6-sol",
      modelReasoningEffort: "medium",
      serviceTier: "default",
      workingDirectory: projectDirectory,
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      networkAccessEnabled: true,
      threadName: "TASK-5259: PRD: AI Integration"
    });
    expect(capture.profiles).toEqual([{
      execution_mode: "NORMAL",
      model: "gpt-5.6-sol",
      reasoning_effort: "medium",
      service_tier: "default"
    }]);
    expect(api.reportProgress).toHaveBeenCalledTimes(6);
    expect(
      api.reportProgress.mock.calls.every((call) => call[1].input_revision === 7)
    ).toBe(true);
    const reportedProgress = JSON.stringify(
      api.reportProgress.mock.calls.map((call) => call[1])
    );
    expect(reportedProgress).not.toContain("top-secret-command");
    expect(reportedProgress).not.toContain("top-secret-output");
    expect(reportedProgress).not.toContain("Created HelloWorld.md and verified it.");
    expect(reportedProgress).not.toContain("# Hello World");
    expect(api.reportResult).toHaveBeenCalledOnce();
    expect(api.reportResult.mock.calls[0]![1]).toMatchObject({
      status: "completed",
      input_revision: 7,
      outcome: "AI_DONE",
      context_summary: "Created HelloWorld.md and verified it.",
      user_message: "Created HelloWorld.md; it is ready for review.",
      final_response: "Created HelloWorld.md; it is ready for review.",
      thread_id: "thread-1",
      usage
    });
    expect(capture.turnOptions?.[0]).toMatchObject({
      outputSchema: {
        required: ["outcome", "context_summary", "user_message"]
      }
    });
  });

  it("attaches each trusted Markdown image once and removes its temporary file", async () => {
    const api = apiMock();
    const capture: CodexCapture = {};
    const imageUrl =
      "/api/uploads/images/markdown-images/54/11111111-1111-4111-8111-111111111111.png";
    let attachedPath: string | undefined;
    const codex: CodexLike = {
      startThread() {
        return {
          async runStreamed(input) {
            capture.prompts = [...(capture.prompts ?? []), input];
            expect(input).toEqual([
              expect.objectContaining({ type: "text" }),
              expect.objectContaining({ type: "local_image" })
            ]);
            if (!Array.isArray(input) || input[1]?.type !== "local_image") {
              throw new Error("Expected a local image input.");
            }
            attachedPath = input[1].path;
            await expect(readFile(attachedPath, "utf8")).resolves.toBe("png-data");
            return {
              events: (async function* (): AsyncGenerator<WorkerThreadEvent> {
                yield {
                  type: "item.completed",
                  item: {
                    id: "message-with-image",
                    type: "agent_message",
                    text: handoffText("AI_DONE", "Inspected the image.", "Ready.")
                  }
                };
                yield { type: "turn.completed", usage };
              })()
            };
          }
        };
      }
    };
    const fetch = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe(`https://tasks.example.test${imageUrl}`);
      return new Response("png-data", {
        headers: {
          "content-length": "8",
          "content-type": "image/png"
        }
      });
    }) as typeof globalThis.fetch;
    const runner = new TicketRunner({
      codexFactory: () => codex,
      api,
      logger: nullLogger(),
      metrics: new Metrics(),
      fetch
    });

    await runner.run(makeTicket({
      instructions: `Inspect ![first|400](${imageUrl}) and duplicate ![again](${imageUrl}).`
    }), { runId: "run-with-image", recovered: false });

    expect(fetch).toHaveBeenCalledOnce();
    expect(attachedPath).toBeDefined();
    await expect(access(attachedPath!)).rejects.toThrow();
  });

  it("does not append file inventories or hunks to the authored result", async () => {
    const api = apiMock();
    const runner = new TicketRunner({
      codexFactory: () => codexMock([
        [
          {
            type: "item.completed",
            item: {
              id: "files-1",
              type: "file_change",
              status: "completed",
              changes: [
                {
                  path: "src/example.ts",
                  kind: "add",
                  diff: "@@ -0,0 +1 @@\n+first"
                },
                {
                  path: "old.ts",
                  kind: "delete",
                  diff: "@@ -1 +0,0 @@\n-old"
                }
              ]
            }
          },
          {
            type: "item.completed",
            item: {
              id: "files-2",
              type: "file_change",
              status: "completed",
              changes: [{
                path: "src/example.ts",
                kind: "update",
                diff: "@@ -1 +1 @@\n-first\n+second"
              }]
            }
          },
          {
            type: "item.completed",
            item: {
              id: "message-files",
              type: "agent_message",
              text: handoffText("AI_DONE", "Implemented and tested.", "Ready for review.")
            }
          },
          { type: "turn.completed", usage }
        ]
      ], {}),
      api,
      logger: nullLogger(),
      metrics: new Metrics()
    });

    await runner.run(makeTicket(), { runId: "run-file-inventory", recovered: false });

    const result = api.reportResult.mock.calls[0]![1];
    expect(result.user_message).toBe("Ready for review.");
    expect(result.final_response).toBe(result.user_message);
    expect(result.context_summary).toBe("Implemented and tested.");
  });

  it("preserves optional technical details without appending file evidence", async () => {
    const api = apiMock();
    const message = "Investigation complete.\n\n<details><summary>Technical details</summary>Useful findings.</details>";
    const runner = new TicketRunner({
      codexFactory: () => codexMock([[
        { type: "item.completed", item: {
          id: "optional-files", type: "file_change", status: "completed",
          changes: [{ path: "example.ts", kind: "update", diff: "+private hunk" }]
        } },
        { type: "item.completed", item: {
          id: "optional-message", type: "agent_message",
          text: handoffText("AI_DONE", "Investigation context.", message)
        } },
        { type: "turn.completed", usage }
      ]], {}),
      api, logger: nullLogger(), metrics: new Metrics()
    });
    await runner.run(makeTicket(), { runId: "optional-details", recovered: false });
    expect(api.reportResult.mock.calls[0]![1].user_message).toBe(message);
  });

  it("treats inherited context as branch-scoped evidence behind one visible handoff", async () => {
    const api = apiMock();
    api.getHistory.mockResolvedValue({
      thread_anchor_comment_id: 412,
      inherited_context: {
        sourceCommentId: 412,
        content: "Branch A created src/branch-a.ts; verify it before reuse."
      },
      comments: [
        {
          id: 412,
          content: "Branch A is ready for the requested follow-up."
        },
        {
          id: 499,
          content: "Unrelated branch B result."
        }
      ]
    });
    const capture: CodexCapture = {};
    const codex = codexMock([
      [
        {
          type: "item.completed",
          item: {
            id: "message-context-handoff",
            type: "agent_message",
            text: handoffText(
              "AI_DONE",
              "Verified src/branch-a.ts and completed the latest revision.",
              "The branch A follow-up is ready for review."
            )
          }
        },
        { type: "turn.completed", usage }
      ]
    ], capture);
    const runner = new TicketRunner({
      codexFactory: () => codex,
      api,
      logger: nullLogger(),
      metrics: new Metrics()
    });

    await runner.run(makeTicket({
      input_revision: 4,
      trigger_comment_id: 413,
      thread_anchor_comment_id: 412,
      instructions: "Apply the latest human revision to branch A."
    }), { runId: "run-inherited-context", recovered: true });

    const prompt = capture.prompts?.[0] ?? "";
    expect(prompt).toContain('"thread_anchor_comment_id": 412');
    expect(prompt).toContain('"inherited_context"');
    expect(prompt).toContain(
      "Branch A created src/branch-a.ts; verify it before reuse."
    );
    expect(prompt).toContain("branch-specific prior-session evidence");
    expect(prompt).toContain("current ticket and latest human revision override it");
    expect(prompt).toContain("important claims should be verified against the workspace");
    expect(prompt).toContain("attached to the same comment as user_message");
    expect(prompt).toContain("never include secrets or hidden chain-of-thought");
    expect(prompt).toContain("do not duplicate the context summary in it");
    expect(prompt).toContain(
      "Rely on linked PR/CI evidence"
    );
    expect(prompt).toContain("Technical details are optional");

    const turnOptions = capture.turnOptions?.[0] as {
      outputSchema?: {
        properties?: {
          context_summary?: { description?: string };
          user_message?: { description?: string };
        };
      };
    } | undefined;
    expect(turnOptions?.outputSchema?.properties?.context_summary?.description)
      .toContain("Private operational continuation state");
    expect(turnOptions?.outputSchema?.properties?.user_message?.description)
      .toContain("Do not repeat the continuation context");
    expect(turnOptions?.outputSchema?.properties?.user_message?.description)
      .toContain("Rely on linked PR/CI evidence");
    expect(api.reportResult).toHaveBeenCalledOnce();
    expect(api.reportResult.mock.calls[0]![1]).toMatchObject({
      input_revision: 4,
      context_summary:
        "Verified src/branch-a.ts and completed the latest revision.",
      user_message: "The branch A follow-up is ready for review.",
      final_response: "The branch A follow-up is ready for review."
    });
  });

  it("reports a failed result when Codex emits turn.failed", async () => {
    const api = apiMock();
    const codex = codexMock([
      [
        { type: "thread.started", thread_id: "thread-failed" },
        { type: "turn.failed", error: { message: "model unavailable" } }
      ]
    ], {});
    const runner = new TicketRunner({
      codexFactory: () => codex,
      api,
      logger: nullLogger(),
      metrics: new Metrics()
    });

    const outcome = await runner.run(makeTicket(), { runId: "run-failed", recovered: false });

    expect(outcome.status).toBe("failed");
    expect(api.reportResult.mock.calls[0]![1]).toMatchObject({
      status: "failed",
      input_revision: 0,
      error: {
        code: "CODEX_TURN_FAILED",
        message: "model unavailable",
        stage: "codex.turn"
      }
    });
  });

  it("reports an interrupted App Server turn as a retryable aborted run", async () => {
    const api = apiMock();
    const controller = new AbortController();
    controller.abort(new Error("shutdown"));
    const codex = codexMock([
      [{ type: "turn.failed", error: { message: "Codex turn was interrupted" } }]
    ], {});
    const runner = new TicketRunner({
      codexFactory: () => codex,
      api,
      logger: nullLogger(),
      metrics: new Metrics()
    });

    const outcome = await runner.run(makeTicket(), {
      runId: "run-aborted",
      recovered: false,
      signal: controller.signal
    });

    expect(outcome.status).toBe("failed");
    expect(api.reportResult.mock.calls[0]![1]).toMatchObject({
      status: "failed",
      error: {
        code: "CODEX_RUN_ABORTED",
        stage: "codex.run",
        retryable: true
      }
    });
  });

  it("returns cancelled and skips result reporting only after Codex teardown", async () => {
    const api = apiMock();
    const turnStarted = deferred<void>();
    const steeringStarted = deferred<void>();
    const mailbox = new SteeringMailbox();
    mailbox.enqueueLocal("cancel-message", "Check focus");
    const closeStarted = deferred<void>();
    const finishClose = deferred<void>();
    const codex: CodexLike = {
      startThread() {
        return {
          async steer(_input, options) {
            const receipt = new Promise<boolean>((_resolve, reject) => {
              options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
            });
            steeringStarted.resolve();
            return receipt;
          },
          async runStreamed(_prompt, options) {
            return {
              events: (async function* (): AsyncGenerator<WorkerThreadEvent> {
                yield { type: "turn.started" };
                turnStarted.resolve();
                await new Promise<void>((_resolve, reject) => {
                  options?.signal?.addEventListener(
                    "abort",
                    () => reject(options.signal?.reason),
                    { once: true }
                  );
                });
              })()
            };
          }
        };
      },
      async close() {
        closeStarted.resolve();
        await finishClose.promise;
      }
    };
    const runner = new TicketRunner({
      codexFactory: () => codex,
      api,
      logger: nullLogger(),
      metrics: new Metrics()
    });
    const controller = new AbortController();
    const run = runner.run(makeTicket(), {
      runId: "run-user-cancelled",
      recovered: false,
      steering: mailbox,
      signal: controller.signal
    });
    await turnStarted.promise;
    await steeringStarted.promise;

    controller.abort(new RunCancellationError({
      kind: "user",
      eventId: "cancel-1001",
      ticketId: "T-1001",
      workerId: "w-1001"
    }));
    await closeStarted.promise;
    expect(api.reportResult).not.toHaveBeenCalled();
    let settled = false;
    void run.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    finishClose.resolve();
    await expect(run).resolves.toEqual({ status: "cancelled" });
    expect(api.reportResult).not.toHaveBeenCalled();
  });

  it("coalesces steering revisions and continues on the same Codex thread", async () => {
    const api = apiMock();
    const capture: CodexCapture = {};
    const steering = new SteeringMailbox();
    const firstTurnStarted = deferred<void>();
    const finishFirstTurn = deferred<void>();
    let turnIndex = 0;
    const codex: CodexLike = {
      startThread(options) {
        capture.threadOptions = options;
        capture.startThreadCalls = (capture.startThreadCalls ?? 0) + 1;
        return {
          async runStreamed(prompt, options) {
            const currentTurn = turnIndex++;
            capture.prompts = [...(capture.prompts ?? []), prompt];
            capture.turnOptions = [...(capture.turnOptions ?? []), options];
            return {
              events: (async function* (): AsyncGenerator<WorkerThreadEvent> {
                if (currentTurn === 0) {
                  yield { type: "thread.started", thread_id: "thread-steered" };
                  firstTurnStarted.resolve();
                  await finishFirstTurn.promise;
                  yield {
                    type: "item.completed",
                    item: {
                      id: "message-initial",
                      type: "agent_message",
                      text: handoffText("AI_DONE", "Initial summary", "Initial result")
                    }
                  };
                } else {
                  yield {
                    type: "item.completed",
                    item: {
                      id: "message-steered",
                      type: "agent_message",
                      text: handoffText(
                        "AI_NEEDS_FEEDBACK",
                        "Applied the latest revision.",
                        "Which environment should receive it?"
                      )
                    }
                  };
                }
                yield { type: "turn.completed", usage };
              })()
            };
          }
        };
      }
    };
    const runner = new TicketRunner({
      codexFactory: () => codex,
      api,
      logger: nullLogger(),
      metrics: new Metrics(),
      fetch: vi.fn(async () => new Response("webp-data", {
        headers: {
          "content-length": "9",
          "content-type": "image/webp"
        }
      })) as typeof globalThis.fetch
    });

    const run = runner.run(makeTicket({ input_revision: 1 }), {
      runId: "run-steered",
      recovered: false,
      steering
    });
    await firstTurnStarted.promise;
    steering.enqueue({
      worker_id: "w-1001",
      input_revision: 2,
      content: "Use the first environment."
    });
    steering.enqueue({
      worker_id: "w-1001",
      input_revision: 3,
      content: [
        "Use the latest environment instead.",
        "![updated screenshot](/api/uploads/images/markdown-images/54/22222222-2222-4222-8222-222222222222.webp)"
      ].join("\n\n")
    });
    finishFirstTurn.resolve();

    await run;

    expect(capture.startThreadCalls).toBe(1);
    expect(capture.prompts).toHaveLength(2);
    const steeredInput = capture.prompts?.[1];
    expect(Array.isArray(steeredInput)).toBe(true);
    const steeredPrompt = Array.isArray(steeredInput) && steeredInput[0]?.type === "text"
      ? steeredInput[0].text
      : "";
    expect(steeredPrompt).toContain("revision 3");
    expect(steeredPrompt).toContain("Use the latest environment instead.");
    expect(steeredPrompt).not.toContain("Use the first environment.");
    expect(steeredPrompt).toContain(
      "Rely on linked PR/CI evidence"
    );
    expect(api.reportResult.mock.calls[0]![1]).toMatchObject({
      status: "completed",
      input_revision: 3,
      outcome: "AI_NEEDS_FEEDBACK",
      context_summary: "Applied the latest revision.",
      user_message: "Which environment should receive it?",
      usage: {
        input_tokens: 20,
        output_tokens: 10
      }
    });
    expect(
      api.reportProgress.mock.calls.some((call) => call[1].input_revision === 3)
    ).toBe(true);
  });

  it("falls back to /tmp when the project path is not an existing absolute directory", async () => {
    const api = apiMock();
    const capture: CodexCapture = {};
    const codex = codexMock([
      [
        {
          type: "item.completed",
          item: {
            id: "message-fallback",
            type: "agent_message",
            text: handoffText("AI_DONE", "Used fallback workspace.", "Ready for review.")
          }
        },
        { type: "turn.completed", usage }
      ]
    ], capture);
    const runner = new TicketRunner({
      codexFactory: () => codex,
      api,
      logger: nullLogger(),
      metrics: new Metrics()
    });

    await runner.run(makeTicket({ project_path: "relative/missing" }), {
      runId: "run-fallback",
      recovered: false
    });

    expect(capture.threadOptions).toMatchObject({ workingDirectory: "/tmp" });
    expect(capture.threadOptions).toMatchObject({ threadName: "Tzu Do T-1001" });
  });

  it("surfaces final-result delivery failure distinctly", async () => {
    const api = apiMock();
    api.reportResult.mockRejectedValue(new Error("API down"));
    const runner = new TicketRunner({
      codexFactory: () => codexMock([
        [
          {
            type: "item.completed",
            item: {
              id: "message-result-fail",
              type: "agent_message",
              text: handoffText("AI_DONE", "Completed.", "Ready for review.")
            }
          },
          { type: "turn.completed", usage }
        ]
      ], {}),
      api,
      logger: nullLogger(),
      metrics: new Metrics()
    });

    await expect(runner.run(makeTicket(), { runId: "run-result-fail", recovered: false }))
      .rejects.toMatchObject({ code: "RESULT_REPORT_FAILED", stage: "result" });
  });
});

describe("TMatrix local steering", () => {
  it("delivers ordered messages during a quiet active turn before that turn completes", async () => {
    const mailbox = new SteeringMailbox();
    const ready = deferred();
    const finish = deferred();
    const firstReceived = deferred();
    const secondReceived = deferred();
    const api = apiMock();
    const observations: import("../src/local-worker-state.js").WorkerObservation[] = [];
    const screened: string[] = [];
    const runStreamed = vi.fn(async () => ({ events: (async function* (): AsyncGenerator<WorkerThreadEvent> {
      yield { type: "thread.started", thread_id: "existing-thread" };
      yield { type: "turn.started" };
      ready.resolve(undefined);
      await finish.promise;
      yield { type: "item.completed", item: { id: "final", type: "agent_message", text: handoffText("AI_DONE", "Completed", "Ready") } };
      yield { type: "turn.completed", usage };
    })() }));
    const steer = vi.fn(async () => true);
    const runner = new TicketRunner({
      runtimeFactory: () => ({ startThread: () => ({ runStreamed, steer }) }),
      screenPrompt: async (_ticket, text) => { screened.push(text); },
      api, logger: nullLogger(), metrics: new Metrics()
    });
    const running = runner.run(makeTicket({ input_revision: 4 }), {
      runId: "live-test", recovered: false, steering: mailbox,
      observe: (event) => {
        observations.push(event);
        if (event.kind === "steering.runtime_received" && event.steering_id === "one") firstReceived.resolve(undefined);
        if (event.kind === "steering.runtime_received" && event.steering_id === "two") secondReceived.resolve(undefined);
      }
    });
    await ready.promise;
    mailbox.enqueueLocal("one", "LOCAL_GUIDANCE_ONE: Check focus");
    await firstReceived.promise;
    mailbox.enqueueLocal("two", "LOCAL_GUIDANCE_TWO: Check wrapping");
    await secondReceived.promise;
    expect(api.reportResult).not.toHaveBeenCalled();
    expect(steer).toHaveBeenCalledTimes(2);
    const sent = steer.mock.calls.map(call => JSON.stringify(call));
    expect(sent[0]).toContain("LOCAL_GUIDANCE_ONE");
    expect(sent[1]).toContain("LOCAL_GUIDANCE_TWO");
    expect(screened.filter(text => text.includes("LOCAL_GUIDANCE"))).toHaveLength(2);
    finish.resolve(undefined);
    await expect(running).resolves.toMatchObject({ status: "completed", threadId: "existing-thread" });
    expect(runStreamed).toHaveBeenCalledTimes(1);
    expect(observations.filter(event => event.kind === "steering.response_observed").map(event => event.steering_id)).toEqual(["one", "two"]);
    expect(api.reportResult.mock.calls[0]?.[1].input_revision).toBe(4);
    expect(JSON.stringify([api.reportProgress.mock.calls, api.reportResult.mock.calls])).not.toContain("LOCAL_GUIDANCE");
    expect(mailbox.enqueueLocal("late", "Too late")).toBe(false);
  });

  it.each(["rejected", "ambiguous", "completion-race", "late-accept"])("handles %s live delivery without losing or duplicating the message", async (mode) => {
    const mailbox = new SteeringMailbox();
    mailbox.enqueueLocal("one", "Check focus");
    const attempted = deferred();
    const completed = deferred();
    const api = apiMock();
    const observations: import("../src/local-worker-state.js").WorkerObservation[] = [];
    let turn = 0;
    const runStreamed = vi.fn(async () => ({ events: (async function* (): AsyncGenerator<WorkerThreadEvent> {
      yield { type: "turn.started" };
      if (++turn === 1) await attempted.promise;
      yield { type: "item.completed", item: { id: "final", type: "agent_message", text: handoffText("AI_DONE", "Completed", "Ready") } };
      yield { type: "turn.completed", usage };
      completed.resolve(undefined);
    })() }));
    const steer = vi.fn(async () => {
      attempted.resolve(undefined);
      if (mode === "completion-race") { await completed.promise; return false; }
      if (mode === "late-accept") { await completed.promise; return true; }
      if (mode === "ambiguous") throw new Error("Fixture transport failure");
      return false;
    });
    const runner = new TicketRunner({ runtimeFactory: () => ({ startThread: () => ({ runStreamed, steer }) }), api, logger: nullLogger(), metrics: new Metrics() });
    await runner.run(makeTicket({ input_revision: 4 }), { runId: "fallback-test", recovered: false, steering: mailbox, observe: event => observations.push(event) });
    expect(steer).toHaveBeenCalledTimes(1);
    expect(runStreamed).toHaveBeenCalledTimes(mode === "ambiguous" || mode === "late-accept" ? 1 : 2);
    expect(observations.filter(event => event.steering_id === "one").map(event => event.kind)).toEqual(mode === "ambiguous"
      ? ["steering.failed"]
      : mode === "late-accept" ? ["steering.runtime_received"]
      : ["steering.deferred", "steering.runtime_received", "steering.response_observed"]);
    expect(api.reportResult.mock.calls[0]?.[1].input_revision).toBe(4);
  });
  it("keeps queued messages on the same thread without inventing task revisions", async () => {
    const mailbox = new SteeringMailbox();
    expect(mailbox.enqueueLocal("local-1", "Check keyboard navigation")).toBe(true);
    const api = apiMock();
    const capture: CodexCapture = {};
    const events: import("../src/local-worker-state.js").WorkerObservation[] = [];
    const turn = (id: string): WorkerThreadEvent[] => [
      { type: "turn.started" },
      { type: "local.activity", kind: "command.output", text: "private terminal output" },
      { type: "item.completed", item: { id: "reasoning", type: "reasoning", text: "Checking keyboard navigation before changing focus handling." } },
      { type: "item.completed", item: { id: "empty-reasoning", type: "reasoning", text: "  " } },
      { type: "item.completed", item: { id, type: "agent_message", text: handoffText("AI_DONE", "private handoff", "Ready") } },
      { type: "turn.completed", usage }
    ];
    const runner = new TicketRunner({
      codexFactory: () => codexMock([turn("one"), turn("two")], capture), api, logger: nullLogger(), metrics: new Metrics()
    });
    await runner.run(makeTicket({ input_revision: 3, instructions: "LOCAL_PREPARED_INPUT: Follow the repository checkout conventions." }), { runId: "local-test", recovered: false, steering: mailbox, observe: (event) => events.push(event) });
    expect(capture.startThreadCalls).toBe(1);
    expect(capture.prompts).toHaveLength(2);
    expect(capture.prompts?.[1]).toContain("Check keyboard navigation");
    expect(events.filter((event) => event.kind === "prompt.prepared")).toEqual([
      { kind: "prompt.prepared", text: capture.prompts?.[0], input_revision: 3 }
    ]);
    expect(events[0]?.text).toContain("LOCAL_PREPARED_INPUT");
    expect(capture.prompts?.[0]).not.toContain("Before PR work: worktree checklist");
    expect(capture.prompts?.[0]).not.toContain("worktrees.py");
    expect(capture.prompts?.[0]).toContain("Follow the repository checkout conventions.");
    const remotePayload = JSON.stringify([
      api.reportProgress.mock.calls.map((call) => call[1]),
      api.reportResult.mock.calls.map((call) => call[1])
    ]);
    expect(remotePayload).not.toContain("Checking keyboard navigation");
    expect(events).toContainEqual({ kind: "item.completed.reasoning", text: "Checking keyboard navigation before changing focus handling." });
    expect(events).toContainEqual({ kind: "item.completed.reasoning", text: "No reasoning summary provided" });
    expect(remotePayload).not.toContain("LOCAL_PREPARED_INPUT");
    expect(api.reportResult.mock.calls[0]?.[1].input_revision).toBe(3);
    expect(events.filter((event) => event.steering_id === "local-1").map((event) => event.kind)).toEqual(["steering.runtime_received", "steering.response_observed"]);
    expect(events.some((event) => event.text === "private terminal output")).toBe(true);
    expect(JSON.stringify(api.reportProgress.mock.calls)).not.toContain("private terminal output");
    expect(JSON.stringify(events)).not.toContain("private handoff");
    expect(mailbox.enqueueLocal("late", "Too late")).toBe(false);
  });
});
