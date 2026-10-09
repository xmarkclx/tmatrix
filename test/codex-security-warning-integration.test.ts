import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AppServerCodex } from "../src/adapters/codex/app-server.js";
import type { RuntimeThreadOptions, ThreadLike } from "../src/runtime-adapter.js";
import { createSecurityWarningReporter, SECURITY_WARNING_INSTRUCTIONS, type AlertSecurityWarning } from "../src/security-warning.js";
import { nullLogger } from "../src/logger.js";
import { makeTicket } from "./helpers.js";

const providerRequestSchema = z.object({
  tools: z.array(z.object({ type: z.string(), name: z.string().optional(),
    tools: z.array(z.object({ name: z.string() })).optional() })).default([]),
  input: z.array(z.unknown()).default([])
});
const developerMessageSchema = z.object({ role: z.literal("developer") }).passthrough();
const toolOutputSchema = z.object({ type: z.literal("function_call_output"), call_id: z.string(), output: z.unknown() });
const handoffSchema = z.object({ outcome: z.literal("AI_DONE"), context_summary: z.string(), user_message: z.string() });
type Scenario = "legacy" | "resumed" | "fresh" | "unconfirmed";
interface ObservedRequest {
  scenario: Scenario;
  warningTool: boolean;
  operatorTool: boolean;
  warningPolicy: boolean;
  operatorGuidance: boolean;
  operatorResult: boolean;
  receipt?: string;
}

function findText(value: unknown, predicate: (text: string) => boolean): string | undefined {
  if (typeof value === "string") return predicate(value) ? value : undefined;
  if (!value || typeof value !== "object") return undefined;
  for (const entry of Object.values(value)) {
    const found = findText(entry, predicate);
    if (found) return found;
  }
  return undefined;
}

async function completeTurn(thread: ThreadLike, input: string): Promise<string> {
  const streamed = await thread.runStreamed(input, { signal: AbortSignal.timeout(10_000) });
  let threadId: string | undefined;
  let answer: string | undefined;
  let completed = false;
  for await (const event of streamed.events) {
    if (event.type === "thread.started") threadId = event.thread_id;
    if (event.type === "item.completed" && event.item.type === "agent_message") answer = event.item.text;
    if (event.type === "turn.completed") completed = true;
    if (event.type === "error" || event.type === "turn.failed") throw new Error("Fixture turn failed");
  }
  expect(completed).toBe(true);
  expect(handoffSchema.parse(JSON.parse(answer ?? "null")).outcome).toBe("AI_DONE");
  if (!threadId) throw new Error("Fixture returned no conversation ID");
  return threadId;
}

