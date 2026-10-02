import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import type { AppServerCodexOptions } from "../src/adapters/codex/app-server.js";
import { createCodexFactory } from "../src/adapters/codex/factory.js";
import type { CodexLike } from "../src/runner.js";
import type { ExecutionProfile } from "../src/types.js";

const codex = {
  startThread() {
    throw new Error("not used");
  }
} satisfies CodexLike;

describe("createCodexFactory", () => {
  it.each([
    ["FAST", "low", "priority"],
    ["NORMAL", "medium", "default"],
    ["HIGH", "ultra", "default"]
  ] as const)(
    "creates a fresh App Server client for the %s %s/%s profile",
    (executionMode, reasoningEffort, serviceTier) => {
      const createCodex = vi.fn((_options: AppServerCodexOptions) => codex);
      const logger = {
        error: vi.fn(),
        warn: vi.fn()
      } as unknown as Pick<Logger, "error" | "warn">;
      const factory = createCodexFactory(
        { OPENAI_API_KEY: "test-openai-key" },
        createCodex,
        logger
      );
      const profile: ExecutionProfile = {
        execution_mode: executionMode,
        model: "gpt-5.6-sol",
        reasoning_effort: reasoningEffort,
        service_tier: serviceTier
      };

      expect(factory(profile)).toBe(codex);
      expect(createCodex).toHaveBeenCalledWith({
        environment: { OPENAI_API_KEY: "test-openai-key" },
        logger
      });
    }
  );
});
