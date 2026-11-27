import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { AdapterContext, RuntimeAdapter } from "../../runtime-adapter.js";
import { hostExecutableCandidates } from "../host-executable.js";
import { createClaudeRuntime } from "./runtime.js";
import { createClaudeTerminalRuntime } from "./terminal-runtime.js";
import { tmuxAvailable } from "./tmux.js";
import { readClaudeQuota } from "./quota.js";
import { ClaudeUpdateManager } from "./update-manager.js";

const executableName = process.platform === "win32" ? "claude.exe" : "claude";
const executable = (environment: Record<string, string>) => environment.TMATRIX_CLAUDE_PATH || executableName;
const loginExecutable = (environment: Record<string, string>) => environment.TMATRIX_CLAUDE_PATH
  || hostExecutableCandidates(environment, executableName, undefined).find(existsSync) || executableName;
const run = promisify(execFile);

export default {
  apiVersion: 1,
  id: "claude",
  accounts: {
    environment(directory, base) {
      const environment: Record<string, string> = {
        ...base, CLAUDE_CONFIG_DIR: directory, CLAUDE_SECURESTORAGE_CONFIG_DIR: directory
      };
      for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDECODE"]) delete environment[key];
      return environment;
    },
    home: environment => environment.CLAUDE_CONFIG_DIR || resolve(homedir(), ".claude"),
    login: environment => ({ executable: loginExecutable(environment), args: ["auth", "login"] }),
    async loggedIn(environment) {
      try {
        const { stdout } = await run(loginExecutable(environment), ["auth", "status", "--json"], {
          env: environment, timeout: 4000, maxBuffer: 8192
        });
        const status: unknown = JSON.parse(stdout);
        return !!status && typeof status === "object" && "loggedIn" in status && status.loggedIn === true;
      } catch { return false; }
    }
  },
  create: context => createClaudeRuntime(context, executable(context.environment)),
  async setup(context) {
    const updates = new ClaudeUpdateManager(context.updateDirectory, context.environment);
    await updates.initialize();
    updates.executable();
    // Headless stream-json is the default; TMATRIX_CLAUDE_TERMINAL=1 opts into interactive Claude in tmux.
    const terminal = context.environment.TMATRIX_CLAUDE_TERMINAL === "1" && await tmuxAvailable(context.environment);
    const runtimeFor = (worker: AdapterContext, executable: string) => terminal
      ? createClaudeTerminalRuntime(worker, executable) : createClaudeRuntime(worker, executable);
    return {
      updates,
      async readQuota(signal, workingDirectory, model, environment) {
        const lease = updates.acquire();
        try {
          return await readClaudeQuota(lease.executable, environment ?? context.environment, signal, workingDirectory, model);
        } finally {
          try { lease.release(); } catch { /* Quota readings remain valid after cleanup failure. */ }
        }
      },
      create(worker) {
        const lease = updates.acquire();
        const runtime = runtimeFor(worker, lease.executable);
        return {
          ...runtime,
          async close() {
            await runtime.close();
            try {
              lease.release();
            } catch {
              worker.logger.warn({ event: "claude.pin_cleanup_failed" }, "Could not remove the stopped worker's Claude Code executable link");
            }
          }
        };
      }
    };
  }
} satisfies RuntimeAdapter;
