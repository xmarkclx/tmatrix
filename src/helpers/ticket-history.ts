import { z } from "zod";
import { stripConversationReference } from "../conversation-store.js";
import { externalIdSchema } from "../identity-transport.js";
import type { Ticket } from "../types.js";
import { commentBlock, historyRecord, replaceCommentHistory } from "./serialize-prompt-history.js";

const id = externalIdSchema.transform(String);
const comment = z.strictObject({
  id,
  taskId: id,
  replyToCommentId: id.nullable(),
  authorName: z.string(),
  content: z.string(),
  isAI: z.boolean(),
  apiKeyName: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});
const checkpoint = z.strictObject({ sourceCommentId: id, content: z.string() });
const snapshot = z.object({
  ticket_id: z.string(),
  worker_id: z.string(),
  input_revision: z.number(),
  task: z.object({ id }),
  comments: z.array(comment),
  inherited_context: checkpoint.nullable()
});
const PAGE_SIZE = 20;

type Comment = Omit<z.infer<typeof comment>, "taskId" | "apiKeyName">;
type Checkpoint = z.infer<typeof checkpoint>;
type CommentIndexEntry = Omit<Comment, "content" | "updatedAt">;
type TicketHistoryResult =
  | { comment: Comment | null; continuation_context: Checkpoint | null }
  | { comments: CommentIndexEntry[]; next_before_comment_id: string | null }
  | { error: "Unknown comment ID for this task." };

export type TicketHistoryReader = (query: { comment_id: string } | { before_comment_id?: string }) => TicketHistoryResult;

type TicketHistory = {
  read: TicketHistoryReader;
  deferred?: { instructions: string; history: Record<string, unknown> };
};

export function prepareTicketHistory(ticket: Ticket, history: unknown): TicketHistory | undefined {
  const parsed = snapshot.safeParse(history);
  if (!parsed.success) return undefined;
  const data = parsed.data;
  if (data.ticket_id !== ticket.ticket_id || data.worker_id !== ticket.worker_id || data.input_revision !== ticket.input_revision ||
      data.task.id !== String(ticket.task_id) || data.comments.some(entry => entry.taskId !== data.task.id)) return undefined;

  const entries: Comment[] = data.comments.map(({ id, replyToCommentId, authorName, content, isAI, createdAt, updatedAt }) => ({
    id, replyToCommentId, authorName, content, isAI, createdAt, updatedAt
  }));
  const positions = new Map(entries.map((entry, index) => [entry.id, index]));
  const saved = data.inherited_context;
  if (positions.size !== entries.length || (!entries.length && !saved)) return undefined;

  const read: TicketHistoryReader = query => {
    if ("comment_id" in query) {
      const index = positions.get(query.comment_id);
      const visible = index === undefined ? null : entries[index] ?? null;
      const continuation = saved?.sourceCommentId === query.comment_id
        ? { ...saved, content: stripConversationReference(saved.content) } : null;
      return visible || continuation ? { comment: visible, continuation_context: continuation }
        : { error: "Unknown comment ID for this task." };
    }
    const end = query.before_comment_id ? positions.get(query.before_comment_id) : entries.length;
    if (end === undefined) return { error: "Unknown comment ID for this task." };
    const start = Math.max(0, end - PAGE_SIZE);
    const comments = entries.slice(start, end).reverse().map(({ id, replyToCommentId, authorName, isAI, createdAt }) => ({
      id, replyToCommentId, authorName, isAI, createdAt
    }));
    return { comments, next_before_comment_id: start > 0 ? entries[start]?.id ?? null : null };
  };

  if (entries.some(entry => entry.content.includes("![")) || saved?.content.includes("![")) return { read };
  const projected = historyRecord(history);
  if (!projected) return { read };
  const replacement = [
    "# Ticket history lookup",
    `Use \`read_ticket_history\` with \`comment_id\` to read one older comment. Call it without arguments to find recent comment IDs. Use \`before_comment_id\` to list the next page. This history is from input revision ${data.input_revision}. Follow any newer human instructions.`,
    saved ? `The saved continuation is attached to comment #${saved.sourceCommentId}. Read it before acting on prior work if the summary is missing from this conversation. If lookup fails, report the blocker before repeating prior actions.` : null
  ].filter(Boolean).join("\n\n");
  const instructions = replaceCommentHistory(ticket.instructions, {
    rendered: entries.length ? entries.map(commentBlock).join("\n\n") : "_No comments yet._",
    replacement
  });
  if (instructions === undefined) return { read };
  delete projected.comments;
  delete projected.inherited_context;
  return { read, deferred: { instructions, history: projected } };
}