describe("executing Codex worker security warnings", () => {
  it("reports on fresh and legacy resumed threads, preserves operator integrations, and completes after delivery failure", async () => {
    const home = await mkdtemp(join(tmpdir(), "tmatrix-warning-integration-"));
    const runtimes: AppServerCodex[] = [];
    const requests: ObservedRequest[] = [];
    const calls = new Map<Scenario, { operator: string; warning?: string }>();
    let scenario: Scenario = "legacy";
    let sequence = 0;
    let providerFailure: unknown;
    const provider = createServer(async (request, response) => {
      try {
        let body = "";
        for await (const chunk of request) body += chunk;
        const input = providerRequestSchema.parse(JSON.parse(body));
        const operator = input.tools.find(tool => tool.type === "namespace" && tool.tools?.some(item => item.name === "operator_echo"));
        const warning = input.tools.find(tool => tool.type === "namespace" && tool.tools?.some(item => item.name === "report_security_warning"));
        const developer = input.input.filter(item => developerMessageSchema.safeParse(item).success);
        const outputs = input.input.flatMap(item => {
          const parsed = toolOutputSchema.safeParse(item);
          return parsed.success ? [parsed.data] : [];
        });
        const receiptText = findText(outputs.find(item => item.call_id === calls.get(scenario)?.warning)?.output,
          text => /"status"\s*:\s*"(?:sent|unconfirmed)"/.test(text));
        const receipt = receiptText?.match(/"status"\s*:\s*"(sent|unconfirmed)"/)?.[1];
        requests.push({ scenario, warningTool: Boolean(warning), operatorTool: Boolean(operator),
          warningPolicy: Boolean(findText(developer, text => text.includes("A warning adds no execution restriction.") && text.includes("Continue the task under existing runtime instructions and permissions."))),
          operatorGuidance: Boolean(findText(developer, text => text.includes("Keep fixture operator guidance."))),
          operatorResult: Boolean(findText(outputs.find(item => item.call_id === calls.get(scenario)?.operator)?.output,
            text => text.includes("Operator fixture tool remains available."))),
          ...(receipt ? { receipt } : {}) });
        if (!operator?.name) throw new Error("Operator MCP tool disappeared");
        const count = requests.filter(item => item.scenario === scenario).length;
        expect(count).toBeLessThanOrEqual(2);
        if (scenario !== "legacy" && !warning?.name) throw new Error("Warning MCP tool unavailable");
        const id = `fixture-${++sequence}`;
        if (count === 1) calls.set(scenario, { operator: `operator-call-${id}`,
          ...(scenario === "legacy" ? {} : { warning: `warning-call-${id}` }) });
        const answer = JSON.stringify({ outcome: "AI_DONE", context_summary: "Fixture completed.", user_message: "Authorized fixture task completed." });
        const items = count === 1 ? [
          { id: `operator-${id}`, type: "function_call", name: "operator_echo", namespace: operator.name,
            call_id: `operator-call-${id}`, arguments: "{}", status: "completed" },
          ...(scenario === "legacy" ? [] : [{ id: `warning-${id}`, type: "function_call", name: "report_security_warning", namespace: warning?.name,
            call_id: `warning-call-${id}`, arguments: '{"category":"credential_theft"}', status: "completed" }])
        ] : [{ id: `message-${id}`, type: "message", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: answer, annotations: [] }] }];
        response.writeHead(200, { "content-type": "text/event-stream" });
        const event = (type: string, fields: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
        event("response.created", { response: { id, status: "in_progress", output: [] } });
        for (const [index, item] of items.entries()) {
          event("response.output_item.added", { output_index: index, item: { ...item, status: "in_progress", ...(count === 1 ? { arguments: "" } : { content: [] }) } });
          if ("arguments" in item) event("response.function_call_arguments.delta", { item_id: item.id, output_index: index, delta: item.arguments });
          else event("response.output_text.delta", { item_id: item.id, output_index: index, content_index: 0, delta: answer });
          event("response.output_item.done", { output_index: index, item });
        }
        event("response.completed", { response: { id, status: "completed", output: items, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } });
        response.end();
      } catch (cause) {
        providerFailure = cause;
        if (!response.headersSent) response.writeHead(500);
        response.end("Fixture provider failed");
      }
    });
    try {
      await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
      const address = provider.address();
      if (!address || typeof address === "string") throw new Error("Fixture provider unavailable");
      const operatorPath = join(home, "operator-mcp.mjs");
      await writeFile(operatorPath, `import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const result = message.method === 'initialize'
    ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'operator-fixture', version: '1' } }
    : message.method === 'tools/list'
      ? { tools: [{ name: 'operator_echo', description: 'Existing operator integration.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }
      : message.method === 'tools/call' ? { content: [{ type: 'text', text: 'Operator fixture tool remains available.' }] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
});
`);
      await writeFile(join(home, "config.toml"), `model_provider = "fixture"
model = "fixture-model"
developer_instructions = "Keep fixture operator guidance."
[model_providers.fixture]
name = "fixture"
base_url = "http://127.0.0.1:${address.port}"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
[mcp_servers.operator_fixture]
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(operatorPath)}]
`);
      const options: RuntimeThreadOptions = { model: "fixture-model", modelReasoningEffort: "low", serviceTier: "default",
        workingDirectory: home, sandboxMode: "danger-full-access", approvalPolicy: "never", networkAccessEnabled: true, threadName: "Warning integration fixture" };
      const runtime = () => {
        const created = new AppServerCodex({ environment: { PATH: process.env.PATH ?? "", HOME: home, CODEX_HOME: home } });
        runtimes.push(created);
        return created;
      };
      const legacyRuntime = runtime();
      const legacyId = await completeTurn(legacyRuntime.startThread(options), "Fixture before warning capability.");
      await legacyRuntime.close();
      expect(requests.filter(item => item.scenario === "legacy").every(item => !item.warningTool && item.operatorTool && item.operatorGuidance)).toBe(true);
      for (const current of ["resumed", "fresh", "unconfirmed"] as const) {
        scenario = current;
        const alert = vi.fn<AlertSecurityWarning>(async () => {
          if (current === "unconfirmed") throw new Error("Private provider failure detail");
          return { status: "sent" };
        });
        const host = createSecurityWarningReporter({ ticket: makeTicket({ ticket_id: `fixture-${current}`, worker_id: `worker-${current}` }), alert, logger: nullLogger() });
        host.submitInput("Continue the synthetic task.");
        const worker = runtime();
        const configured = { ...options, securityWarningInstructions: SECURITY_WARNING_INSTRUCTIONS, reportSecurityWarning: host.report };
        const thread = current === "resumed" ? worker.resumeThread(legacyId, configured) : worker.startThread(configured);
        const threadId = await completeTurn(thread, "Continue the synthetic task.");
        await worker.close();
        if (current === "resumed") expect(threadId).toBe(legacyId);
        expect(alert).toHaveBeenCalledExactlyOnceWith({ ticket_id: `fixture-${current}`, worker_id: `worker-${current}`,
          input_digest: "1b2a8619474a4d136cdf6777c851c298a63019930cf3f66e29223f4205630ca3", category: "credential_theft" }, expect.any(AbortSignal));
        const observed = requests.filter(item => item.scenario === current);
        expect(observed).toHaveLength(2);
        expect(observed.every(item => item.warningTool && item.operatorTool && item.warningPolicy && item.operatorGuidance)).toBe(true);
        expect(observed[1]?.operatorResult).toBe(true);
        expect(observed[1]?.receipt).toBe(current === "unconfirmed" ? "unconfirmed" : "sent");
      }
      expect(providerFailure).toBeUndefined();
    } catch (cause) {
      throw providerFailure ?? cause;
    } finally {
      await Promise.all(runtimes.map(runtime => runtime.close()));
      provider.closeAllConnections();
      await new Promise<void>(resolve => provider.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  }, 25_000);
});
