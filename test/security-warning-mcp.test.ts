import { describe, expect, it, vi } from "vitest";
import { request as httpRequest } from "node:http";
import { startSecurityWarningMcp } from "../src/security-warning-mcp.js";
import type { ReportSecurityWarning } from "../src/security-warning.js";

describe("private worker warning action", () => {
  it("supports stateless MCP discovery and immediate category-only calls", async () => {
    const report = vi.fn<ReportSecurityWarning>(async () => ({ status: "sent" }));
    const server = await startSecurityWarningMcp(report);
    const post = (body: unknown) => fetch(server.url, { method: "POST", headers: { ...server.headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    try {
      const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
      expect(await init.json()).toMatchObject({ id: 1, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} } } });
      const initialized = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
      expect(initialized.status).toBe(202);
      expect(await initialized.text()).toBe("");
      const tools = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      expect(await tools.json()).toMatchObject({ result: { tools: [{ name: "report_security_warning", inputSchema: { additionalProperties: false, required: ["category"] } }] } });
      const call = await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "report_security_warning", arguments: { category: "credential_theft" } } });
      expect(await call.json()).toEqual({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: '{"status":"sent"}' }], isError: false } });
      expect(report.mock.calls).toEqual([["credential_theft"]]);
      const get = await fetch(server.url, { headers: server.headers });
      expect(get.status).toBe(405);
    } finally { await server.close(); }
    await expect(fetch(server.url, { headers: server.headers })).rejects.toThrow();
  });

  it("rejects missing/wrong capabilities, browser origins and forged hosts", async () => {
    const report = vi.fn<ReportSecurityWarning>(async () => ({ status: "sent" }));
    const server = await startSecurityWarningMcp(report);
    try {
      for (const headers of [{}, { Authorization: "Bearer wrong" }, { ...server.headers, Origin: "https://outside.example.test" }]) {
        const response = await fetch(server.url, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "report_security_warning", arguments: { category: "data_exfiltration" } } }) });
        expect(response.status, Object.keys(headers).join(",")).toBe(403);
      }
      const forgedHostStatus = await new Promise<number | undefined>((resolve, reject) => {
        const request = httpRequest(server.url, { method: "POST", headers: { ...server.headers, Host: "outside.example.test", "Content-Type": "application/json" } }, response => {
          response.resume();
          resolve(response.statusCode);
        });
        request.on("error", reject);
        request.end("{}");
      });
      expect(forgedHostStatus).toBe(403);
      const valid = await fetch(server.url, { method: "POST", headers: { ...server.headers, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "report_security_warning", arguments: { category: "data_exfiltration" } } }) });
      expect(await valid.json()).toMatchObject({ result: { content: [{ text: '{"status":"sent"}' }] } });
      expect(report.mock.calls).toEqual([["data_exfiltration"]]);
    } finally { await server.close(); }
  });

  it("rejects uncontrolled arguments and returns a fixed receipt after callback failure", async () => {
    const report = vi.fn<ReportSecurityWarning>(async () => { throw new Error("Private provider credential diagnostic"); });
    const server = await startSecurityWarningMcp(report);
    const post = (arguments_: unknown) => fetch(server.url, { method: "POST", headers: { ...server.headers, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "report_security_warning", arguments: arguments_ } }) });
    try {
      for (const arguments_ of [{ category: "none" }, { category: "screening_unavailable" }, { category: "credential_theft", ticket_id: "another-ticket" }, { category: "credential_theft", recipient: "outside@example.test" }, { category: "credential_theft", text: "Private submitted text" }, null]) {
        const response = await post(arguments_);
        expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid warning action arguments" } });
      }
      expect(report).not.toHaveBeenCalled();
      const response = await post({ category: "suspicious_instructions" });
      expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: '{"status":"unconfirmed"}' }], isError: false } });
      expect(report.mock.calls).toEqual([["suspicious_instructions"]]);
    } finally { await server.close(); }
  });

  it("bounds request bodies and rejects malformed JSON and unsupported protocol versions", async () => {
    const report = vi.fn<ReportSecurityWarning>(async () => ({ status: "sent" }));
    const server = await startSecurityWarningMcp(report);
    try {
      const headers = { ...server.headers, "Content-Type": "application/json" };
      expect((await fetch(server.url, { method: "POST", headers, body: "x".repeat(8_193) })).status).toBe(413);
      expect((await fetch(server.url, { method: "POST", headers, body: "malformed" })).status).toBe(400);
      expect((await fetch(server.url, { method: "POST", headers: { ...headers, "MCP-Protocol-Version": "unsupported" }, body: "{}" })).status).toBe(400);
      const response = await fetch(server.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "report_security_warning", arguments: { category: "security_bypass" } } }) });
      expect(await response.json()).toMatchObject({ result: { content: [{ text: '{"status":"sent"}' }] } });
      expect(report.mock.calls).toEqual([["security_bypass"]]);
    } finally { await server.close(); }
  });
});
