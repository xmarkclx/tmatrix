import type { Ticket } from "../types.js";

/** Use only an identified triggering comment; legacy payloads retain full context. */
export function buildCommentPrompt(ticket: Ticket, history: unknown): string | undefined {
  if (!history || typeof history !== "object" || !ticket.trigger_comment_id) return undefined;
  const record = history as Record<string, unknown>;
  const trigger = record.trigger_comment;
  if (!trigger || typeof trigger !== "object") return undefined;
  const comment = trigger as Record<string, unknown>;
  if (comment.id !== ticket.trigger_comment_id || typeof comment.content !== "string") return undefined;
  if (record.input_revision !== undefined && record.input_revision !== ticket.input_revision) return undefined;
  return comment.content;
}
