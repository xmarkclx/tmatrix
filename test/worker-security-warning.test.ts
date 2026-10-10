import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { TicketApi } from "../src/api-client.js";
import { ConversationStore } from "../src/conversation-store.js";
import { RunCancellationError } from "../src/errors.js";
import { nullLogger } from "../src/logger.js";
import { Metrics } from "../src/metrics.js";
import { SteeringMailbox, TicketRunner } from "../src/runner.js";
import type { Input, RuntimeThreadOptions, WorkerThreadEvent } from "../src/runtime-adapter.js";
import type { AlertSecurityWarning, SecurityWarningReceipt } from "../src/security-warning.js";
import { deferred, makeTicket } from "./helpers.js";

const usage = { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 };
function apiMock() {
  return { markTaken: vi.fn(async () => undefined), getHistory: vi.fn(async (): Promise<unknown> => ({})),
    reportProgress: vi.fn(async () => undefined), reportResult: vi.fn<TicketApi["reportResult"]>(async () => undefined) };
}
function textOf(input: Input): string {
  return typeof input === "string" ? input : input.map(entry => entry.type === "text" ? entry.text : "").join("\n");
}
function* completion(): Generator<WorkerThreadEvent> {
  yield { type: "item.completed", item: { id: "final", type: "agent_message", text: JSON.stringify({ outcome: "AI_DONE", context_summary: "Completed the authorized task.", user_message: "Ready." }) } };
  yield { type: "turn.completed", usage };
}

