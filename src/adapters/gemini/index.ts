import { accessSync, constants, statSync } from "node:fs";
import { WorkerError } from "../../errors.js";
import type { RuntimeAdapter } from "../../runtime-adapter.js";
import { hostExecutableCandidates } from "../host-executable.js";
import { createGeminiRuntime } from "./runtime.js";

function geminiExecutable(environment: Record<string, string>): string {
  const name = process.platform === "win32" ? "agy.exe" : "agy";
  for (const candidate of hostExecutableCandidates(environment, name, environment.TMATRIX_AGY_PATH)) {
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { continue; }
  }
  throw new WorkerError({
    code: "GEMINI_INSTALL_REQUIRED",
    stage: "runtime.route",
    message: "Install Antigravity CLI (agy) for the worker account, or set TMATRIX_AGY_PATH to the absolute path to its executable."
  });
}

export default {
  apiVersion: 1,
  id: "gemini",
  create: context => createGeminiRuntime(context, geminiExecutable(context.environment))
} satisfies RuntimeAdapter;
