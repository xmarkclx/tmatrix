import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readlink, rm, access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationStore } from "../src/conversation-store.js";
import { AppServerCodex, spawnCodexAppServer } from "../src/adapters/codex/app-server.js";
import { processStart } from "../src/conversation-recovery.js";
import { makeTicket } from "./helpers.js";

const children: ChildProcess[] = [];
const directories: string[] = [];
const orphanPids: number[] = [];
const namespace = "https://cgroup-fixture.example.test";
const task = "fictional-crashed-owner";
const storeUrl = new URL("../src/conversation-store.ts", import.meta.url).href;
const spawnUrl = new URL("../src/adapters/codex/app-server.ts", import.meta.url).href;

afterEach(async () => {
  for (const pid of orphanPids.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch {} }
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture(runPayload: boolean) {
  const directory = await mkdtemp(join(tmpdir(), "tmatrix-cgroup-fixture-"));
  directories.push(directory);
  const payload = `
    const {spawn} = require('node:child_process');
    const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {detached:true, stdio:'ignore'});
    orphan.unref();
    console.log(JSON.stringify({orphan: orphan.pid, runtime:process.pid}));
    setInterval(() => {}, 1000);
  `;
  const owner = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import {ConversationStore} from ${JSON.stringify(storeUrl)};
    import {spawnCodexAppServer} from ${JSON.stringify(spawnUrl)};
    const store = new ConversationStore({directory:${JSON.stringify(directory)}, namespace:${JSON.stringify(namespace)}, trackRuntime:true});
    const ticket = {task_id:${JSON.stringify(task)}, ticket_id:'fictional-ticket'};
    await store.remember(ticket, 'preserved-thread');
    const lease = await store.acquire(ticket);
    ${runPayload ? `const runtime = spawnCodexAppServer(process.execPath, {...process.env,...lease.environment}, ['-e',${JSON.stringify(payload)}]); runtime.stdout.pipe(process.stdout); runtime.stderr.pipe(process.stderr);` : "console.log('{}');"}
    setInterval(() => {}, 1000);
  `], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(owner);
  const lines = createInterface({ input: owner.stdout! });
  const [line] = await once(lines, "line");
  lines.close();
  const output: { orphan?: number; runtime?: number } = JSON.parse(String(line));
  if (output.orphan) orphanPids.push(output.orphan);
  if (output.runtime) orphanPids.push(output.runtime);
  const folder = join(directory, (await readdir(directory))[0]!);
  const lock = join(folder, (await readdir(folder)).find(name => name.endsWith(".lock"))!);
  const metadata: { tracking: number; cgroup?: string } = JSON.parse(await readlink(lock));
  return { owner, directory, metadata, orphan: output.orphan };
}

async function crash(child: ChildProcess) {
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

describe.skipIf(process.env.TMATRIX_TEST_CGROUPS !== "1")("delegated cgroup crash recovery", () => {
  it("recovers a killed owner, stops detached descendants and preserves other work and routing", async () => {
    const { owner, directory, orphan } = await fixture(true);
    expect(orphan).toBeDefined();
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(unrelated);
    await once(unrelated, "spawn");
    const protectedProcess = spawn("python3", ["-u", "-c", 'import ctypes,time; assert ctypes.CDLL(None).prctl(4,0)==0; print("ready"); time.sleep(60)'], { stdio: ["ignore", "pipe", "ignore"] });
    children.push(protectedProcess);
    await once(protectedProcess.stdout!, "data");
    await expect(readFile(`/proc/${protectedProcess.pid}/environ`)).rejects.toMatchObject({ code: "EACCES" });
    await crash(owner);
    expect(await processStart(orphan!)).toBeDefined();
    const store = new ConversationStore({ directory, namespace, trackRuntime: true });
    const ticket = makeTicket({ task_id: task });
    const lease = await store.acquire(ticket);
    try {
      expect(lease.recovered).toBe(true);
      expect(await processStart(orphan!)).toBeUndefined();
      expect(await processStart(unrelated.pid!)).toBeDefined();
      expect(await store.resolve(ticket, {})).toBe("preserved-thread");
    } finally { await lease(); }
  }, 20_000);

  it("confirms detached children stopped during runtime close, before releasing the lease", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tmatrix-cgroup-close-"));
    directories.push(directory);
    const store = new ConversationStore({ directory, namespace, trackRuntime: true });
    const lease = await store.acquire(makeTicket({ task_id: "fictional-normal-close" }));
    const pidFile = join(directory, "orphan-pid");
    const script = `
      const child = require('node:child_process').spawn(process.execPath, ['-e','setInterval(() => {}, 1000)'], {detached:true,stdio:'ignore'});
      child.unref();
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      require('node:readline').createInterface({input:process.stdin}).on('line', line => {
        const request=JSON.parse(line);
        if(request.id !== undefined) process.stdout.write(JSON.stringify({id:request.id,result:{}})+'\\n');
      });
    `;
    const runtime = new AppServerCodex({
      environment: Object.fromEntries(Object.entries({ ...process.env, ...lease.environment }).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      spawnProcess: environment => {
        const child = spawnCodexAppServer(process.execPath, environment, ["-e", script]);
        children.push(child);
        return child;
      }
    });
    try {
      await runtime.transport();
      const orphan = Number(await readFile(pidFile, "utf8"));
      orphanPids.push(orphan);
      expect(await processStart(orphan)).toBeDefined();
      await runtime.close();
      expect(await processStart(orphan)).toBeUndefined();
    } finally { await runtime.close(); await lease(); }
  }, 20_000);

  it("prevents a launcher delayed until after recovery from executing its payload", async () => {
    const { owner, directory, metadata } = await fixture(false);
    expect(metadata.tracking).toBe(2);
    expect(metadata.cgroup).toBeDefined();
    const marker = join(directory, "payload-executed");
    const launcher = spawn("/bin/sh", ["-c", 'read -r gate; printf "%s" "$$" > "$1/cgroup.procs" && exec "$2" -e \'require("node:fs").writeFileSync(process.argv[1], "ran")\' "$3"', "fixture", metadata.cgroup!, process.execPath, marker], { stdio: ["pipe", "ignore", "ignore"] });
    children.push(launcher);
    await once(launcher, "spawn");
    await crash(owner);
    const store = new ConversationStore({ directory, namespace, trackRuntime: true });
    const lease = await store.acquire(makeTicket({ task_id: task }));
    try {
      expect(lease.recovered).toBe(true);
      const exited = once(launcher, "exit");
      launcher.stdin!.end("go\n");
      const [code] = await exited;
      expect(code).not.toBe(0);
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await lease(); }
  }, 20_000);
});
