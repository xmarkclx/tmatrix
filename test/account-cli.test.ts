import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const run = promisify(execFile);
const entry = fileURLToPath(new URL("../src/account-cli.ts", import.meta.url));

test.skipIf(process.platform === "win32")("account login runs the provider CLI in its own home and list reflects the login", async () => {
  const root = await mkdtemp(join(tmpdir(), "tmatrix-account-cli-"));
  try {
    const home = join(root, "home");
    const configDir = join(root, "private");
    const claude = join(root, "claude");
    const agy = join(root, "agy");
    await writeFile(claude, `#!/usr/bin/env node
const { existsSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const marker = join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json");
switch (process.argv.slice(2).join(" ")) {
  case "auth status --json": console.log(JSON.stringify({ loggedIn: existsSync(marker) })); break;
  case "auth login":
    if (process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR !== process.env.CLAUDE_CONFIG_DIR || process.env.API_KEY) process.exit(1);
    writeFileSync(marker, "", { mode: 0o600 });
    break;
  default: process.exit(1);
}`, { mode: 0o700 });
    await writeFile(agy, `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
if (process.argv.length !== 2 || process.env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE !== "1") process.exit(1);
const home = join(process.env.HOME, ".gemini", "antigravity-cli");
mkdirSync(home, { recursive: true, mode: 0o700 });
writeFileSync(join(home, "antigravity-oauth-token"), "", { mode: 0o600 });`, { mode: 0o700 });
    const accounts = (...args: string[]) => run(process.execPath,
      ["--import", "tsx", entry, configDir, "codex", "", ...args], {
        env: {
          PATH: process.env.PATH,
          HOME: home,
          CODEX_HOME: join(home, ".codex"),
          CLAUDE_CONFIG_DIR: join(home, ".claude"),
          TMATRIX_CLAUDE_PATH: claude,
          TMATRIX_AGY_PATH: agy,
          API_KEY: "fictional-accounts-test-key"
        },
        timeout: 10_000
      });
    await accounts("login", "claude", "work");
    await accounts("login", "gemini", "work");
    const claudeWork = join(configDir, "accounts", "claude", "work");
    const geminiWork = join(configDir, "accounts", "gemini", "work");
    expect((await stat(claudeWork)).mode & 0o777).toBe(0o700);
    expect((await stat(geminiWork)).mode & 0o777).toBe(0o700);
    const { stdout } = await accounts("list");
    expect(stdout.trimEnd().split("\n")).toEqual([
      "PROVIDER\tACCOUNT\tPATH\tLOGIN",
      `codex\tdefault\t${join(home, ".codex")}\tsigned out`,
      `claude\tdefault\t${join(home, ".claude")}\tsigned out`,
      `claude\twork\t${claudeWork}\tlogged in`,
      `gemini\tdefault\t${join(home, ".gemini", "antigravity-cli")}\tsigned out`,
      `gemini\twork\t${geminiWork}\tlogged in`
    ]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 15_000);
