import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { WorkerError } from "../../errors.js";
import { accountFileExists } from "../../runtime-accounts.js";
import type { AdapterContext, RuntimeAdapter } from "../../runtime-adapter.js";
import { hostExecutableCandidates } from "../host-executable.js";
import { readGeminiQuota } from "./quota.js";
import { createGeminiRuntime } from "./runtime.js";

function geminiExecutable(environment: Record<string, string>): string | undefined {
  const name = process.platform === "win32" ? "agy.exe" : "agy";
  for (const candidate of hostExecutableCandidates(environment, name, environment.TMATRIX_AGY_PATH)) {
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { continue; }
  }
}

function create(context: AdapterContext) {
  const executable = geminiExecutable(context.environment);
  if (executable) return createGeminiRuntime(context, executable);
  throw new WorkerError({
    code: "GEMINI_INSTALL_REQUIRED",
    stage: "runtime.route",
    message: "Install Antigravity CLI (agy) for the worker account, or set TMATRIX_AGY_PATH to the absolute path to its executable."
  });
}

const geminiHome = (environment: Record<string, string>) =>
  resolve(environment.HOME || homedir(), ".gemini", "antigravity-cli");
const loggedIn = (environment: Record<string, string>) =>
  accountFileExists(resolve(geminiHome(environment), "antigravity-oauth-token"));

export default {
  apiVersion: 1,
  id: "gemini",
  accounts: {
    environment(directory, base) {
      const executable = geminiExecutable(base);
      const environment: Record<string, string> = { ...base, HOME: directory, AGY_CLI_FORCE_FILE_TOKEN_STORAGE: "1",
        ...(process.platform === "win32" ? { USERPROFILE: directory } : {}),
        ...(executable ? { TMATRIX_AGY_PATH: executable } : {}) };
      for (const key of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "AGY_LLM_GATEWAY_API_KEY", "AGY_ADC_AUTH",
        "GOOGLE_APPLICATION_CREDENTIALS", "AGY_ACCOUNT"]) delete environment[key];
      return environment;
    },
    home: geminiHome,
    login: environment => ({ executable: geminiExecutable(environment) ?? "agy", args: [] }),
    loggedIn
  },
  create,
  setup(context) {
    return {
      create,
      async readQuota(signal, _cwd, _model, accountEnvironment) {
        signal?.throwIfAborted();
        if (accountEnvironment && !await loggedIn(accountEnvironment)) return { plan: "unavailable", authenticated: false };
        const environment = accountEnvironment ?? context.environment;
        const executable = geminiExecutable(environment);
        return executable ? readGeminiQuota(executable, environment, signal) : { plan: "unknown" };
      }
    };
  }
} satisfies RuntimeAdapter;
