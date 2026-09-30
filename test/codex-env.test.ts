import { describe, expect, it } from "vitest";
import { sanitizedCodexEnvironment } from "../src/codex-env.js";

describe("sanitizedCodexEnvironment", () => {
  it("keeps Codex auth and tools while removing the task API credential", () => {
    const result = sanitizedCodexEnvironment({
      API_KEY: "task-secret",
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "private-parent-value",
      OPENAI_API_KEY: "codex-secret",
      PATH: "/usr/bin",
      UNSET: undefined
    });

    expect(result).toEqual({
      OPENAI_API_KEY: "codex-secret",
      PATH: "/usr/bin"
    });
  });
});