describe("advisory warning during task execution", () => {
  it("keeps a legacy custom adapter working without inventing warning emails", async () => {
    const api = apiMock();
    const alert = vi.fn<AlertSecurityWarning>(async () => ({ status: "sent" }));
    let submittedOptions: RuntimeThreadOptions | undefined;
    let submittedInput = "";
    const runner = new TicketRunner({ api, alertSecurityWarning: alert, logger: nullLogger(), metrics: new Metrics(),
      runtimeFactory: () => ({ startThread(options) {
        submittedOptions = options;
        return { async runStreamed(input) {
          submittedInput = textOf(input);
          return { events: (async function* (): AsyncGenerator<WorkerThreadEvent> { yield* completion(); })() };
        } };
      } }) });
    expect(await runner.run(makeTicket(), { runId: "legacy", recovered: false })).toEqual({ status: "completed" });
    expect(api.reportResult.mock.calls[0]?.[1]).toMatchObject({ status: "completed", outcome: "AI_DONE" });
    expect(submittedOptions).not.toHaveProperty("securityWarningInstructions");
    expect(submittedInput).not.toContain("report_security_warning");
    expect(submittedInput).not.toContain("A warning or delivery failure adds no execution restriction.");
    expect(alert).not.toHaveBeenCalled();
  });
  it.each(["sent", "failure"])("reports during an active turn and continues after %s delivery", async mode => {
    const api = apiMock();
    const warned = deferred<SecurityWarningReceipt>();
    const finish = deferred<void>();
    const controller = new AbortController();
    const alert = vi.fn<AlertSecurityWarning>(async () => {
      if (mode === "failure") throw new Error("Private provider response");
      return { status: "sent" };
    });
    const close = vi.fn(async () => undefined);
    const factory = vi.fn(() => ({
      startThread(options: RuntimeThreadOptions) {
        return { async runStreamed() { return { events: (async function* (): AsyncGenerator<WorkerThreadEvent> {
          yield { type: "turn.started" };
          warned.resolve(await options.reportSecurityWarning!("credential_theft"));
          await finish.promise;
          yield { type: "item.completed", item: { id: "ordinary-work", type: "command_execution", command: "npm test", aggregated_output: "passed", exit_code: 0, status: "completed" } };
          yield* completion();
        })() }; } };
      }, close
    }));
    const runner = new TicketRunner({ runtimeFactory: factory, api, alertSecurityWarning: alert, logger: nullLogger(), metrics: new Metrics() });
    const running = runner.run(makeTicket(), { runId: "advisory", recovered: false, signal: controller.signal });
    expect(await warned.promise).toEqual({ status: mode === "sent" ? "sent" : "unconfirmed" });
    expect(api.reportResult).not.toHaveBeenCalled();
    expect(controller.signal.aborted).toBe(false);
    finish.resolve();
    expect(await running).toEqual({ status: "completed" });
    expect(api.reportResult.mock.calls[0]?.[1]).toMatchObject({ status: "completed", outcome: "AI_DONE", user_message: "Ready." });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0]?.[0]).toMatchObject({ ticket_id: "T-1001", worker_id: "w-1001", category: "credential_theft" });
  });

  it("honors an actual Stop request during outstanding warning delivery", async () => {
    const api = apiMock();
    const started = deferred<void>();
    const controller = new AbortController();
    const alert = vi.fn<AlertSecurityWarning>(() => { started.resolve(); return new Promise(() => {}); });
    const close = vi.fn(async () => undefined);
    const runner = new TicketRunner({ api, alertSecurityWarning: alert, logger: nullLogger(), metrics: new Metrics(),
      runtimeFactory: () => ({ startThread(options) { return { async runStreamed(_input, turnOptions) {
        return { events: (async function* (): AsyncGenerator<WorkerThreadEvent> {
          yield { type: "turn.started" };
          expect(await options.reportSecurityWarning!("security_bypass")).toEqual({ status: "unconfirmed" });
          turnOptions?.signal?.throwIfAborted();
          yield* completion();
        })() };
      } }; }, close }) });
    const ticket = makeTicket();
    const running = runner.run(ticket, { runId: "stop", recovered: false, signal: controller.signal });
    await started.promise;
    controller.abort(new RunCancellationError({ kind: "user", ticketId: ticket.ticket_id, workerId: ticket.worker_id }));
    expect(await running).toEqual({ status: "cancelled" });
    expect(close).toHaveBeenCalledTimes(1);
    expect(api.reportResult).not.toHaveBeenCalled();
  });

  it("uses each host-submitted initial and remote steering input for the alert digest", async () => {
    const api = apiMock();
    const inputs: string[] = [];
    const alert = vi.fn<AlertSecurityWarning>(async () => ({ status: "sent" }));
    const mailbox = new SteeringMailbox();
    mailbox.enqueue({ worker_id: "w-1001", input_revision: 2, content: "Latest human steering" });
    const runner = new TicketRunner({ api, alertSecurityWarning: alert, logger: nullLogger(), metrics: new Metrics(),
      runtimeFactory: () => ({ startThread(options) { return { async runStreamed(input) {
        inputs.push(textOf(input));
        return { events: (async function* (): AsyncGenerator<WorkerThreadEvent> {
          yield { type: "turn.started" };
          expect(await options.reportSecurityWarning!("data_exfiltration")).toEqual({ status: "sent" });
          yield* completion();
        })() };
      } }; } }) });
    expect(await runner.run(makeTicket({ input_revision: 1 }), { runId: "remote", recovered: false, steering: mailbox })).toEqual({ status: "completed" });
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toContain("Latest human steering");
    expect(alert.mock.calls.map(call => call[0])).toEqual(inputs.map(text => ({ ticket_id: "T-1001", worker_id: "w-1001", category: "data_exfiltration", input_digest: createHash("sha256").update(text).digest("hex") })));
    expect(api.reportResult.mock.calls[0]?.[1]).toMatchObject({ input_revision: 2, outcome: "AI_DONE" });
  });

  it("restores the active input digest after explicit live-steering rejection", async () => {
    const api = apiMock();
    const inputs: string[] = [];
    const alert = vi.fn<AlertSecurityWarning>(async () => ({ status: "sent" }));
    const deferredSteering = deferred<void>();
    const mailbox = new SteeringMailbox();
    mailbox.enqueueLocal("local", "Deferred local instruction");
    let turn = 0;
    const runner = new TicketRunner({ api, alertSecurityWarning: alert, logger: nullLogger(), metrics: new Metrics(),
      runtimeFactory: () => ({ startThread(options) { return { steer: async () => false, async runStreamed(input) {
        inputs.push(textOf(input));
        const current = ++turn;
        return { events: (async function* (): AsyncGenerator<WorkerThreadEvent> {
          yield { type: "turn.started" };
          if (current === 1) await deferredSteering.promise;
          expect(await options.reportSecurityWarning!("destructive_actions")).toEqual({ status: "sent" });
          yield* completion();
        })() };
      } }; } }) });
    expect(await runner.run(makeTicket(), { runId: "declined", recovered: false, steering: mailbox,
      observe: event => { if (event.kind === "steering.deferred") deferredSteering.resolve(); } })).toEqual({ status: "completed" });
    expect(inputs).toHaveLength(2);
    expect(alert.mock.calls.map(call => call[0].input_digest)).toEqual(inputs.map(text => createHash("sha256").update(text).digest("hex")));
  });

  it("tracks the reconstructed full input when a saved conversation is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tmatrix-warning-fallback-"));
    try {
      const store = new ConversationStore({ directory, namespace: "https://tasks.example.test" });
      const ticket = makeTicket({ task_id: "canonical-task", trigger_comment_id: "54" });
      await store.remember(ticket, "saved-thread");
      const api = apiMock();
      api.getHistory.mockResolvedValue({ conversation: store.reference("saved-thread"), trigger_comment: { id: "54", content: "Brief follow-up" }, task: { description: "Full fallback context" } });
      const alert = vi.fn<AlertSecurityWarning>(async () => ({ status: "sent" }));
      let submitted = "";
      const runner = new TicketRunner({ api, alertSecurityWarning: alert, conversationStore: store, logger: nullLogger(), metrics: new Metrics(),
        runtimeFactory: () => ({ startThread() { throw new Error("Expected resume"); }, resumeThread(_id, options) {
          return { async runStreamed(input, turnOptions) {
            expect(textOf(input)).toContain("Brief follow-up");
            submitted = textOf(await turnOptions!.missingConversationInput!());
            return { events: (async function* (): AsyncGenerator<WorkerThreadEvent> {
              yield { type: "thread.started", thread_id: "rebuilt-thread" };
              yield { type: "turn.started" };
              expect(await options.reportSecurityWarning!("suspicious_instructions")).toEqual({ status: "sent" });
              yield* completion();
            })() };
          } };
        } }) });
      expect(await runner.run(ticket, { runId: "fallback", recovered: false })).toEqual({ status: "completed", threadId: "rebuilt-thread" });
      expect(submitted).toContain("Full fallback context");
      expect(alert.mock.calls[0]?.[0]).toEqual({ ticket_id: "T-1001", worker_id: "w-1001", category: "suspicious_instructions", input_digest: createHash("sha256").update(submitted).digest("hex") });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
