import type { Ticket } from "../types.js";

/** Uses the task's requested chat title, then stable task/ticket fallbacks. */
export function workerTitle(ticket: Ticket): string {
  const requested = ticket.instructions.match(
    /^Title this LLM chat as `([^`\r\n]+)`\.\s*$/m
  )?.[1]?.trim();
  const fallback = ticket.task_id !== undefined
    ? `TASK-${ticket.task_id}`
    : `Tzu Do ${ticket.ticket_id}`;
  return (requested || fallback).replace(/[\r\n]+/g, " ").trim().slice(0, 240);
}
