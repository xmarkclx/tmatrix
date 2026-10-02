import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupAdapter } from "../src/adapter-loader.js";
import codexAdapter from "../src/adapters/codex.js";
import type { AppServerCodexOptions } from "../src/app-server-codex.js";
import { nullLogger } from "../src/logger.js";
import { makeTicket } from "./helpers.js";

const mocks = vi.hoisted(() => ({
  manager: vi.fn(),
  runtime: vi.fn(),
  bundled: vi.fn()
}));
vi.mock("../src/codex-update-manager.js", () => ({ CodexUpdateManager: mocks.manager }));
vi.mock("../src/app-server-codex.js", () => ({
  AppServerCodex: mocks.runtime,
  resolveBundledCodexInstallation: mocks.bundled
}));

const bundled = { version: "0.1.0", directory: "/fixture/bundle", executablePath: "/fixture/bundle/codex" };
const context = {
  updateDirectory: "/fixture/private/codex",
  environment: { OPENAI_API_KEY: "fictional-provider-auth", CODEX_HOME: "/fixture/auth" },
  logger: nullLogger()
};

function manager() {
  return {
    displayName: "Codex CLI",
    initialize: vi.fn(async () => {}),
    acquire: vi.fn(() => ({ executablePath: "/fixture/version-one/codex", release: vi.fn() })),
    snapshot: vi.fn(() => ({ status: "idle" as const, current_version: "0.1.0" })),
    start: vi.fn(),
    close: vi.fn(async () => {}),
    checkNow: vi.fn(async () => {})
  };
}

beforeEach(() => {
  mocks.manager.mockReset();
  mocks.runtime.mockReset();
  mocks.bundled.mockReset().mockReturnValue(bundled);
  mocks.runtime.mockImplementation(function (_options: AppServerCodexOptions) {
    return { startThread: vi.fn(), close: vi.fn(async () => {}) };
  });
});

describe("Codex adapter update ownership", () => {
  it("initializes its own updater and pins each worker using its fresh context", async () => {
    const updates = manager();
    const firstRelease = vi.fn();
    const secondRelease = vi.fn();
    updates.acquire
      .mockReturnValueOnce({ executablePath: "/fixture/version-one/codex", release: firstRelease })
      .mockReturnValueOnce({ executablePath: "/fixture/version-two/codex", release: secondRelease });
    mocks.manager.mockImplementation(function () { return updates; });

    const prepared = await setupAdapter(codexAdapter, context);
    expect(mocks.manager).toHaveBeenCalledWith({
      directory: context.updateDirectory,
      bundled,
      environment: context.environment
    });
    expect(updates.initialize).toHaveBeenCalledOnce();
    expect(updates.start).not.toHaveBeenCalled();
    expect(updates.acquire).not.toHaveBeenCalled();

    const first = prepared.runtimeFactory(makeTicket(), { TMATRIX_CONVERSATION_LEASE: "first-worker" });
    const second = prepared.runtimeFactory(makeTicket(), { TMATRIX_CONVERSATION_LEASE: "second-worker" });
    expect(mocks.runtime).toHaveBeenNthCalledWith(1, {
      environment: { ...context.environment, TMATRIX_CONVERSATION_LEASE: "first-worker" },
      logger: context.logger,
      executablePath: "/fixture/version-one/codex"
    });
    expect(mocks.runtime).toHaveBeenNthCalledWith(2, {
      environment: { ...context.environment, TMATRIX_CONVERSATION_LEASE: "second-worker" },
      logger: context.logger,
      executablePath: "/fixture/version-two/codex"
    });
    expect(mocks.runtime.mock.calls[0]![0].environment).not.toBe(mocks.runtime.mock.calls[1]![0].environment);
    expect(context.environment).not.toHaveProperty("TMATRIX_CONVERSATION_LEASE");
    expect(firstRelease).not.toHaveBeenCalled();
    expect(secondRelease).not.toHaveBeenCalled();
    await first.close!();
    expect(firstRelease).toHaveBeenCalledOnce();
    expect(secondRelease).not.toHaveBeenCalled();
    await second.close!();
    expect(secondRelease).toHaveBeenCalledOnce();
  });

  it("retains the acquired version when runtime teardown is uncertain", async () => {
    const updates = manager();
    const release = vi.fn();
    updates.acquire.mockReturnValue({ executablePath: "/fixture/pinned/codex", release });
    mocks.manager.mockImplementation(function () { return updates; });
    const close = vi.fn().mockRejectedValueOnce(new Error("exit unverified")).mockResolvedValueOnce(undefined);
    const runtime = { startThread: vi.fn(), close };
    mocks.runtime.mockImplementation(function () { return runtime; });

    const prepared = await codexAdapter.setup(context);
    const worker = prepared.create(context);
    await expect(worker.close()).rejects.toThrow("exit unverified");
    expect(release).not.toHaveBeenCalled();
    await worker.close();
    expect(release).toHaveBeenCalledOnce();
    expect(close.mock.contexts).toEqual([runtime, runtime]);
  });

  it("releases the pin if runtime construction fails before execution", async () => {
    const updates = manager();
    const release = vi.fn();
    updates.acquire.mockReturnValue({ executablePath: "/fixture/pinned/codex", release });
    mocks.manager.mockImplementation(function () { return updates; });
    mocks.runtime.mockImplementation(function () { throw new Error("construction failed"); });

    const prepared = await codexAdapter.setup(context);
    expect(() => prepared.create(context)).toThrow("construction failed");
    expect(release).toHaveBeenCalledOnce();
  });

  it("cleans up a partially initialized updater before falling back to the bundled runtime", async () => {
    const updates = manager();
    updates.initialize.mockRejectedValue(new Error("private initialization details"));
    mocks.manager.mockImplementation(function () { return updates; });

    const prepared = await setupAdapter(codexAdapter, context);
    expect(updates.close).toHaveBeenCalledOnce();
    expect(prepared.updates).toBeUndefined();
    const worker = prepared.runtimeFactory(makeTicket());
    expect(mocks.runtime).toHaveBeenCalledWith({ environment: context.environment, logger: context.logger });
    expect(updates.acquire).not.toHaveBeenCalled();
    await worker.close!();
  });

  it("keeps the original create contract independent of updater setup", async () => {
    const worker = codexAdapter.create(context);
    expect(mocks.runtime).toHaveBeenCalledWith({ environment: context.environment, logger: context.logger });
    expect(mocks.manager).not.toHaveBeenCalled();
    expect(mocks.bundled).not.toHaveBeenCalled();
    await worker.close();
  });
});
