import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
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

export function createRuntimeFactory(adapter: RuntimeAdapter, context: AdapterContext): RuntimeFactory {
  return (profile) => {
    const runtime = adapter.create({ ...context, environment: { ...context.environment } }, { ...profile });
    if (!runtime || typeof runtime.startThread !== "function" || typeof runtime.close !== "function" ||
        (runtime.resumeThread !== undefined && typeof runtime.resumeThread !== "function")) {
      throw new Error("Adapter create must return a runtime with startThread and close methods");
    }
    return runtime;
  };
}
