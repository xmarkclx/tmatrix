import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeUpdateManager } from "../src/adapters/claude/update-manager.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function setup(candidateVersion?: string) {
  const root = await mkdtemp(join(tmpdir(), "tmatrix-claude-updates-"));
  roots.push(root);
  const bin = join(root, "bin");
  const store = join(root, "store");
  const original = join(bin, "claude");
  const commandLog = join(root, "npm-commands");
  const stable = join(root, "stable");
  await writeFile(stable, "2.1.221");
  const environment = { PATH: bin, TMATRIX_CLAUDE_PATH: original };
  await mkdir(bin);
  await writeFile(original, "#!/bin/sh\nprintf '2.1.220 (Claude Code)\\n'\n", { mode: 0o700 });
  await writeFile(join(bin, "npm"), `#!${process.execPath}
const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(commandLog)}, args[0] + '\\n');
const stable = readFileSync(${JSON.stringify(stable)}, 'utf8');
if (args[0] === 'view') {
  if (args[1] !== '@anthropic-ai/claude-code@stable') process.exit(1);
  process.stdout.write(JSON.stringify(stable));
} else {
  if (!args.includes('--ignore-scripts') || !args.includes('--@anthropic-ai:registry=https://registry.npmjs.org/')) process.exit(1);
  const candidate = ${candidateVersion ? JSON.stringify(candidateVersion) : 'stable'};
  const platform = args.find(arg => arg.startsWith('@anthropic-ai/claude-code-')).split('@')[1];
  const target = join(args[args.indexOf('--prefix') + 1], 'node_modules', '@' + platform);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'claude'), "#!/bin/sh\\nprintf '"+ candidate +" (Claude Code)\\\\n'\\n", { mode: 0o700 });
}
`, { mode: 0o700 });
  return { manager: new ClaudeUpdateManager(store, environment), original, store, environment, commandLog, stable };
}

describe.skipIf(process.platform === "win32" || !["arm64", "x64"].includes(process.arch))("Claude runtime updates", () => {
  it("activates a verified stable release without replacing the CLI selected by a running worker", async () => {
    const { manager, original, store, environment, commandLog } = await setup("2.1.221");
    await manager.initialize();
    const runningWorkerCLI = manager.executable();
    expect(runningWorkerCLI).toBe(original);
    const originalContents = await readFile(original, "utf8");
    await Promise.all([manager.checkNow(), manager.checkNow()]);
    expect(await readFile(commandLog, "utf8")).toBe("view\ninstall\n");
    expect(manager.snapshot()).toMatchObject({ status: "updated", current_version: "2.1.221", previous_version: "2.1.220" });
    expect(manager.executable()).toBe(join(store, "2.1.221", "claude"));
    expect(await readFile(runningWorkerCLI, "utf8")).toBe(originalContents);
    await manager.close();

    const restarted = new ClaudeUpdateManager(store, environment);
    await restarted.initialize();
    expect(restarted.executable()).toBe(join(store, "2.1.221", "claude"));
    await restarted.close();
  });

  it("keeps a running worker's managed binary through subsequent updates", async () => {
    const { manager, store, stable } = await setup();
    await manager.initialize();
    await manager.checkNow();
    const runningWorker = manager.acquire();
    await writeFile(stable, "2.1.222");
    await manager.checkNow();
    await writeFile(stable, "2.1.223");
    await manager.checkNow();
    expect(manager.snapshot()).toMatchObject({ status: "updated", current_version: "2.1.223" });
    await expect(readFile(join(store, "2.1.221", "claude"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(runningWorker.executable, "utf8")).toContain("2.1.221 (Claude Code)");
    runningWorker.release();
    await expect(readFile(runningWorker.executable)).rejects.toMatchObject({ code: "ENOENT" });
    await manager.close();
  });

  it("keeps the current executable when the new binary identifies as a different version", async () => {
    const { manager, original, store, environment } = await setup("2.1.222");
    await manager.initialize();
    await manager.checkNow();
    expect(manager.snapshot()).toMatchObject({ status: "failed", current_version: "2.1.220", latest_version: "2.1.221" });
    expect(manager.executable()).toBe(original);
    const restarted = new ClaudeUpdateManager(store, environment);
    await restarted.initialize();
    expect(restarted.executable()).toBe(original);
    await Promise.all([manager.close(), restarted.close()]);
  });
});
