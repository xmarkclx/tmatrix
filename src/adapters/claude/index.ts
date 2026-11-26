import type { RuntimeAdapter } from "../../runtime-adapter.js";
import type { AdapterContext } from "../../runtime-adapter.js";
import { createClaudeRuntime } from "./runtime.js";
import { createClaudeTerminalRuntime } from "./terminal-runtime.js";
import { tmuxAvailable } from "./tmux.js";
import { readClaudeQuota } from "./quota.js";
import { ClaudeUpdateManager } from "./update-manager.js";

export default {
  apiVersion: 1,
  id: "claude",
  create: context => createClaudeRuntime(context, context.environment.TMATRIX_CLAUDE_PATH || (process.platform === "win32" ? "claude.exe" : "claude")),
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
      async readQuota(signal, workingDirectory, model) {
        const lease = updates.acquire();
        try {
          return await readClaudeQuota(lease.executable, context.environment, signal, workingDirectory, model);
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
