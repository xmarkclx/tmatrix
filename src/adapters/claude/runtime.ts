import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { z } from "zod";
import { CGROUP_ENV, stopLeaseCgroup } from "../../conversation-cgroup.js";
import { LEASE_ENV, processStart, stopLeaseProcesses } from "../../conversation-recovery.js";
import { WorkerError } from "../../errors.js";
import type {
  AdapterContext, Input, RuntimeCreator, RuntimeThreadOptions, ThreadLike, WorkerThreadEvent
} from "../../runtime-adapter.js";
import { ClaudeProcess } from "./process.js";
import { modelProvider } from "../../runtime-routing.js";

const sessionIdSchema = z.uuid();
const eventHeader = z.looseObject({ type: z.string() });
const initSchema = z.object({ subtype: z.literal("init"), session_id: sessionIdSchema });
const assistantSchema = z.object({
  session_id: sessionIdSchema,
  message: z.object({ content: z.array(z.unknown()) })
});
const textBlock = z.object({ type: z.literal("text"), text: z.string() });
const toolBlock = z.object({ type: z.literal("tool_use"), name: z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/) });
const tokenCount = z.int().nonnegative().optional().catch(undefined);
const resultSchema = z.object({
  session_id: sessionIdSchema,
  is_error: z.boolean(),
  subtype: z.string(),
  result: z.string().optional(),
  structured_output: z.record(z.string(), z.unknown()).optional(),
  api_error_status: z.number().nullable().optional(),
  errors: z.array(z.string()).optional(),
  usage: z.object({
    input_tokens: tokenCount,
    output_tokens: tokenCount,
    cache_read_input_tokens: tokenCount,
    cache_creation_input_tokens: tokenCount
  }).optional()
});
type ClaudeResult = z.infer<typeof resultSchema>;
type TurnOptions = NonNullable<Parameters<ThreadLike["runStreamed"]>[1]>;

