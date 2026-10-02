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
  | { id: string; type: "agent_message"; text: string }
  /** Provider-authored summary only; never raw hidden reasoning. */
  | { id: string; type: "reasoning"; text: string }
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
    /** Use after confirmed conversation loss or an explicit resume rejection during crash recovery. */
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
  /** Set only after the task lease was safely recovered from a dead owner. */
  rebuildOnResumeRejection?: boolean;
}
export interface RuntimeLike {
  startThread(options: RuntimeThreadOptions): ThreadLike;
  resumeThread?(threadId: string, options: RuntimeThreadOptions): ThreadLike;
  close?(): Promise<void>;
}
export type RuntimeFactory = (profile: ExecutionProfile, leaseEnvironment?: Record<string, string>) => RuntimeLike;
export interface AdapterContext {
  /** Sanitized child environment. Never pass the queue's API_KEY to a harness. */
  environment: Record<string, string>;
  logger: Pick<Logger, "warn" | "error">;
}
export type RuntimeCreator = (context: AdapterContext, profile: ExecutionProfile) => RuntimeLike & {
  /** Resolve only after all owned execution has stopped; reject if uncertain. */
  close(): Promise<void>;
};
export interface AdapterUpdateState {
  status: "idle" | "checking" | "installing" | "verifying" | "updated" | "up_to_date" | "failed" | "disabled";
  current_version: string;
  previous_version?: string;
  latest_version?: string;
  blocked_version?: string;
  last_checked_at?: string;
  next_check_at?: string;
  /** True only while a rollback target is available; rollback() is also required. */
  can_rollback?: boolean;
  /** A safe operator-facing summary, never raw provider output or credentials. */
  error?: string;
}
export interface AdapterUpdates {
  /** Human-readable runtime name, e.g. "Codex CLI". */
  displayName: string;
  snapshot(): AdapterUpdateState;
  /** Schedule background checks; do not wait for network requests here. */
  start(): void | Promise<void>;
  /** Abort update work only. This must never stop an active worker. */
  close(): Promise<void>;
  checkNow(): Promise<void>;
  rollback?(): Promise<void>;
}
export interface AdapterUpdateStatus extends AdapterUpdateState {
  adapter_id: string;
  display_name: string;
  can_rollback: boolean;
}
export interface AdapterUpdateControl {
  snapshot(): AdapterUpdateStatus;
  checkNow(): Promise<void>;
  rollback?(): Promise<void>;
}
export interface AdapterSetupContext extends AdapterContext {
  /** Private per-instance/per-adapter store outside engine/release directories. */
  updateDirectory: string;
}
export interface AdapterSetup {
  /** Bound to this engine instance, with a fresh context supplied for each worker. */
  create: RuntimeCreator;
  updates?: AdapterUpdates;
}
export interface RuntimeAdapter {
  apiVersion: 1;
  /** Stable provider/account-history identity; lowercase letters, digits and hyphens. */
  id: string;
  /** Fresh isolated runtime for each ticket. Defer process startup to runStreamed. */
  create: RuntimeCreator;
  /**
   * Optional local initialization, once per engine. Own provider update setup,
   * version selection and pinning here; defer network work to updates.start().
   * If setup throws, clean up partial resources before returning control.
   * The engine falls back to create() so update failures do not block workers.
   */
  setup?(context: AdapterSetupContext): AdapterSetup | Promise<AdapterSetup>;
}
