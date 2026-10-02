import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, isAbsolute } from "node:path";
import { z } from "zod";
import type { AdapterUpdateControl } from "./runtime-adapter.js";
import type { Supervisor } from "./supervisor.js";

const settingsSchema = z.object({
  max_workers: z.number().int().min(1).max(100).optional(),
  intake_paused: z.boolean().optional(),
  poll_interval_ms: z.number().int().min(250).max(300_000).optional()
}).strict();
const steerSchema = z.object({
  message: z.string().trim().min(1).max(8_000),
  request_id: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/).optional()
}).strict();

export interface LocalControlServer {
  close(): Promise<void>;
}

/** A bearer-protected, loopback-only bridge; no credentials are logged. */
export async function startLocalControlServer(options: {
  supervisor: Supervisor;
  file: string;
  port?: number;
  onShutdown: () => void;
  adapterUpdates?: AdapterUpdateControl;
}): Promise<LocalControlServer> {
  if (!isAbsolute(options.file)) throw new Error("TMATRIX_CONTROL_FILE must be an absolute path");
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("TMATRIX_CONTROL_PORT must be 0..65535");
  const token = randomBytes(32).toString("hex");
  const authorization = Buffer.from(`Bearer ${token}`);
  const server = createServer((request, response) => {
    void route(request, response).catch(() => {
      if (!response.headersSent) respond(response, 500, { error: "Local control operation failed" });
      else response.end();
    });
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 1_000;

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const supplied = Buffer.from(request.headers.authorization ?? "");
    // Browsers cannot use this API through cross-origin forms, fetch, or DNS
    // rebinding. Native clients must use the numeric loopback discovery URL.
    if (request.headers.origin || request.headers.host !== `127.0.0.1:${actualPort}`) {
      respond(response, 403, { error: "Only local native clients are allowed" });
      return;
    }
    if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) {
      respond(response, 401, { error: "Local control authentication required" });
      return;
    }
    if (request.method === "GET" && request.url === "/v1/snapshot") {
      respond(response, 200, { ...options.supervisor.localSnapshot(), ...(options.adapterUpdates ? { adapter_update: options.adapterUpdates.snapshot() } : {}) });
      return;
    }
    if (request.method !== "POST") {
      respond(response, 404, { error: "Unknown local control endpoint" });
      return;
    }
    if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") {
      respond(response, 415, { error: "Use application/json" });
      return;
    }
    let body: unknown;
    try { body = await readBody(request); } catch {
      respond(response, 400, { error: "Expected a JSON object of at most 16 KiB" });
      return;
    }
    if (request.url === "/v1/adapter/check-now" || request.url === "/v1/adapter/rollback") {
      if (!z.object({}).strict().safeParse(body).success) { respond(response, 400, { error: "Expected an empty object" }); return; }
      if (!options.adapterUpdates || options.adapterUpdates.snapshot().status === "disabled") {
        respond(response, 409, { error: "Runtime updates are unavailable for this engine" }); return;
      }
      if (request.url === "/v1/adapter/rollback" && ["checking", "installing", "verifying"].includes(options.adapterUpdates.snapshot().status)) {
        respond(response, 409, { error: "Runtime update already in progress; retry rollback after it finishes" }); return;
      }
      if (request.url === "/v1/adapter/rollback" && (!options.adapterUpdates.rollback || !options.adapterUpdates.snapshot().can_rollback)) {
        respond(response, 409, { error: "No runtime rollback is available" }); return;
      }
      if (request.url === "/v1/adapter/check-now") void options.adapterUpdates.checkNow().catch(() => undefined);
      else void options.adapterUpdates.rollback!().catch(() => undefined);
      respond(response, 202, { ok: true });
      return;
    }
    if (request.url === "/v1/settings") {
      const parsed = settingsSchema.safeParse(body);
      if (!parsed.success) { respond(response, 400, { error: "Invalid settings" }); return; }
      options.supervisor.updateLocalSettings({
        ...(parsed.data.max_workers !== undefined ? { max_workers: parsed.data.max_workers } : {}),
        ...(parsed.data.intake_paused !== undefined ? { intake_paused: parsed.data.intake_paused } : {}),
        ...(parsed.data.poll_interval_ms !== undefined ? { poll_interval_ms: parsed.data.poll_interval_ms } : {})
      });
      respond(response, 200, { ...options.supervisor.localSnapshot(), ...(options.adapterUpdates ? { adapter_update: options.adapterUpdates.snapshot() } : {}) });
      return;
    }
    if (request.url === "/v1/shutdown") {
      if (!z.object({}).strict().safeParse(body).success) { respond(response, 400, { error: "Expected an empty object" }); return; }
      respond(response, 202, { status: "shutting_down" });
      setImmediate(options.onShutdown);
      return;
    }
    const match = /^\/v1\/workers\/([^/]+)\/(steer|stop|pin)$/.exec(request.url ?? "");
    if (!match) { respond(response, 404, { error: "Unknown local control endpoint" }); return; }
    let workerId: string;
    try { workerId = decodeURIComponent(match[1]!); } catch { respond(response, 400, { error: "Invalid worker ID" }); return; }
    if (match[2] === "pin") {
      const parsed = z.object({ pinned: z.boolean() }).strict().safeParse(body);
      if (!parsed.success) { respond(response, 400, { error: "Expected a pinned boolean" }); return; }
      if (!options.supervisor.pinLocalWorker(workerId, parsed.data)) {
        respond(response, 404, { error: "Worker is no longer available" }); return;
      }
      respond(response, 200, { pinned: parsed.data.pinned });
      return;
    }
    if (match[2] === "steer") {
      const parsed = steerSchema.safeParse(body);
      if (!parsed.success) { respond(response, 400, { error: "Message must contain 1..8000 characters" }); return; }
      const id = parsed.data.request_id ?? randomUUID();
      try { options.supervisor.queueLocalSteering(workerId, parsed.data.message, id); } catch (error) {
        respond(response, 409, { error: error instanceof Error ? error.message : "Message could not be queued" }); return;
      }
      respond(response, 202, { id, status: "queued" });
      return;
    }
    if (!z.object({}).strict().safeParse(body).success) { respond(response, 400, { error: "Expected an empty object" }); return; }
    try { options.supervisor.stopLocalWorker(workerId); } catch {
      respond(response, 409, { error: "Worker is no longer running" }); return;
    }
    respond(response, 202, { status: "stopping" });
  }

  let actualPort = 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local control listener has no address");
  actualPort = address.port;
  const discovery = JSON.stringify({ version: 1, url: `http://127.0.0.1:${actualPort}`, token, pid: process.pid });
  try {
    await mkdir(dirname(options.file), { recursive: true, mode: 0o700 });
    // A private file is created exclusively. Never follow a symlink or replace
    // another daemon's discovery record, including a potentially stale one.
    const file = await open(options.file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { await file.writeFile(discovery + "\n"); } finally { await file.close(); }
  } catch {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Could not create private TMATRIX_CONTROL_FILE; use a new path or remove a verified stale discovery file");
  }
  let closed = false;
  return {
    async close() {
      if (closed) return;
      closed = true;
      server.closeIdleConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // Do not remove a discovery file that another owner replaced.
      if (await readFile(options.file, "utf8").catch(() => "") === discovery + "\n") await unlink(options.file).catch(() => undefined);
    }
  };
}

function respond(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(value));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    bytes += buffer.length;
    if (bytes > 16_384) throw new Error("Body exceeds limit");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
