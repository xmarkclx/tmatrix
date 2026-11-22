import { z } from "zod";
import type { TicketHistoryReader } from "./helpers/ticket-history.js";
import { externalIdSchema } from "./identity-transport.js";
import { startLocalMcp, type LocalMcpServer } from "./local-mcp.js";

const commentId = z.string().refine(value => externalIdSchema.safeParse(value).success, "Invalid comment ID");
const argumentsSchema = z.union([
  z.object({ comment_id: commentId }).strict(),
  z.object({ before_comment_id: commentId.optional() }).strict().transform(query =>
    query.before_comment_id === undefined ? {} : { before_comment_id: query.before_comment_id })
]).default({});

export function startTicketHistoryMcp(read: TicketHistoryReader): Promise<LocalMcpServer> {
  return startLocalMcp({
    name: "tmatrix-ticket-history",
    tool: {
      name: "read_ticket_history",
      description: "Read this task's older public comments and selected continuation context. Call without arguments to list recent comment IDs. Use before_comment_id to list the next page, or comment_id to read one comment and its attached continuation. IDs must be exact strings. This tool cannot read other tasks.",
      inputSchema: {
        type: "object",
        properties: {
          comment_id: { type: "string", description: "Exact comment ID to read. Omit before_comment_id." },
          before_comment_id: { type: "string", description: "Read the next index page before this comment ID. Omit comment_id." }
        },
        additionalProperties: false
      }
    },
    argumentsSchema,
    call: read,
    errors: {
      unavailable: "Ticket history unavailable",
      shutdown: "Ticket history shutdown failed",
      arguments: "Invalid ticket history arguments"
    }
  });
}
