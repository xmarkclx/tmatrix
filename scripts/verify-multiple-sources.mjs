import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = await mkdtemp(join(tmpdir(), "tmatrix-multiple-sources-"));
const sourceIds = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
const names = ["TzuDo fixture", "Mindmap fixture"];
const keys = ["fixture-alpha-worker-key", "fixture-beta-worker-key"];
const children = new Set();
const servers = new Set();

async function waitFor(read, description, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function events(root) {
  const text = await readFile(join(root, "runtime-events.jsonl"), "utf8").catch(() => "");
  return text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

function assertNoKeys(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const key of keys) assert.equal(text.includes(key), false, "A source credential escaped its boundary");
}

async function scenario(maxWorkers, totalTickets, inspect) {
  const root = join(directory, `cap-${maxWorkers}`);
  await mkdir(root, { mode: 0o700 });
  const calls = [];
  const results = [];
  const active = [null, null];
  const counts = [0, 0];
  const receipts = new Map();
  let violation;
  let origin;
  const server = createServer({ key: await readFile(join(directory, "tls.key")), cert: await readFile(join(directory, "tls.crt")) }, async (request, response) => {
    try {
      const match = /^\/source-(0|1)\/(poll|taken|history|progress|result)$/.exec(new URL(request.url, origin).pathname);
      assert.ok(match, "Fixture received an unexpected endpoint");
      const source = Number(match[1]);
      const action = match[2];
      assert.equal(request.headers.authorization, `Bearer ${keys[source]}`, "Source callback used another connection's key");
      assert.equal(request.headers["x-aiworker-instance"], sourceIds[source]);
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      calls.push({ source, action, body });
      let output = {};
      if (action === "poll") {
        const receiptKey = `${source}:${body.poll_id}`;
        if (receipts.has(receiptKey)) output = receipts.get(receiptKey);
        else {
          const newTickets = [];
          if (!active[source] && counts[source] < totalTickets && body.available_slots > 0) {
            const sequence = ++counts[source];
            active[source] = {
              ticket_id: `ticket-${sequence}`, worker_id: `worker-${sequence}`,
              task_id: `33333333-3333-4333-8333-${String(sequence).padStart(12, "0")}`,
              instructions: "Complete the fictional verification turn.", project_path: root,
              execution_mode: "NORMAL", model: `fixture-${source}`, reasoning_effort: "medium", service_tier: "default",
              input_revision: 1,
              endpoints: Object.fromEntries(["mark_taken", "history", "progress", "result"].map(name => [name,
                `${name === "history" ? "GET" : "POST"} ${origin}/source-${source}/${name === "mark_taken" ? "taken" : name}`]))
            };
            newTickets.push(active[source]);
          }
          output = { new_tickets: newTickets, owned_in_progress: active[source] && !newTickets.length ? [active[source]] : [], steering_events: [], cancellation_requests: [] };
          receipts.set(receiptKey, output);
        }
      } else if (action === "history") output = { task: { id: active[source]?.task_id, title: "Fictional verification task" }, comments: [] };
      else if (action === "result") {
        results.push({ source, body });
        active[source] = null;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(output));
    } catch (error) {
      violation ??= error;
      response.writeHead(500);
      response.end("Fixture contract failed");
    }
  });
  servers.add(server);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `https://127.0.0.1:${server.address().port}`;
  const sources = await Promise.all(sourceIds.map(async (id, index) => {
    const credential = join(root, `credential-${index}`);
    await writeFile(credential, keys[index] + "\n", { mode: 0o600 });
    return { id, name: names[index], instance_id: id, poll_url: `${origin}/source-${index}/poll`, credential_file: credential,
      conversation_namespace: JSON.stringify([`${origin}/source-${index}/poll`, id]) };
  }));
  const config = {
    runtime_adapter: "fixture", adapter_module: join(directory, "adapter.mjs"), instance_id: randomUUID(), update_origin: origin,
    sources, max_workers: maxWorkers, poll_interval_ms: 250, idle_backoff_max_ms: 250, request_timeout_ms: 1_000,
    max_request_attempts: 1, shutdown_grace_ms: 1_000, log_dir: join(root, "logs"), log_level: "silent",
    conversation_state_dir: join(root, "conversations")
  };
  const configPath = join(root, "engine.json");
  const bridgePath = join(root, "bridge.json");
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const environment = { ...process.env, CONFIG_PATH: configPath, NODE_EXTRA_CA_CERTS: join(directory, "tls.crt"),
    TMATRIX_CONTROL_FILE: bridgePath, TMATRIX_CONTROL_PORT: "0", TMATRIX_INTAKE_PAUSED: "0", TMATRIX_VERIFY_ROOT: root };
  for (const name of ["API_KEY", "POLL_URL", "INSTANCE_ID", "SWARM_ID", "MAX_WORKERS", "MAX_TICKETS_PER_POLL", "RUNTIME_ADAPTER", "ADAPTER_MODULE", "CONVERSATION_STATE_DIR"]) delete environment[name];
  const child = spawn(process.execPath, [join(directory, "engine", "dist", "index.js")], { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  let bridge;
  try {
    bridge = await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`Fixture engine exited before bridge startup, code ${child.exitCode}`);
      return readFile(bridgePath, "utf8").then(JSON.parse).catch(() => null);
    }, "the isolated engine bridge");
    const control = async (path, body) => {
      const response = await fetch(bridge.url + path, { method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      assert.ok(response.ok, `Local control ${path} returned ${response.status}`);
      return response.json();
    };
    const snapshot = async () => {
      const value = await control("/v1/snapshot");
      assertNoKeys(value);
      assert.ok(value.running_workers <= maxWorkers, "Combined workers exceeded the global maximum");
      assert.ok(value.running_workers + value.pollers.reduce((sum, source) => sum + source.reserved_slots, 0) <= maxWorkers,
        "Running workers and reserved claims exceeded the global maximum");
      if (violation) throw violation;
      return value;
    };
    await inspect({ root, control, snapshot, calls, results, events: () => events(root) });
    let running = 0;
    for (const event of await events(root)) {
      if (event.kind === "started") running++;
      if (event.kind === "closed") running--;
      assert.ok(running >= 0 && running <= maxWorkers, "Runtime events exceeded the shared worker limit");
    }
    assert.equal(running, 0, "A fixture runtime was left running");
    assert.ifError(violation);
    assertNoKeys(output);
    assert.ok(calls.some(call => call.source === 0 && call.action === "history"));
    assert.ok(calls.some(call => call.source === 1 && call.action === "history"));
    for (const source of [0, 1]) {
      const first = calls.find(call => call.source === source && call.action === "poll");
      assert.equal(first.body.available_slots, 0, "Each source must reconcile before intake");
    }
    await control("/v1/shutdown", {});
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, "fixture engine shutdown");
    assert.equal(child.exitCode, 0);
  } catch (error) {
    let diagnostic = output;
    for (const key of keys) diagnostic = diagnostic.replaceAll(key, "[REDACTED]");
    throw new Error(`${error.message}\nFixture engine output: ${diagnostic.slice(-4000)}`, { cause: error });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit").catch(() => {});
    }
    children.delete(child);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    servers.delete(server);
  }
}

