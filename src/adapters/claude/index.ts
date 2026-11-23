import type { RuntimeAdapter } from "../../runtime-adapter.js";
import { createClaudeRuntime } from "./runtime.js";
import { ClaudeUpdateManager } from "./update-manager.js";

export default {
  apiVersion: 1,
  id: "claude",
  create: context => createClaudeRuntime(context, context.environment.TMATRIX_CLAUDE_PATH || (process.platform === "win32" ? "claude.exe" : "claude")),
  async setup(context) {
    const updates = new ClaudeUpdateManager(context.updateDirectory, context.environment);
    await updates.initialize();
    updates.executable();
    return {
      updates,
      create(worker) {
        const lease = updates.acquire();
        const runtime = createClaudeRuntime(worker, lease.executable);
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
