import { z } from "zod";
import { externalIdSchema } from "./identity-transport.js";

export const executionModeSchema = z.enum(["FAST", "NORMAL", "HIGH"]);
export const modelSchema = z.string()
  .trim()
  .min(1)
  .max(255)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/,
    "Model must be a valid model identifier"
  );
export const reasoningEffortSchema = z.enum([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra"
]);
export const serviceTierSchema = z.enum(["default", "priority"]);

const executionProfileShape = {
  execution_mode: executionModeSchema,
  model: modelSchema,
  reasoning_effort: reasoningEffortSchema,
  service_tier: serviceTierSchema
};

const optionalExecutionProfileShape = {
  execution_mode: executionModeSchema.optional(),
  model: modelSchema.optional(),
  reasoning_effort: reasoningEffortSchema.optional(),
  service_tier: serviceTierSchema.optional()
};

export const conversationReferenceSchema = z.object({
  thread_id: z.string().trim().min(1).max(255),
  runtime: z.string().trim().min(1).max(64),
  scope: z.string().trim().min(1).max(128)
});
export type ConversationReference = z.infer<typeof conversationReferenceSchema>;

const ticketContextShape = {
  conversation: conversationReferenceSchema.nullable().optional(),
  task_id: externalIdSchema.optional(),
  input_revision: z.number().int().nonnegative().optional(),
  project_path: z.string().optional(),
  trigger_comment_id: externalIdSchema.nullable().optional(),
  thread_anchor_comment_id: externalIdSchema.nullable().optional()
};

export const ticketEndpointsSchema = z.object({
  mark_taken: z.string().min(1),
  progress: z.string().min(1),
  history: z.string().min(1),
  result: z.string().min(1)
});

export const ticketSchema = z.object({
  ticket_id: z.string().min(1),
  worker_id: z.string().min(1),
  instructions: z.string().min(1),
  endpoints: ticketEndpointsSchema,
  ...executionProfileShape,
  ...ticketContextShape
}).passthrough();

export const ownedTicketSchema = z.object({
  ticket_id: z.string().min(1),
  worker_id: z.string().min(1),
  instructions: z.string().min(1).optional(),
  endpoints: ticketEndpointsSchema.optional(),
  ...optionalExecutionProfileShape,
  ...ticketContextShape
}).passthrough();

export const steeringEventSchema = z.object({
  worker_id: z.string().min(1),
  input_revision: z.number().int().nonnegative(),
  content: z.string().min(1),
  trigger_comment_id: externalIdSchema.nullable().optional()
}).passthrough();

/** Durable user cancellation delivered through both polling and push control. */
export const cancellationRequestSchema = z.object({
  event_id: z.string().min(1),
  ticket_id: z.string().min(1),
  worker_id: z.string().min(1),
  requested_at: z.iso.datetime(),
  acknowledge: z.string().min(1)
}).passthrough();

export const pollResponseSchema = z.object({
  new_tickets: z.array(ticketSchema).default([]),
  owned_in_progress: z.array(ownedTicketSchema).default([]),
  steering_events: z.array(steeringEventSchema).default([]),
  cancellation_requests: z.array(cancellationRequestSchema).default([]),
  control_url: z.string().min(1).optional()
}).passthrough();

export type TicketEndpoints = z.infer<typeof ticketEndpointsSchema>;
export type ExecutionMode = z.infer<typeof executionModeSchema>;
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
export type ServiceTier = z.infer<typeof serviceTierSchema>;
export type Ticket = z.infer<typeof ticketSchema>;
export type ExecutionProfile = Readonly<Pick<
  Ticket,
  "execution_mode" | "model" | "reasoning_effort" | "service_tier"
>>;
export type OwnedTicket = z.infer<typeof ownedTicketSchema>;
export type SteeringEvent = z.infer<typeof steeringEventSchema>;
export type CancellationRequest = z.infer<typeof cancellationRequestSchema>;
export type PollResponse = z.infer<typeof pollResponseSchema>;

export function isRecoverableOwnedTicket(ticket: OwnedTicket): ticket is Ticket {
  return typeof ticket.instructions === "string" &&
    ticket.endpoints !== undefined &&
    ticket.execution_mode !== undefined &&
    ticket.model !== undefined &&
    ticket.reasoning_effort !== undefined &&
    ticket.service_tier !== undefined;
}

export interface PollRequest {
  poll_id: string;
  instance_id: string;
  swarm_id?: string;
  available_slots: number;
}

export interface ProgressEvent {
  sequence: number;
  occurred_at: string;
  kind: string;
  input_revision: number;
  summary: Record<string, unknown>;
}

export interface UsageSummary {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

export interface TicketResult {
  status: "completed" | "failed";
  input_revision: number;
  outcome?: "AI_DONE" | "AI_NEEDS_FEEDBACK";
  context_summary?: string;
  user_message?: string;
  final_response?: string;
  error?: {
    code: string;
    message: string;
    stage: string;
    retryable: boolean;
  };
  thread_id?: string;
  conversation?: ConversationReference;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  usage?: UsageSummary;
}