try {
  try {
    execFileSync(process.execPath, [join(repository, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json",
      "--outDir", join(directory, "engine", "dist"), "--sourceMap", "false", "--declaration", "false"], { cwd: repository, stdio: "pipe" });
  } catch (error) {
    throw new Error(error.stdout?.toString() || error.message, { cause: error.message });
  }
  await writeFile(join(directory, "engine", "package.json"), '{"type":"module"}\n');
  await symlink(join(repository, "node_modules"), join(directory, "engine", "node_modules"), "dir");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(directory, "tls.key"),
    "-out", join(directory, "tls.crt"), "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"], { stdio: "ignore" });
  await writeFile(join(directory, "adapter.mjs"), `
import {appendFile,access} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
export default {apiVersion:1,id:'fixture',create({environment},profile){
  if(environment.API_KEY) throw Error('Queue credential reached runtime environment');
  const root=environment.TMATRIX_VERIFY_ROOT;
  const source=Number(profile.model.slice(-1));
  const record=event=>appendFile(join(root,'runtime-events.jsonl'),JSON.stringify({source,...event})+'\\n');
  let closed=false;
  const thread={async steer(){await record({kind:'steer'});return true;},async runStreamed(_input,{signal}={}){
    return {events:(async function*(){
      await record({kind:'started'});
      yield {type:'thread.started',thread_id:randomUUID()};
      yield {type:'turn.started'};
      while(!await access(join(root,'release-'+source)).then(()=>true,()=>false)){
        signal?.throwIfAborted();if(closed)throw Error('Runtime closed');await delay(10);
      }
      signal?.throwIfAborted();
      yield {type:'item.completed',item:{id:'answer',type:'agent_message',text:JSON.stringify({outcome:'AI_DONE',context_summary:'Fixture completed.',user_message:'answer-'+source})}};
      yield {type:'turn.completed',usage:{input_tokens:0,cached_input_tokens:0,cache_write_input_tokens:0,output_tokens:0,reasoning_output_tokens:0}};
    })()};}};
  return {startThread(){return thread;},async close(){if(closed)return;closed=true;await record({kind:'closed'});}};
}};\n`, { mode: 0o600 });

  await scenario(2, 1, async ({ root, control, snapshot, calls, results, events }) => {
    await waitFor(async () => (await events()).filter(event => event.kind === "started").length === 2, "two colliding-ID workers");
    const state = await snapshot();
    assert.deepEqual(state.pollers.map(source => source.name), names);
    assert.equal(state.running_workers, 2);
    assert.equal(new Set(state.workers.map(worker => worker.id)).size, 2);
    assert.deepEqual(new Set(state.workers.map(worker => worker.ticket_id)), new Set(["ticket-1"]));
    const first = state.workers.find(worker => worker.source_id === sourceIds[0]);
    const second = state.workers.find(worker => worker.source_id === sourceIds[1]);
    assert.equal(first.source_name, names[0]);
    assert.equal(second.source_name, names[1]);
    await control(`/v1/workers/${encodeURIComponent(first.id)}/pin`, { pinned: true });
    await control(`/v1/workers/${encodeURIComponent(second.id)}/pin`, { pinned: true });
    await control(`/v1/workers/${encodeURIComponent(first.id)}/steer`, { message: "Fictional source-specific message.", request_id: "fixture-steer" });
    await waitFor(async () => (await events()).some(event => event.kind === "steer" && event.source === 0), "source-specific runtime steering");
    assert.equal((await events()).some(event => event.kind === "steer" && event.source === 1), false);
    await control(`/v1/workers/${encodeURIComponent(second.id)}/stop`, {});
    await waitFor(async () => (await snapshot()).running_workers === 1, "selected source worker teardown");
    const stopped = await snapshot();
    assert.equal(stopped.workers.find(worker => worker.id === first.id).status, "running");
    assert.equal(stopped.workers.find(worker => worker.id === second.id).status, "stopped");
    await writeFile(join(root, "release-0"), "release\n");
    await waitFor(() => results.length === 1, "the surviving source result callback");
    assert.equal(results[0].source, 0);
    assert.equal(results[0].body.user_message, "answer-0");
    assert.ok(calls.some(call => call.source === 1 && call.action === "poll" && call.body.available_slots === 0));
    await waitFor(async () => (await snapshot()).running_workers === 0, "all workers to finish");
  });
  console.log("PASS: one engine handles colliding source IDs, separate credentials, source-qualified controls and a combined worker limit.");

  await scenario(1, 2, async ({ root, snapshot, results, events }) => {
    await waitFor(async () => (await events()).some(event => event.kind === "started"), "the first single-slot worker");
    const first = (await events()).find(event => event.kind === "started").source;
    await writeFile(join(root, `release-${first}`), "release\n");
    await waitFor(async () => new Set((await events()).filter(event => event.kind === "started").map(event => event.source)).size === 2, "the other source's fair admission");
    const starts = (await events()).filter(event => event.kind === "started");
    assert.notEqual(starts[0].source, starts[1].source, "A busy source took the next slot before its waiting peer");
    await snapshot();
    await writeFile(join(root, `release-${1 - first}`), "release\n");
    await waitFor(() => results.length === 4, "both queues' completed results");
    await waitFor(async () => (await snapshot()).running_workers === 0, "the single-slot pool to drain");
    assert.deepEqual(results.map(result => result.body.user_message).sort(), ["answer-0", "answer-0", "answer-1", "answer-1"]);
  });
  console.log("PASS: a single worker slot rotates between busy sources and delivers each result to its own queue.");
} finally {
  for (const child of children) child.kill("SIGKILL");
  for (const server of servers) server.closeAllConnections();
  await rm(directory, { recursive: true, force: true });
}
