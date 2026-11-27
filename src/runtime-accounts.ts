import { access, lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ReadRuntimeQuota, RuntimeAdapter, RuntimeQuota } from "./runtime-adapter.js";

export const accountLabelPattern = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const defaultAccount = "default";

export interface RuntimeAccount {
  label: string;
  directory?: string;
  environment: Record<string, string>;
}

export async function scanAccounts(configDir: string, adapter: RuntimeAdapter,
  environment: Record<string, string>): Promise<RuntimeAccount[]> {
  const accounts: RuntimeAccount[] = [{ label: defaultAccount, environment }];
  const capability = adapter.accounts;
  if (!capability) return accounts;
  const registry = join(configDir, "accounts");
  const root = join(registry, adapter.id);
  const entries = await (async () => {
    if (!(await lstat(registry)).isDirectory() || !(await lstat(root)).isDirectory()) return [];
    return readdir(root, { withFileTypes: true });
  })().catch((error: unknown) => {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return [];
    throw error;
  });
  for (const label of entries.filter(entry => entry.isDirectory() && entry.name !== defaultAccount &&
    accountLabelPattern.test(entry.name)).map(entry => entry.name).sort()) {
    const directory = join(root, label);
    accounts.push({ label, directory, environment: capability.environment(directory, environment) });
  }
  return accounts;
}

export function accountFileExists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

export type AccountReading = { account: string; quota: RuntimeQuota };

export async function probeAccount(account: RuntimeAccount, probe: ReadRuntimeQuota | undefined,
  options: { signal?: AbortSignal; cwd?: string; model?: string; timeoutMs?: number } = {}): Promise<AccountReading> {
  const unknown: RuntimeQuota = { plan: "unknown" };
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), options.timeoutMs ?? 8_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  let stop: (() => void) | undefined;
  try {
    options.signal?.throwIfAborted();
    const timeout = new Promise<RuntimeQuota>(resolve => {
      stop = () => resolve(unknown);
      signal.addEventListener("abort", stop, { once: true });
    });
    const quota = await Promise.race([
      Promise.resolve().then(() => probe?.(signal, options.cwd, options.model,
        account.directory ? account.environment : undefined)).then(result => result ?? unknown, () => unknown),
      timeout
    ]);
    options.signal?.throwIfAborted();
    return { account: account.label, quota };
  } finally {
    clearTimeout(timer);
    if (stop) signal.removeEventListener("abort", stop);
  }
}
