import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { CodexExecutableLease } from "./codex-update-manager.js";
import type { AdapterContext, RuntimeAdapter, RuntimeFactory } from "./runtime-adapter.js";

export const adapterIdPattern = /^[a-z][a-z0-9-]{0,63}$/;

/** Explicit local modules only: no network imports or implicit package installs. */
export async function loadAdapter(id: string, modulePath?: string): Promise<RuntimeAdapter> {
  if (!adapterIdPattern.test(id)) throw new Error("Invalid runtime adapter ID");
  if (id === "codex" && modulePath) throw new Error("The bundled codex adapter cannot be overridden");
  if (id !== "codex" && (!modulePath || !isAbsolute(modulePath))) {
    throw new Error("Custom adapters require an absolute adapter_module path");
  }
  let adapter: unknown;
  try {
    adapter = (id === "codex"
      ? await import("./adapters/codex.js")
      : await import(pathToFileURL(modulePath!).href)).default;
  } catch {
    // Import errors can contain arbitrary module source or credentials.
    throw new Error("Unable to load runtime adapter; verify its module and dependencies");
  }
  if (!adapter || typeof adapter !== "object" ||
      !("apiVersion" in adapter) || adapter.apiVersion !== 1 ||
      !("id" in adapter) || adapter.id !== id ||
      !("create" in adapter) || typeof adapter.create !== "function") {
    throw new Error("Runtime adapter must export a matching id, apiVersion 1 and create function");
  }
  return adapter as RuntimeAdapter;
}

export function createRuntimeFactory(adapter: RuntimeAdapter, context: AdapterContext, acquireCodex?: () => CodexExecutableLease): RuntimeFactory {
  return (profile, leaseEnvironment) => {
    const lease = adapter.id === "codex" ? acquireCodex?.() : undefined;
    try {
      const runtime = adapter.create({
        ...context,
        ...(lease ? { codexExecutablePath: lease.executablePath } : {}),
        environment: { ...context.environment, ...leaseEnvironment }
      }, { ...profile });
      if (!runtime || typeof runtime.startThread !== "function" || typeof runtime.close !== "function" ||
          (runtime.resumeThread !== undefined && typeof runtime.resumeThread !== "function")) {
        throw new Error("Adapter create must return a runtime with startThread and close methods");
      }
      if (lease) {
        const close = runtime.close.bind(runtime);
        runtime.close = async () => {
          await close();
          // A request to stop is not evidence of exit. Failed teardown retains the durable pin.
          lease.release();
        };
      }
      return runtime;
    } catch (error) {
      // Adapter construction is synchronous and may not start execution (API v1).
      lease?.release();
      throw error;
    }
  };
}
