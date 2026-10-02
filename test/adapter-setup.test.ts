import { describe, expect, it, vi } from "vitest";
import { setupAdapter } from "../src/adapter-loader.js";
import { resolveAdapterUpdateDirectory } from "../src/adapter-updates.js";
import { nullLogger } from "../src/logger.js";
import type {
  AdapterContext, AdapterReviewRequest, AdapterSetupContext, AdapterUpdates, AdapterUpdateState, RuntimeAdapter, RuntimeCreator
} from "../src/runtime-adapter.js";
import { deferred, makeTicket } from "./helpers.js";

const context: AdapterSetupContext = {
  environment: { PATH: "/bin" }, logger: nullLogger(), updateDirectory: "/fictional/echo-updates"
};
const create: RuntimeCreator = () => ({
  startThread() { throw new Error("unused"); }, async close() {}
});
function updates(overrides: Partial<AdapterUpdates> = {}): AdapterUpdates {
  return {
    displayName: "Echo CLI",
    snapshot: () => ({ status: "idle", current_version: "1.0.0" }),
    start() {}, async close() {}, async checkNow() {},
    ...overrides
  };
}

describe("adapter-owned runtime setup", () => {
  it("binds prepared reviews and isolates their environment/profile from workers", async () => {
    const request: AdapterReviewRequest = { instructions: "fixed", input: "material", profile: makeTicket(), outputSchema: {} };
    const fallback = vi.fn();
    const environments: Record<string, string>[] = [];
    const prepared = {
      label: "prepared", create,
      async review(reviewContext: AdapterContext, reviewRequest: AdapterReviewRequest) {
        expect(this.label).toBe("prepared");
        expect(reviewContext.environment.PATH).toBe("/bin");
        environments.push(reviewContext.environment);
        reviewContext.environment.PATH = "/mutated";
        // Even a module that casts away readonly cannot mutate the worker's profile.
        (reviewRequest.profile as { model: string }).model = "changed";
        return { category: "none" };
      }
    };
    const setup = await setupAdapter({ apiVersion: 1, id: "echo", create, review: fallback, setup: () => prepared }, context);
    await expect(setup.review!(request)).resolves.toEqual({ category: "none" });
    await setup.review!(request);
    expect(fallback).not.toHaveBeenCalled();
    expect(environments[0]).not.toBe(environments[1]);
    expect(context.environment.PATH).toBe("/bin");
    expect(request.profile.model).toBe(makeTicket().model);
  });

  it("retains the adapter review when optional setup fails or omits it", async () => {
    const request: AdapterReviewRequest = { instructions: "fixed", input: "material", profile: makeTicket(), outputSchema: {} };
    for (const fails of [false, true]) {
      const adapter = {
        apiVersion: 1 as const, id: "echo", label: "default", create,
        async review() { expect(this.label).toBe("default"); return { category: "none" }; },
        setup() { if (fails) throw new Error("private"); return { create }; },
      };
      await expect((await setupAdapter(adapter, context)).review!(request)).resolves.toEqual({ category: "none" });
    }
  });

  it("keeps existing API v1 adapters working without an updater", async () => {
    const original = vi.fn(create);
    const setup = await setupAdapter({ apiVersion: 1, id: "echo", create: original }, context);
    expect(setup.updates).toBeUndefined();
    expect(setup.review).toBeUndefined();
    const runtime = setup.runtimeFactory(makeTicket());
    expect(original).toHaveBeenCalledOnce();
    await runtime.close?.();
  });

  it("uses a non-Codex adapter's setup factory and keeps each worker's selected version", async () => {
    let version = "1.0.0";
    const selected: string[] = [];
    const environments: Record<string, string>[] = [];
    const fallback = vi.fn(create);
    const setupHook = vi.fn((setupContext: AdapterSetupContext) => {
      expect(setupContext.updateDirectory).toBe(context.updateDirectory);
      setupContext.environment.PATH = "/adapter/bin";
      return {
        create(workerContext: Parameters<RuntimeCreator>[0]) {
          const pinnedVersion = version;
          environments.push(workerContext.environment);
          return {
            startThread() {
              selected.push(pinnedVersion);
              throw new Error("version observed");
            },
            async close() {}
          };
        },
        updates: updates({ async checkNow() { version = "2.0.0"; } })
      };
    });
    const setup = await setupAdapter({ apiVersion: 1, id: "echo", create: fallback, setup: setupHook }, context);
    const first = setup.runtimeFactory(makeTicket(), { TMATRIX_CONVERSATION_LEASE: "first" });
    await setup.updates!.checkNow();
    const second = setup.runtimeFactory(makeTicket(), { TMATRIX_CONVERSATION_LEASE: "second" });
    expect(() => first.startThread({} as never)).toThrow("version observed");
    expect(() => second.startThread({} as never)).toThrow("version observed");
    expect(selected).toEqual(["1.0.0", "2.0.0"]);
    expect(setupHook).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
    expect(environments.map(env => env.TMATRIX_CONVERSATION_LEASE)).toEqual(["first", "second"]);
    expect(environments[0]).not.toBe(environments[1]);
    expect(context.environment).toEqual({ PATH: "/bin" });
    expect(setup.updates!.snapshot()).toMatchObject({ adapter_id: "echo", display_name: "Echo CLI" });
    await first.close?.();
    await second.close?.();
  });

  it("preserves the adapter's pin until worker teardown is confirmed", async () => {
    let stopped = false;
    const release = vi.fn();
    const setup = await setupAdapter({
      apiVersion: 1, id: "echo", create,
      setup: () => ({ create: () => ({
        startThread() { throw new Error("unused"); },
        async close() {
          if (!stopped) throw new Error("execution may still exist");
          release();
        }
      }) })
    }, context);
    const worker = setup.runtimeFactory(makeTicket());
    await expect(worker.close!()).rejects.toThrow("execution may still exist");
    expect(release).not.toHaveBeenCalled();
    stopped = true;
    await worker.close!();
    expect(release).toHaveBeenCalledOnce();
  });

  it("contains setup failure and keeps the adapter's original runtime available", async () => {
    const original = vi.fn(create);
    const warning = vi.fn();
    const setup = await setupAdapter({
      apiVersion: 1, id: "echo", create: original,
      async setup() { throw new Error("private setup diagnostic"); }
    }, { ...context, logger: { warn: warning, error: vi.fn() } });
    expect(setup.updates).toBeUndefined();
    const worker = setup.runtimeFactory(makeTicket());
    expect(original).toHaveBeenCalledOnce();
    expect(JSON.stringify(warning.mock.calls)).not.toContain("private setup diagnostic");
    await worker.close?.();
  });

  it("closes an updater from an invalid setup result before falling back", async () => {
    const close = vi.fn(async () => {});
    const adapter = {
      apiVersion: 1, id: "echo", create,
      setup: () => ({ create: null, updates: updates({ close }) })
    } as unknown as RuntimeAdapter;
    const setup = await setupAdapter(adapter, context);
    expect(close).toHaveBeenCalledOnce();
    expect(setup.updates).toBeUndefined();
    await setup.runtimeFactory(makeTicket()).close?.();
  });

  it.each(["start", "checkNow", "close"] as const)("contains a rejected %s operation and hides its diagnostic", async operation => {
    const raw = updates({ [operation]: async () => { throw new Error("private lifecycle diagnostic"); } });
    const setup = await setupAdapter({ apiVersion: 1, id: "echo", create, setup: () => ({ create, updates: raw }) }, context);
    await expect(Promise.resolve(setup.updates![operation]())).resolves.toBeUndefined();
    await vi.waitFor(() => expect(setup.updates!.snapshot().status).toBe("failed"));
    const snapshot = setup.updates!.snapshot();
    expect(snapshot.current_version).toBe("1.0.0");
    expect(snapshot.error).toBeTruthy();
    expect(JSON.stringify(snapshot)).not.toContain("private lifecycle diagnostic");
    await setup.runtimeFactory(makeTicket()).close?.();
  });

  it("contains a synchronous startup exception", async () => {
    const setup = await setupAdapter({
      apiVersion: 1, id: "echo", create,
      setup: () => ({ create, updates: updates({ start() { throw new Error("private startup diagnostic"); } }) })
    }, context);
    expect(() => setup.updates!.start()).not.toThrow();
    await vi.waitFor(() => expect(setup.updates!.snapshot().status).toBe("failed"));
    expect(JSON.stringify(setup.updates!.snapshot())).not.toContain("private startup diagnostic");
  });

  it("admits workers while the adapter's initial update check is pending", async () => {
    const pending = deferred<void>();
    const original = vi.fn(create);
    const setup = await setupAdapter({
      apiVersion: 1, id: "echo", create,
      setup: () => ({ create: original, updates: updates({ start: () => pending.promise }) })
    }, context);
    expect(setup.updates!.start()).toBeUndefined();
    const worker = setup.runtimeFactory(makeTicket());
    expect(original).toHaveBeenCalledOnce();
    pending.resolve();
    await worker.close?.();
  });

  it("keeps the last known version when status lookup fails", async () => {
    let unavailable = false;
    const setup = await setupAdapter({
      apiVersion: 1, id: "echo", create,
      setup: () => ({ create, updates: updates({ snapshot() {
        if (unavailable) throw new Error("private status diagnostic");
        return { status: "idle", current_version: "2.0.0" };
      } }) })
    }, context);
    expect(setup.updates!.snapshot().current_version).toBe("2.0.0");
    unavailable = true;
    expect(setup.updates!.snapshot()).toMatchObject({ status: "disabled", current_version: "2.0.0", can_rollback: false });
    expect(JSON.stringify(setup.updates!.snapshot())).not.toContain("private status diagnostic");
    await setup.runtimeFactory(makeTicket()).close?.();
  });

  it("advertises rollback only when the adapter supports and enables it", async () => {
    let state: AdapterUpdateState = { status: "idle", current_version: "2.0.0", can_rollback: true };
    const noRollback = await setupAdapter({
      apiVersion: 1, id: "echo", create,
      setup: () => ({ create, updates: updates({ snapshot: () => state }) })
    }, context);
    expect(noRollback.updates!.rollback).toBeUndefined();
    expect(noRollback.updates!.snapshot().can_rollback).toBe(false);
    const rollback = vi.fn(async () => {});
    const supported = await setupAdapter({
      apiVersion: 1, id: "echo", create,
      setup: () => ({ create, updates: updates({ snapshot: () => state, rollback }) })
    }, context);
    expect(supported.updates!.snapshot().can_rollback).toBe(true);
    await supported.updates!.rollback!();
    expect(rollback).toHaveBeenCalledOnce();
    state = { status: "disabled", current_version: "2.0.0", can_rollback: true };
    expect(supported.updates!.snapshot().can_rollback).toBe(false);
  });

  it("exports only the public update status fields", async () => {
    const setup = await setupAdapter({
      apiVersion: 1, id: "echo", create,
      setup: () => ({ create, updates: updates({ snapshot: () => ({
        status: "idle", current_version: "1.0.0", runtime_output: "private provider diagnostic",
        adapter_id: "wrong", display_name: "wrong"
      }) }) })
    }, context);
    expect(setup.updates!.snapshot()).toEqual({
      status: "idle", current_version: "1.0.0", can_rollback: false,
      adapter_id: "echo", display_name: "Echo CLI"
    });
  });

  it("binds setup and updater methods to their owning objects", async () => {
    const provider = {
      displayName: "Echo CLI", version: "1.0.0",
      snapshot(): AdapterUpdateState { return { status: "idle", current_version: this.version }; },
      start() { this.version = "1.1.0"; },
      async checkNow() { this.version = "2.0.0"; },
      async close() { this.version = "closed"; }
    };
    const prepared = {
      version: "ready",
      create() {
        expect(this.version).toBe("ready");
        return create(context, makeTicket());
      },
      updates: provider
    };
    const setup = await setupAdapter({ apiVersion: 1, id: "echo", create, setup: () => prepared }, context);
    setup.updates!.start();
    await vi.waitFor(() => expect(setup.updates!.snapshot().current_version).toBe("1.1.0"));
    await setup.updates!.checkNow();
    expect(setup.updates!.snapshot().current_version).toBe("2.0.0");
    await setup.runtimeFactory(makeTicket()).close?.();
    await setup.updates!.close();
    expect(provider.version).toBe("closed");
  });
});

describe("adapter update storage", () => {
  it("keeps the existing Codex store and isolates other adapter identities", () => {
    const environment = { TMATRIX_CONTROL_FILE: "/fictional/instance/control.json" };
    expect(resolveAdapterUpdateDirectory("codex", "https://example.test", "instance", environment)).toBe("/fictional/instance/codex");
    expect(resolveAdapterUpdateDirectory("echo", "https://example.test", "instance", environment)).toBe("/fictional/instance/echo");
  });

  it("isolates standalone stores by provider, poll origin and instance", () => {
    const directory = (adapter: string, origin = "https://example.test", instance = "one") =>
      resolveAdapterUpdateDirectory(adapter, origin, instance, { XDG_STATE_HOME: "/fictional/state" });
    expect(directory("echo")).toMatch(/^\/fictional\/state\/tmatrix\/echo\/[0-9a-f]+$/);
    expect(new Set([
      directory("codex"), directory("echo"), directory("echo", "https://another.example.test"),
      directory("echo", "https://example.test", "two")
    ]).size).toBe(4);
  });
});
