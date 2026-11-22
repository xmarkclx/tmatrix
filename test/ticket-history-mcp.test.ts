import { describe, expect, it, vi } from "vitest";
import { AppServerCodex } from "../src/adapters/codex/app-server.js";
import type { TicketHistoryReader } from "../src/helpers/ticket-history.js";
import * as historyMcp from "../src/ticket-history-mcp.js";

const sourceCommentId = "9223372036854775807";
const continuation = { comment: null, continuation_context: { sourceCommentId, content: "Use the previously created branch." } };
const index = { comments: [{ id: sourceCommentId, replyToCommentId: null,
  authorName: "Fixture", isAI: true, createdAt: "2026-11-22T00:00:00.000Z" }], next_before_comment_id: null };

describe("private ticket history lookup", () => {
  it("discovers the tool and reads index pages and exact string IDs", async () => {
    const read = vi.fn<TicketHistoryReader>(query => "comment_id" in query ? continuation : index);
    const server = await historyMcp.startTicketHistoryMcp(read);
    const post = (body: unknown) => fetch(server.url, { method: "POST", headers: { ...server.headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    try {
      const tools = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect(await tools.json()).toMatchObject({ result: { tools: [{ name: "read_ticket_history",
        inputSchema: { type: "object", additionalProperties: false } }] } });
      const cases: Array<[Parameters<TicketHistoryReader>[0], ReturnType<TicketHistoryReader>]> = [
        [{}, index], [{ before_comment_id: sourceCommentId }, index], [{ comment_id: sourceCommentId }, continuation],
        [{ comment_id: "01a1323b-377b-7a34-9abe-c68728fe1b4d" }, continuation]
      ];
      for (const [query, expected] of cases) {
        const response = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_ticket_history", arguments: query } });
        expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 2,
          result: { content: [{ type: "text", text: JSON.stringify(expected) }], isError: false } });
      }
      const withoutArguments = await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read_ticket_history" } });
      expect(await withoutArguments.json()).toEqual({ jsonrpc: "2.0", id: 3,
        result: { content: [{ type: "text", text: JSON.stringify(index) }], isError: false } });
      expect(read.mock.calls).toEqual([[{}], [{ before_comment_id: sourceCommentId }], [{ comment_id: sourceCommentId }],
        [{ comment_id: "01a1323b-377b-7a34-9abe-c68728fe1b4d" }], [{}]]);
    } finally { await server.close(); }
    await expect(fetch(server.url, { headers: server.headers })).rejects.toThrow();
  });

  it("rejects numeric identities, ambiguous arguments and unscoped lookups before reading", async () => {
    const read = vi.fn<TicketHistoryReader>(() => continuation);
    const server = await historyMcp.startTicketHistoryMcp(read);
    try {
      for (const query of [{ comment_id: 42 }, { comment_id: "042" }, { comment_id: "42 " },
        { comment_id: "9223372036854775808" }, { before_comment_id: null },
        { comment_id: "42", before_comment_id: "41" }, { task_id: "other-task" },
        { url: "https://outside.example.test" }, { comment_id: "42", text: "Extra content" }]) {
        const response = await fetch(server.url, { method: "POST", headers: { ...server.headers, "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_ticket_history", arguments: query } }) });
        expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 1,
          error: { code: -32602, message: "Invalid ticket history arguments" } });
      }
      expect(read).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it("keeps capabilities separate and closes a prepared server without starting Codex", async () => {
    const first = new AppServerCodex({ environment: {} });
    const second = new AppServerCodex({ environment: {} });
    const readFirst = vi.fn<TicketHistoryReader>(() => continuation);
    const readSecond = vi.fn<TicketHistoryReader>(() => index);
    try {
      expect(await first.prepareTicketHistory(readFirst)).toBe(true);
      expect(await second.prepareTicketHistory(readSecond)).toBe(true);
      const firstConfiguration = (await first.mcpServers()).tmatrix_ticket_history;
      const secondConfiguration = (await second.mcpServers()).tmatrix_ticket_history;
      if (!firstConfiguration || !secondConfiguration) throw new Error("Fixture history server was not prepared");
      expect(firstConfiguration.required).toBe(true);
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_ticket_history", arguments: {} } });
      const rejected = await fetch(firstConfiguration.url, { method: "POST", headers: { ...secondConfiguration.http_headers, "Content-Type": "application/json" }, body });
      expect(rejected.status).toBe(403);
      expect(readFirst).not.toHaveBeenCalled();
      const response = await fetch(secondConfiguration.url, { method: "POST", headers: { ...secondConfiguration.http_headers, "Content-Type": "application/json" }, body });
      expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 1,
        result: { content: [{ type: "text", text: JSON.stringify(index) }], isError: false } });
      await second.close();
      await expect(fetch(secondConfiguration.url, { headers: secondConfiguration.http_headers })).rejects.toThrow();
    } finally { await first.close(); await second.close(); }
  });

  it("returns false on startup failure without exposing the failure detail", async () => {
    const start = vi.spyOn(historyMcp, "startTicketHistoryMcp").mockRejectedValueOnce(new Error("Private startup diagnostic"));
    const logger = { warn: vi.fn(), error: vi.fn() };
    const runtime = new AppServerCodex({ environment: {}, logger });
    try {
      expect(await runtime.prepareTicketHistory(() => continuation)).toBe(false);
      expect(await runtime.mcpServers()).toEqual({});
      expect(logger.warn.mock.calls).toEqual([[{ event: "ticket.history_action_unavailable" }, "Ticket history lookup unavailable; retaining full input"]]);
    } finally { start.mockRestore(); await runtime.close(); }
  });
});
