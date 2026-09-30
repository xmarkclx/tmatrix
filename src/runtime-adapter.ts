/** TMatrix adapter API v1. No provider SDK is required to implement this contract. */
import type { Logger } from "pino";
import type { ExecutionProfile, ReasoningEffort, ServiceTier } from "./types.js";

export type UserInput = { type: "text"; text: string } | { type: "local_image"; path: string };
export type Input = string | UserInput[];
export interface Usage {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}
export interface DetailedFileChange { path: string; kind: "add" | "delete" | "update"; diff?: string }
export interface DetailedFileChangeItem {
  id: string; type: "file_change"; changes: DetailedFileChange[]; status: "completed" | "failed";
}
export type WorkerThreadItem =
  | { id: string; type: "agent_message" | "reasoning"; text: string }
  | { id: string; type: "command_execution"; command: string; aggregated_output: string; exit_code?: number; status: "in_progress" | "completed" | "failed" }
  | DetailedFileChangeItem
  | { id: string; type: "mcp_tool_call"; server: string; tool: string; arguments: unknown; result?: { content: unknown[]; structured_content: unknown; _meta?: unknown }; error?: { message: string }; status: "in_progress" | "completed" | "failed" }
  | { id: string; type: "web_search"; query: string }
  | { id: string; type: "todo_list"; items: { text: string; completed: boolean }[] }
  | { id: string; type: "error"; message: string };
export type WorkerThreadEvent =
  | { type: "thread.started"; thread_id: string }
  | { type: "turn.started" }
  | { type: "turn.completed"; usage: Usage }
  | { type: "turn.failed"; error: { message: string } }
  | { type: "item.started" | "item.updated" | "item.completed"; item: WorkerThreadItem }
  | { type: "error"; message: string }
  | { type: "local.activity"; kind: string; text: string };
export interface StreamedTurnLike { events: AsyncGenerator<WorkerThreadEvent> }
export interface ThreadLike {
  runStreamed(input: Input, options?: {
    outputSchema?: unknown;
    signal?: AbortSignal;
    /** Use only after confirmed conversation loss, never on transient failures. */
    missingConversationInput?: () => Promise<Input>;
  }): Promise<StreamedTurnLike>;
}
export interface RuntimeThreadOptions {
  model: string;
  modelReasoningEffort: ReasoningEffort;
  serviceTier: ServiceTier;
  workingDirectory: string;
  sandboxMode: "danger-full-access";
  approvalPolicy: "never";
  networkAccessEnabled: true;
  threadName: string;
}
export interface RuntimeLike {
  startThread(options: RuntimeThreadOptions): ThreadLike;
  resumeThread?(threadId: string, options: RuntimeThreadOptions): ThreadLike;
  close?(): Promise<void>;
}
export type RuntimeFactory = (profile: ExecutionProfile) => RuntimeLike;
export interface AdapterContext {
  /** Sanitized child environment. Never pass the queue's API_KEY to a harness. */
  environment: Record<string, string>;
  logger: Pick<Logger, "warn" | "error">;
}
export interface RuntimeAdapter {
  apiVersion: 1;
  /** Stable provider/account-history identity; lowercase letters, digits and hyphens. */
  id: string;
  /** Fresh isolated runtime for each ticket. Defer process startup to runStreamed. */
  create(context: AdapterContext, profile: ExecutionProfile): RuntimeLike & {
    /** Resolve only after all owned execution has stopped; reject if uncertain. */
    close(): Promise<void>;
  };
}
