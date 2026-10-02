import { AppServerCodex, resolveBundledCodexInstallation } from "./app-server.js";
import { CodexUpdateManager, type CodexExecutableLease } from "./update-manager.js";
import type { AdapterContext, RuntimeAdapter, RuntimeCreator } from "../../runtime-adapter.js";

function createCodex(context: AdapterContext, lease?: CodexExecutableLease): ReturnType<RuntimeCreator> {
  try {
    const runtime = new AppServerCodex({
      environment: context.environment,
      logger: context.logger,
      ...(lease ? { executablePath: lease.executablePath } : {})
    });
    if (lease) {
      const close = runtime.close.bind(runtime);
      runtime.close = async () => {
        await close();
        // Only confirmed teardown releases the version. Cancellation is not a receipt.
        lease.release();
      };
    }
    return runtime;
  } catch (error) {
    // Construction cannot start execution; a failed constructor has no runtime to retain.
    lease?.release();
    throw error;
  }
}

/** The provider owns update policy, verification and per-worker version selection. */
export default {
  apiVersion: 1,
  id: "codex",
  create: (context) => createCodex(context),
  async setup(context) {
    const updates = new CodexUpdateManager({
      directory: context.updateDirectory,
      bundled: resolveBundledCodexInstallation(),
      environment: context.environment
    });
    try {
      await updates.initialize();
      return {
        updates,
        create: (workerContext) => createCodex(workerContext, updates.acquire())
      };
    } catch (error) {
      await updates.close();
      throw error;
    }
  }
} satisfies RuntimeAdapter;
