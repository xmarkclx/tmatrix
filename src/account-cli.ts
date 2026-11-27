import { spawn } from "node:child_process";
import { lstat, mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { adapterIdPattern, bundledAdapterIds, loadAdapter } from "./adapter-loader.js";
import { sanitizedCodexEnvironment } from "./adapters/codex/environment.js";
import { accountLabelPattern, defaultAccount, scanAccounts } from "./runtime-accounts.js";
import type { RuntimeAdapter } from "./runtime-adapter.js";

async function list(configDir: string, adapters: readonly RuntimeAdapter[], environment: Record<string, string>): Promise<void> {
  const rows = await Promise.all(adapters.map(async adapter => {
    const capability = adapter.accounts;
    if (!capability) return [];
    return Promise.all((await scanAccounts(configDir, adapter, environment)).map(async account => {
      const loggedIn = await capability.loggedIn?.(account.environment);
      return [adapter.id, account.label, account.directory ?? capability.home(account.environment),
        loggedIn === undefined ? "unknown" : loggedIn ? "logged in" : "signed out"].join("\t");
    }));
  }));
  process.stdout.write(["PROVIDER\tACCOUNT\tPATH\tLOGIN", ...rows.flat()].join("\n") + "\n");
}

async function createLoginDirectory(configDir: string, provider: string, label: string): Promise<string> {
  await mkdir(configDir, { mode: 0o700, recursive: true });
  let directory = configDir;
  for (const part of ["accounts", provider, label]) {
    directory = join(directory, part);
    await mkdir(directory, { mode: 0o700, recursive: true });
    if (!(await lstat(directory)).isDirectory()) throw new Error("Invalid account directory");
  }
  return directory;
}

async function main(): Promise<void> {
  const [configDir, configuredId, modulePath, action, provider, label] = process.argv.slice(2);
  if (!configDir || !isAbsolute(configDir)) throw new Error("Invalid configuration directory");
  const environment = sanitizedCodexEnvironment(process.env);
  if (action === "list") {
    const ids = modulePath && configuredId ? [...bundledAdapterIds, configuredId] : bundledAdapterIds;
    const adapters = await Promise.all(ids.map(id => loadAdapter(id, id === configuredId && modulePath ? modulePath : undefined)));
    await list(configDir, adapters, environment);
    return;
  }
  if (action !== "login" || !provider || !adapterIdPattern.test(provider) || !label || !accountLabelPattern.test(label)) {
    process.stderr.write("Usage: tmatrix accounts login <provider> <label>\n");
    process.exitCode = 1;
    return;
  }
  if (!bundledAdapterIds.includes(provider) && (provider !== configuredId || !modulePath)) {
    process.stderr.write("Unknown account provider. Use tmatrix accounts list to see available providers.\n");
    process.exitCode = 1;
    return;
  }
  const adapter = await loadAdapter(provider, provider === configuredId && modulePath ? modulePath : undefined);
  const capability = adapter.accounts;
  if (!capability) {
    process.stderr.write("This provider does not support account login.\n");
    process.exitCode = 1;
    return;
  }
  const directory = label === defaultAccount ? undefined : await createLoginDirectory(configDir, provider, label);
  const isolated = directory ? capability.environment(directory, environment) : environment;
  const { executable, args } = capability.login(isolated);
  await new Promise<void>((resolve, reject) => {
    const login = spawn(executable, args, { cwd: directory, env: isolated, stdio: "inherit" });
    login.once("error", reject);
    login.once("exit", code => {
      process.exitCode = code ?? 1;
      resolve();
    });
  });
}

main().catch(() => {
  process.stderr.write("Account command failed. Check the account directory and provider CLI installation.\n");
  process.exitCode = 1;
});
