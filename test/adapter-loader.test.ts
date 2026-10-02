import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAdapter, createRuntimeFactory } from "../src/adapter-loader.js";
import { AppServerCodex } from "../src/adapters/codex/app-server.js";
import { sanitizedCodexEnvironment } from "../src/adapters/codex/environment.js";
import { nullLogger } from "../src/logger.js";
import { RunCancellationError } from "../src/errors.js";
import { Metrics } from "../src/metrics.js";
import { TicketRunner } from "../src/runner.js";
import { ConversationStore } from "../src/conversation-store.js";
import type { RuntimeAdapter } from "../src/runtime-adapter.js";
import { makeTicket } from "./helpers.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const context = { environment: sanitizedCodexEnvironment({ API_KEY: "queue-secret", PATH: "/bin" }), logger: nullLogger() };
async function moduleFile(source: string) {
  const directory = await mkdtemp(join(tmpdir(), "tmatrix-adapter-test-"));
  directories.push(directory);
  const path = join(directory, "adapter.mjs");
  await writeFile(path, source);
  return path;
}

describe("runtime adapters", () => {
  it("ships Codex using the same contract and creates isolated clients", async () => {
    const adapter = await loadAdapter("codex");
    const factory = createRuntimeFactory(adapter, context);
    const first = factory(makeTicket());
    const second = factory(makeTicket());
    expect(first).toBeInstanceOf(AppServerCodex);
    expect(first).not.toBe(second);
    await first.close?.();
    await second.close?.();
  });

  it.each([
    ['export default {apiVersion: 2, id: "custom", create() {}}'],
    ['export default {apiVersion: 1, id: "wrong", create() {}}'],
    ['export default {apiVersion: 1, id: "custom"}'],
    ['export default {apiVersion: 1, id: "custom", create() {}, setup: true}'],
    ['throw new Error("private-module-source");']
  ])("rejects invalid extensions without leaking module errors", async (source) => {
    await expect(loadAdapter("custom", await moduleFile(source))).rejects.toThrow(/Runtime adapter|Unable to load/);
  });

  it("rejects missing, relative and remote modules and bundled overrides", async () => {
    for (const path of [undefined, "relative.mjs", "https://example.test/adapter.mjs"]) {
      await expect(loadAdapter("custom", path)).rejects.toThrow("absolute");
    }
    await expect(loadAdapter("codex", "/tmp/override.mjs")).rejects.toThrow("cannot be overridden");
  });

  it("passes a fresh sanitized environment and requires confirmed teardown", () => {
    const adapter: RuntimeAdapter = {
      apiVersion: 1, id: "custom", create({ environment }) {
        expect(environment.API_KEY).toBeUndefined();
        expect(environment.PATH).toBe("/bin");
        environment.PATH = "changed";
        return { startThread() { throw new Error("unused"); }, async close() {} };
      }
    };
    const factory = createRuntimeFactory(adapter, context);
    factory(makeTicket()); factory(makeTicket());
    const invalid = { ...adapter, create: () => ({ startThread() {} }) } as unknown as RuntimeAdapter;
    expect(() => createRuntimeFactory(invalid, context)(makeTicket())).toThrow("close");
  });

  it("passes each run's lease tag without mutating the shared environment", () => {
    const environments: Record<string, string>[] = [];
    const adapter: RuntimeAdapter = { apiVersion: 1, id: "custom", create({ environment }) {
      environments.push(environment);
      return { startThread() { throw new Error("unused"); }, async close() {} };
    } };
    const factory = createRuntimeFactory(adapter, context);
    factory(makeTicket(), { TMATRIX_CONVERSATION_LEASE: "first" });
    factory(makeTicket(), { TMATRIX_CONVERSATION_LEASE: "second" });
    expect(environments.map(env => env.TMATRIX_CONVERSATION_LEASE)).toEqual(["first", "second"]);
    expect(context.environment.TMATRIX_CONVERSATION_LEASE).toBeUndefined();
  });

  it("runs an installed module through the real ticket runner and closes it", async () => {
    const adapter = await loadAdapter("echo", resolve("examples/echo-adapter.mjs"));
    const factory = createRuntimeFactory(adapter, context);
    const runtime = factory(makeTicket({ model: "provider/custom-model" }));
    const close = vi.spyOn(runtime, "close");
    const api = {
      markTaken: vi.fn(async () => undefined), getHistory: vi.fn(async () => ({})),
      reportProgress: vi.fn(async () => undefined), reportResult: vi.fn(async () => undefined)
    };
    const runner = new TicketRunner({ runtimeFactory: () => runtime, api, logger: nullLogger(), metrics: new Metrics() });
    expect(await runner.run(makeTicket({ model: "provider/custom-model" }), { runId: "extension-run", recovered: false })).toEqual({ status: "completed" });
    expect(api.reportResult).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      outcome: "AI_NEEDS_FEEDBACK", user_message: expect.stringContaining("provider/custom-model")
    }), expect.anything());
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([false, true])("confirms cancellation only after extension teardown (failure=%s)", async (failClose) => {
    const path = await moduleFile(`export default {
      apiVersion: 1, id: "custom",
      create() { return {
        startThread() { return { async runStreamed(input, {signal}) { return {
          events: (async function* () { yield {type: "turn.started"}; signal.throwIfAborted(); })()
        }; } }; },
        async close() { ${failClose ? 'throw new Error("teardown uncertain")' : ''} }
      }; }
    };`);
    const factory = createRuntimeFactory(await loadAdapter("custom", path), context);
    const controller = new AbortController();
    const api = {
      markTaken: vi.fn(async () => undefined), getHistory: vi.fn(async () => ({})),
      reportProgress: vi.fn(async () => undefined), reportResult: vi.fn(async () => undefined)
    };
    const runner = new TicketRunner({ runtimeFactory: factory, api, logger: nullLogger(), metrics: new Metrics() });
    const result = runner.run(makeTicket(), {
      runId: "cancel-extension", recovered: false, signal: controller.signal,
      observe(event) { if (event.kind === "turn.started") controller.abort(new RunCancellationError({ kind: "user", ticketId: "T-1001", workerId: "w-1001" })); }
    });
    if (failClose) {
      await expect(result).rejects.toThrow("teardown failed");
    } else {
      await expect(result).resolves.toEqual({ status: "cancelled" });
    }
    expect(api.reportResult).not.toHaveBeenCalled();
  });

  it("isolates adapter routes and signed references but shares task locks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tmatrix-adapter-routes-"));
    directories.push(directory);
    const settings = { directory, namespace: "https://example.test", referenceKey: "fictional-test-key" };
    const codex = new ConversationStore(settings);
    const custom = new ConversationStore({ ...settings, adapterId: "custom" });
    const ticket = makeTicket({ task_id: "shared-task" });
    await codex.remember(ticket, "codex-thread");
    const summary = codex.attachContext(ticket, "codex-thread", "Continuation");
    expect(await custom.resolve(ticket, { inherited_context: { content: summary, sourceCommentId: "comment" } })).toBeUndefined();
    await custom.remember(ticket, "custom-thread");
    expect(await codex.resolve(ticket, {})).toBe("codex-thread");
    expect(await custom.resolve(ticket, {})).toBe("custom-thread");
    const release = await codex.acquire(ticket);
    const controller = new AbortController();
    const waiting = custom.acquire(ticket, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow();
    await release();
    await (await custom.acquire(ticket))();
  });
});
