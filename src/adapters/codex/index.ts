import { homedir } from "node:os";
import { resolve } from "node:path";
import { accountFileExists } from "../../runtime-accounts.js";
import { AppServerCodex, resolveBundledCodexInstallation, resolveBundledCodexPath } from "./app-server.js";
import { readCodexQuota } from "./quota.js";
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
  accounts: {
    environment(directory, base) {
      const environment: Record<string, string> = { ...base, CODEX_HOME: directory };
      for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"]) delete environment[key];
      return environment;
    },
    home: environment => environment.CODEX_HOME ?? resolve(homedir(), ".codex"),
    login() {
      const executable = resolveBundledCodexPath();
      const args = ["login"];
      return /\.[cm]?js$/i.test(executable) ? { executable: process.execPath, args: [executable, ...args] } : { executable, args };
    },
    loggedIn: environment => accountFileExists(resolve(environment.CODEX_HOME ?? resolve(homedir(), ".codex"), "auth.json"))
  },
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
        create: (workerContext) => createCodex(workerContext, updates.acquire()),
        async readQuota(signal, workingDirectory, _model, environment) {
          const lease = updates.acquire();
          const runtime = new AppServerCodex({ environment: environment ?? context.environment, executablePath: lease.executablePath });
          try {
            return await readCodexQuota(runtime, signal, workingDirectory);
          } finally {
            await runtime.close();
            lease.release();
          }
        }
      };
    } catch (error) {
      await updates.close();
      throw error;
    }
  }
} satisfies RuntimeAdapter;
