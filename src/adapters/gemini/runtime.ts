import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { z } from "zod";
import { CGROUP_ENV } from "../../conversation-cgroup.js";
import { LEASE_ENV } from "../../conversation-recovery.js";
import { WorkerError } from "../../errors.js";
import type {
  AdapterContext, Input, RuntimeCreator, RuntimeThreadOptions, ThreadLike, WorkerThreadEvent
} from "../../runtime-adapter.js";
import { confirmLeaseStopped, RuntimeProcess } from "../process.js";

const runtimeName = "Antigravity CLI";
const INIT_TIMEOUT_MS = 60_000;
const conversationId = z.uuid();
const eventHeader = z.looseObject({ event: z.string() });
const initEvent = z.object({
  conversation_id: conversationId,
  init: z.object({ model: z.string() })
});
const tokenCount = z.int().nonnegative().optional();
const resultEvent = z.object({
  result: z.object({
    conversation_id: conversationId.or(z.literal("")),
    status: z.string(),
    response: z.string(),
    error: z.string().optional(),
    structured_output: z.record(z.string(), z.unknown()).optional(),
    usage: z.object({
      input_tokens: tokenCount,
      cache_read_tokens: tokenCount,
      output_tokens: tokenCount,
      thinking_tokens: tokenCount
    }).optional()
  })
});
type Result = z.infer<typeof resultEvent>["result"];
type PreparedInput = { payload: string; directory?: string };
type TurnOptions = NonNullable<Parameters<ThreadLike["runStreamed"]>[1]>;

export function createGeminiRuntime(context: AdapterContext, executable: string): ReturnType<RuntimeCreator> {
  const environment = { ...context.environment };
  delete environment.API_KEY;
  let claimed = false;
  let current: RuntimeProcess | undefined;
  let closePromise: Promise<void> | undefined;

  async function close(): Promise<void> {
    try {
      await current?.stop();
    } finally {
      await confirmLeaseStopped(environment[CGROUP_ENV], environment[LEASE_ENV] ?? "", runtimeName);
    }
  }

  function ensureOpen(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (closePromise) throw turnFailure("Antigravity CLI runtime is closed");
  }

  function thread(options: RuntimeThreadOptions, savedId?: string): ThreadLike {
    if (claimed) throw turnFailure("This Antigravity CLI runtime already owns a conversation");
    claimed = true;
    let id = savedId;
    let running = false;

    async function* run(input: Input, turn: TurnOptions = {}): AsyncGenerator<WorkerThreadEvent> {
      if (running) throw turnFailure("An Antigravity CLI turn is already running");
      running = true;
      try {
        let result = yield* attempt(input, turn);
        if (result === "missing") {
          ensureOpen(turn.signal);
          if (!turn.missingConversationInput) throw turnFailure("The saved Antigravity conversation could not be found");
          input = await turn.missingConversationInput();
          id = undefined;
          result = yield* attempt(input, turn);
        }
        if (result === "missing") throw turnFailure("Antigravity CLI failed to start a new conversation");
        const text = turn.outputSchema === undefined
          ? result.response
          : result.structured_output === undefined ? undefined : JSON.stringify(result.structured_output);
        if (!text?.trim()) throw turnFailure("Antigravity CLI finished without a complete handoff");

        ensureOpen(turn.signal);
        yield { type: "item.completed", item: { id: randomUUID(), type: "agent_message", text } };
        ensureOpen(turn.signal);
        yield {
          type: "turn.completed",
          usage: {
            input_tokens: result.usage?.input_tokens ?? 0,
            cached_input_tokens: result.usage?.cache_read_tokens ?? 0,
            cache_write_input_tokens: 0,
            output_tokens: result.usage?.output_tokens ?? 0,
            reasoning_output_tokens: result.usage?.thinking_tokens ?? 0
          }
        };
      } finally {
        running = false;
      }
    }

    async function* attempt(input: Input, turn: TurnOptions): AsyncGenerator<WorkerThreadEvent, Result | "missing"> {
      ensureOpen(turn.signal);
      const prepared = await prepareInput(input, turn.signal);
      try {
        return yield* runProcess(prepared, turn);
      } finally {
        if (prepared.directory) await rm(prepared.directory, { recursive: true, force: true });
      }
    }

    async function* runProcess(input: PreparedInput, turn: TurnOptions): AsyncGenerator<WorkerThreadEvent, Result | "missing"> {
      ensureOpen(turn.signal);

      const requestedId = id;
      try {
        current = new RuntimeProcess(executable, argumentsFor(options, requestedId, turn, input.directory), options.workingDirectory, environment, runtimeName);
      } catch {
        throw launchFailure();
      }
      const child = current;
      const abort = () => { void child.stop().catch(() => undefined); };
      turn.signal?.addEventListener("abort", abort, { once: true });
      let startupExpired = false;
      const startupTimer = setTimeout(() => {
        startupExpired = true;
        abort();
      }, INIT_TIMEOUT_MS);
      let connected = false;
      let result: Result | undefined;
      try {
        for await (const line of child.lines) {
          ensureOpen(turn.signal);
          const event = decode(line);
          if (!event) continue;

          if (event.event === "init") {
            const init = initEvent.safeParse(event);
            if (connected || result || !init.success || init.data.init.model !== options.model) {
              throw turnFailure("Antigravity CLI initialized with unexpected conversation metadata");
            }
            clearTimeout(startupTimer);
            if (requestedId && init.data.conversation_id !== requestedId) return "missing";

            id = init.data.conversation_id;
            connected = true;
            yield { type: "thread.started", thread_id: id };
            ensureOpen(turn.signal);
            await turn.beforeStart?.();
            ensureOpen(turn.signal);
            // agy can replace a missing resume ID. Ticket input stays local until the matching init.
            child.send(input.payload);
            yield { type: "turn.started" };
          } else if (event.event === "result") {
            const parsed = resultEvent.safeParse(event);
            if (result || !parsed.success || (connected && parsed.data.result.conversation_id !== id)) {
              throw turnFailure("Antigravity CLI returned an invalid result");
            }
            result = parsed.data.result;
          }
        }

        const exit = await child.exit;
        ensureOpen(turn.signal);
        if (startupExpired) {
          throw turnFailure("Antigravity CLI did not initialize within 60 seconds. Update agy and verify sign-in as the worker account.");
        }
        if (exit.kind === "unavailable" || (!connected && (exit.code === 126 || exit.code === 127))) {
          throw launchFailure();
        }
        if (result?.status !== "SUCCESS" && /authentication required|unauthenticated|not logged in|please (?:log|sign) in/i.test(result?.error ?? "")) {
          throw turnFailure("Antigravity CLI authentication failed. Check the worker account's agy sign-in or API credentials.");
        }
        if (result?.status === "ERROR" && /^invalid model selection\b/i.test(result.error ?? "")) {
          throw turnFailure("Antigravity CLI rejected the configured model. Run agy models as the worker account and select a listed model ID.");
        }
        if (result?.status === "WAITING") {
          throw turnFailure("Antigravity CLI is waiting for input. Check the worker account's native agy permissions and provide any required context before retrying.");
        }
        if (exit.code !== 0 || child.inputFailed || (result && result.status !== "SUCCESS")) {
          throw turnFailure("Antigravity CLI ended the turn with an error");
        }
        if (!connected || !result) {
          throw turnFailure("Antigravity CLI ended the stream before completing the turn");
        }
        return result;
      } finally {
        clearTimeout(startupTimer);
        turn.signal?.removeEventListener("abort", abort);
        await child.stop();
        current = undefined;
      }
    }

    return { async runStreamed(input, turn) { return { events: run(input, turn) }; } };
  }

  return {
    startThread: options => thread(options),
    resumeThread(id, options) {
      if (!conversationId.safeParse(id).success) throw turnFailure("The saved Antigravity conversation ID is invalid");
      return thread(options, id);
    },
    close: () => closePromise ??= close()
  };
}

