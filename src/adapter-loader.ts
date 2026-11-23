import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { AdapterUpdateService } from "./adapter-updates.js";
import type { AdapterContext, AdapterSetup, AdapterSetupContext, ReadRuntimeQuota, RuntimeAdapter, RuntimeFactory } from "./runtime-adapter.js";

const bundledAdapters = new Map<string, () => Promise<{ default: RuntimeAdapter }>>([
  ["codex", () => import("./adapters/codex/index.js")],
  ["claude", () => import("./adapters/claude/index.js")]
]);

export const adapterIdPattern = /^[a-z][a-z0-9-]{0,63}$/;

/** Explicit local modules only: no network imports or implicit package installs. */
export async function loadAdapter(id: string, modulePath?: string): Promise<RuntimeAdapter> {
  if (!adapterIdPattern.test(id)) throw new Error("Invalid runtime adapter ID");
  const bundled = bundledAdapters.get(id);
  if (bundled && modulePath) throw new Error(`The bundled ${id} adapter cannot be overridden`);
  if (!bundled && (!modulePath || !isAbsolute(modulePath))) {
    throw new Error("Custom adapters require an absolute adapter_module path");
  }
  let adapter: unknown;
  try {
    adapter = (bundled
      ? await bundled()
      : await import(pathToFileURL(modulePath!).href)).default;
  } catch {
    // Import errors can contain arbitrary module source or credentials.
    throw new Error("Unable to load runtime adapter; verify its module and dependencies");
  }
  if (!adapter || typeof adapter !== "object" ||
      !("apiVersion" in adapter) || adapter.apiVersion !== 1 ||
      !("id" in adapter) || adapter.id !== id ||
      !("create" in adapter) || typeof adapter.create !== "function" ||
      ("setup" in adapter && adapter.setup !== undefined && typeof adapter.setup !== "function")) {
    throw new Error("Runtime adapter must export a matching id, apiVersion 1 and create function");
  }
  return adapter as RuntimeAdapter;
}

/** Initialize the optional capability once; legacy adapters keep their original factory. */
export async function setupAdapter(adapter: RuntimeAdapter, context: AdapterSetupContext): Promise<{
  runtimeFactory: RuntimeFactory;
  updates?: AdapterUpdateService;
  readQuota?: ReadRuntimeQuota;
}> {
  const workerContext = { environment: context.environment, logger: context.logger };
  let prepared: AdapterSetup | undefined;
  if (adapter.setup) {
    try {
      prepared = await adapter.setup({ ...context, environment: { ...context.environment } });
      if (!prepared || typeof prepared.create !== "function") throw new Error("Invalid adapter setup");
      const updates = prepared.updates ? new AdapterUpdateService(adapter.id, prepared.updates, context.logger) : undefined;
      const initialized = { ...adapter, create: prepared.create.bind(prepared) };
      const readQuota = prepared.readQuota?.bind(prepared);
      return {
        runtimeFactory: createRuntimeFactory(initialized, workerContext),
        ...(updates ? { updates } : {}),
        ...(readQuota ? { readQuota } : {})
      };
    } catch {
      // Never expose arbitrary module errors; a failed optional updater must not
      // prevent the adapter's normal runtime from admitting workers.
      try { await prepared?.updates?.close?.(); } catch { /* Best-effort partial setup cleanup. */ }
      context.logger.warn({ event: "adapter.setup_failed", adapter_id: adapter.id },
        "Adapter update setup unavailable; retaining the default runtime");
    }
  }
  return { runtimeFactory: createRuntimeFactory(adapter, workerContext) };
}

export function createRuntimeFactory(adapter: RuntimeAdapter, context: AdapterContext): RuntimeFactory {
  return (profile, leaseEnvironment) => {
    const runtime = adapter.create({ ...context, environment: { ...context.environment, ...leaseEnvironment } }, { ...profile });
    if (!runtime || typeof runtime.startThread !== "function" || typeof runtime.close !== "function" ||
        (runtime.resumeThread !== undefined && typeof runtime.resumeThread !== "function")) {
      throw new Error("Adapter create must return a runtime with startThread and close methods");
    }
    return runtime;
  };
}
