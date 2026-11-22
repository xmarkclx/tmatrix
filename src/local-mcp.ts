import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";

const versions = ["2024-11-05", "2025-03-26", "2025-06-18"];
const requestSchema = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number()]).optional(),
  method: z.string(), params: z.unknown().optional() });

export interface LocalMcpServer {
  url: string;
  headers: { Authorization: string };
  close(): Promise<void>;
}

export async function startLocalMcp<Query>(options: {
  name: string;
  tool: { name: string; description: string; inputSchema: Record<string, unknown> };
  argumentsSchema: z.ZodType<Query>;
  call: (query: Query) => unknown | Promise<unknown>;
  errors: { unavailable: string; shutdown: string; arguments: string };
}): Promise<LocalMcpServer> {
  const callSchema = z.object({ name: z.literal(options.tool.name), arguments: options.argumentsSchema });
  const authorization = `Bearer ${randomBytes(32).toString("hex")}`;
  let host = "";
  const server = createServer((request, response) => { void handle(request, response); });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); throw new Error(options.errors.unavailable); }
  host = `127.0.0.1:${address.port}`;
  return {
    url: `http://${host}/mcp`, headers: { Authorization: authorization },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(new Error(options.errors.shutdown)) : resolve());
        server.closeAllConnections();
      });
    }
  };

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const supplied = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(authorization);
    if (request.socket.remoteAddress !== "127.0.0.1" || request.headers.host !== host || request.headers.origin ||
        supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      response.writeHead(403).end(); return;
    }
    if (request.url !== "/mcp") { response.writeHead(404).end(); return; }
    if (request.method !== "POST") { response.writeHead(405, { Allow: "POST" }).end(); return; }
    const protocol = request.headers["mcp-protocol-version"];
    if (protocol && (typeof protocol !== "string" || !versions.includes(protocol))) { response.writeHead(400).end(); return; }
    if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") { response.writeHead(415).end(); return; }
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > 8_192) { response.writeHead(413).end(); return; }
        chunks.push(buffer);
      }
      const parsed = requestSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (!parsed.success) { response.writeHead(400).end(); return; }
      const message = parsed.data;
      if (message.id === undefined) { response.writeHead(202).end(); return; }
      const respond = (result: unknown) => {
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      };
      const reject = (code: number, text: string) => {
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code, message: text } }));
      };
      if (message.method === "initialize") {
        const init = z.object({ protocolVersion: z.string() }).safeParse(message.params);
        if (!init.success) { reject(-32602, "Invalid initialization arguments"); return; }
        const version = versions.includes(init.data.protocolVersion) ? init.data.protocolVersion : "2025-06-18";
        respond({ protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: options.name, version: "1.0.0" } });
      } else if (message.method === "tools/list") {
        respond({ tools: [options.tool] });
      } else if (message.method === "tools/call") {
        const call = callSchema.safeParse(message.params);
        if (!call.success) { reject(-32602, options.errors.arguments); return; }
        const result = await options.call(call.data.arguments);
        respond({ content: [{ type: "text", text: JSON.stringify(result) }], isError: false });
      } else { reject(-32601, "Unknown method"); }
    } catch {
      if (!response.headersSent) response.writeHead(400).end();
      else response.end();
    }
  }
}