const imageTypes = new Map([
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
  [".gif", "image/gif"], [".webp", "image/webp"]
]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_TOTAL_BYTES = 7 * 1024 * 1024;

export function claudeModel(model: string): string {
  return modelProvider(model) === "codex" ? "sonnet" : model;
}

export function createClaudeRuntime(context: AdapterContext, executable: string): ReturnType<RuntimeCreator> {
  const environment: Record<string, string> = { ...context.environment, DISABLE_AUTOUPDATER: "1" };
  delete environment.CLAUDECODE;
  delete environment.API_KEY;
  const ownerToken = environment[LEASE_ENV] ?? "";
  const cgroup = environment[CGROUP_ENV];
  let threadClaimed = false;
  let current: ClaudeProcess | undefined;
  let closePromise: Promise<void> | undefined;

  async function close(): Promise<void> {
    try {
      await current?.stop();
    } finally {
      await confirmLeaseStopped(cgroup, ownerToken);
    }
  }

  function ensureOpen(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (closePromise) throw turnFailure("Claude Code runtime is closed");
  }

  function thread(options: RuntimeThreadOptions, savedId?: string): ThreadLike {
    if (threadClaimed) throw new Error("This Claude Code runtime already owns a conversation");
    threadClaimed = true;
    let sessionId = savedId ?? randomUUID();
    let resume = savedId !== undefined;
    let running = false;
    /** Open while the current process still reads stdin; each written message yields one result. */
    let inbox: { child: ClaudeProcess; pending: number } | undefined;

    async function steer(input: Input, turn: { signal?: AbortSignal } = {}): Promise<boolean> {
      if (!inbox) return false;
      const payload = await encodeInput(input, turn.signal);
      const target = inbox;
      if (!target || closePromise) return false;
      target.child.write(payload);
      target.pending += 1;
      return true;
    }

    async function* run(input: Input, turn: TurnOptions = {}): AsyncGenerator<WorkerThreadEvent> {
      if (closePromise || running) throw turnFailure("Claude Code runtime is unavailable");
      running = true;
      try {
        let result = yield* attempt(input, turn);
        if (result === "missing") {
          if (!turn.missingConversationInput) throw turnFailure("The saved Claude Code conversation could not be found");
          input = await turn.missingConversationInput();
          sessionId = randomUUID();
          resume = false;
          result = yield* attempt(input, turn);
        }
        if (result === "missing") throw turnFailure("Claude Code failed to start a new conversation");
        ensureOpen(turn.signal);
        const text = turn.outputSchema === undefined ? result.result
          : result.structured_output === undefined ? undefined : JSON.stringify(result.structured_output);
        if (text === undefined) throw turnFailure("Claude Code finished without a structured handoff");

        yield { type: "item.completed", item: { id: randomUUID(), type: "agent_message", text } };
        ensureOpen(turn.signal);
        const inputTokens = result.usage?.input_tokens ?? 0;
        const cachedTokens = result.usage?.cache_read_input_tokens ?? 0;
        const cacheWriteTokens = result.usage?.cache_creation_input_tokens ?? 0;
        yield {
          type: "turn.completed",
          usage: {
            input_tokens: inputTokens + cachedTokens + cacheWriteTokens,
            cached_input_tokens: cachedTokens,
            cache_write_input_tokens: cacheWriteTokens,
            output_tokens: result.usage?.output_tokens ?? 0,
            reasoning_output_tokens: 0
          }
        };
      } finally {
        running = false;
      }
    }

    async function* attempt(input: Input, turn: TurnOptions): AsyncGenerator<WorkerThreadEvent, ClaudeResult | "missing"> {
      ensureOpen(turn.signal);
      const payload = await encodeInput(input, turn.signal);
      ensureOpen(turn.signal);
      await turn.beforeStart?.();
      ensureOpen(turn.signal);

      try {
        current = new ClaudeProcess(executable, argumentsFor(options, sessionId, resume, turn), options.workingDirectory, environment);
      } catch {
        throw turnFailure("Unable to start Claude Code");
      }
      const child = current;
      const abort = () => { void child.stop().catch(() => undefined); };
      turn.signal?.addEventListener("abort", abort, { once: true });
      let connected = false;
      let result: ClaudeResult | undefined;
      const mailbox = { child, pending: 1 };
      try {
        ensureOpen(turn.signal);
        child.write(payload);
        for await (const line of child.lines) {
          ensureOpen(turn.signal);
          const event = decode(line);
          if (!event) continue;

          if (event.type === "system" && event.subtype === "init") {
            const init = initSchema.safeParse(event);
            if (!init.success || init.data.session_id !== sessionId) {
              throw turnFailure("Claude Code connected to an unexpected conversation");
            }
            if (connected) continue;
            connected = true;
            resume = true;
            inbox = mailbox;
            yield { type: "thread.started", thread_id: sessionId };
            ensureOpen(turn.signal);
            yield { type: "turn.started" };
          } else if (event.type === "assistant" && connected) {
            const assistant = assistantSchema.safeParse(event);
            if (assistant.success && assistant.data.session_id === sessionId) {
              yield* assistantActivity(assistant.data.message.content);
            }
          } else if (event.type === "result") {
            const parsed = resultSchema.safeParse(event);
            if (!parsed.success || parsed.data.session_id !== sessionId) {
              throw turnFailure("Claude Code returned an invalid result");
            }
            result = parsed.data;
            mailbox.pending -= 1;
            if (mailbox.pending <= 0 || result.is_error) {
              if (inbox === mailbox) inbox = undefined;
              child.endInput();
            }
          }
        }

        const exit = await child.exit;
        ensureOpen(turn.signal);
        if (exit.kind === "unavailable") {
          throw turnFailure("Claude Code could not start. Verify the Claude Code installation and working directory.");
        }
        if (!connected && resume && exit.code === 1 && result?.is_error === true &&
            result.subtype === "error_during_execution" &&
            result.errors?.includes(`No conversation found with session ID: ${sessionId}`)) {
          return "missing";
        }
        if (result?.api_error_status === 401 || result?.api_error_status === 403 ||
            result?.result === "Not logged in · Please run /login") {
          throw turnFailure("Claude Code authentication failed. Check the worker account's Claude Code sign-in or API credentials.");
        }
        if (exit.code !== 0 || child.inputFailed || result?.is_error) {
          throw turnFailure("Claude Code ended the turn with an error");
        }
        if (!connected || !result || result.subtype !== "success") {
          throw turnFailure("Claude Code ended the stream before completing the turn");
        }
        return result;
      } finally {
        if (inbox === mailbox) inbox = undefined;
        turn.signal?.removeEventListener("abort", abort);
        await child.stop();
        current = undefined;
      }
    }

    return { steer, async runStreamed(input, turn) { return { events: run(input, turn) }; } };
  }

  return {
    startThread: (options) => thread(options),
    resumeThread: (id, options) => {
      if (!sessionIdSchema.safeParse(id).success) throw turnFailure("The saved Claude Code conversation ID is invalid");
      return thread(options, id);
    },
    close: () => closePromise ??= close()
  };
}

/** Rejects unless every process in the worker's lease or cgroup is confirmed stopped. */
export async function confirmLeaseStopped(cgroup: string | undefined, ownerToken: string): Promise<void> {
  if (cgroup && !await stopLeaseCgroup(cgroup, ownerToken)) {
    throw new Error("Claude Code runtime cgroup shutdown could not be confirmed");
  }
  if (!cgroup && ownerToken && process.platform === "linux") {
    const startedAfter = await processStart(process.pid);
    if (!sessionIdSchema.safeParse(ownerToken).success || !startedAfter ||
        !await stopLeaseProcesses(ownerToken, undefined, startedAfter)) {
      throw new Error("Claude Code runtime lease shutdown could not be confirmed");
    }
  }
}

function argumentsFor(options: RuntimeThreadOptions, id: string, resume: boolean, turn: TurnOptions): string[] {
  return [
    "--print", "--verbose",
    "--input-format", "stream-json", "--output-format", "stream-json",
    "--permission-mode", "bypassPermissions",
    "--model", claudeModel(options.model),
    "--effort", options.modelReasoningEffort === "ultra" ? "max" : options.modelReasoningEffort,
    ...(resume ? ["--resume", id] : ["--session-id", id, `--name=${options.threadName}`]),
    ...(turn.outputSchema === undefined ? [] : ["--json-schema", JSON.stringify(turn.outputSchema)])
  ];
}

function decode(line: string): z.infer<typeof eventHeader> | undefined {
  try {
    const event = eventHeader.safeParse(JSON.parse(line));
    return event.success ? event.data : undefined;
  } catch {
    return undefined;
  }
}

export function* assistantActivity(blocks: unknown[]): Iterable<WorkerThreadEvent> {
  for (const block of blocks) {
    const text = textBlock.safeParse(block);
    if (text.success && text.data.text.trim()) {
      yield { type: "local.activity", kind: "claude.assistant", text: text.data.text };
      continue;
    }
    const tool = toolBlock.safeParse(block);
    if (tool.success && tool.data.name !== "StructuredOutput") {
      yield { type: "local.activity", kind: "claude.tool", text: tool.data.name };
    }
  }
}

async function encodeInput(input: Input, signal?: AbortSignal): Promise<string> {
  const message = (content: unknown) => JSON.stringify({
    type: "user", message: { role: "user", content }, session_id: "", parent_tool_use_id: null
  }) + "\n";
  if (typeof input === "string") return message(input);

  const content: unknown[] = [];
  let bytesRemaining = MAX_IMAGE_TOTAL_BYTES;
  for (const entry of input) {
    if (entry.type === "text") {
      content.push(entry);
      continue;
    }
    const mediaType = imageTypes.get(extname(entry.path).toLowerCase());
    const bytes = mediaType ? await readFile(entry.path, { signal }).catch(() => undefined) : undefined;
    signal?.throwIfAborted();
    if (!mediaType || !bytes?.length || bytes.length > Math.min(MAX_IMAGE_BYTES, bytesRemaining)) {
      throw new WorkerError({
        code: "CLAUDE_ATTACHMENT_INVALID", stage: "claude.input",
        message: "Claude Code could not read an attached image or its image size limit was exceeded. Use smaller PNG, JPEG, GIF or WebP images and retry."
      });
    }
    bytesRemaining -= bytes.length;
    content.push({ type: "image", source: { type: "base64", media_type: mediaType, data: bytes.toString("base64") } });
  }
  return message(content);
}

export function turnFailure(message: string): WorkerError {
  return new WorkerError({ message, code: "CLAUDE_TURN_FAILED", stage: "claude.turn" });
}