function argumentsFor(
  options: RuntimeThreadOptions, id: string | undefined, turn: TurnOptions, attachmentDirectory?: string
): string[] {
  return [
    "--input-format", "stream-json", "--output-format", "stream-json",
    "--disable-slash-commands",
    "--model", options.model,
    ...(id ? ["--conversation", id] : []),
    ...(attachmentDirectory ? ["--add-dir", attachmentDirectory] : []),
    ...(turn.outputSchema === undefined ? [] : ["--json-schema", JSON.stringify(turn.outputSchema)])
  ];
}

function encodeInput(content: string): string {
  return JSON.stringify({ event: "user", message: { content } }) + "\n";
}

async function prepareInput(input: Input, signal?: AbortSignal): Promise<PreparedInput> {
  if (typeof input === "string") return { payload: encodeInput(input) };
  const text = input.flatMap(entry => entry.type === "text" ? [entry.text] : []).join("\n");
  const images = input.filter(entry => entry.type === "local_image");
  if (images.length === 0) return { payload: encodeInput(text) };

  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "tmatrix-agy-images-"));
    const mentions: string[] = [];
    for (const [index, image] of images.entries()) {
      signal?.throwIfAborted();
      const extension = extname(image.path).toLowerCase();
      if (!/^\.(?:png|jpe?g|gif|webp)$/.test(extension)) throw new Error("Unsupported image type");
      const path = join(directory, `image-${index + 1}${extension}`);
      await copyFile(image.path, path);
      mentions.push(`@${path}`);
    }
    return { payload: encodeInput(`${text}\n\nLocal image attachments (inspect these files):\n${mentions.join("\n")}`), directory };
  } catch {
    if (directory) await rm(directory, { recursive: true, force: true });
    signal?.throwIfAborted();
    throw turnFailure("Antigravity CLI could not prepare the attached images.");
  }
}

function decode(line: string): z.infer<typeof eventHeader> | undefined {
  try {
    const parsed = eventHeader.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function launchFailure(): WorkerError {
  return turnFailure("Antigravity CLI could not start. Install agy on the worker PATH or set TMATRIX_AGY_PATH to its executable, and verify the working directory.");
}

function turnFailure(message: string): WorkerError {
  return new WorkerError({ message, code: "GEMINI_TURN_FAILED", stage: "gemini.turn" });
}
