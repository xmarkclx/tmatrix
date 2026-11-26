import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { CGROUP_ENV, validLeaseCgroup } from "../../conversation-cgroup.js";
import { LEASE_ENV } from "../../conversation-recovery.js";
import { WorkerError } from "../../errors.js";
import type {
  AdapterContext, Input, RuntimeCreator, RuntimeThreadOptions, ThreadLike, Usage, WorkerThreadEvent
} from "../../runtime-adapter.js";
import { assistantActivity, toolResultActivity, type ToolNames } from "./activity.js";
import { claudeModel, confirmLeaseStopped, turnFailure } from "./runtime.js";
import { TmuxSession } from "./tmux.js";

/*
 * Runs interactive Claude Code in a private tmux session so people can watch and
 * type into the same screen. Hooks report session start, prompt receipt and turn
 * end; each turn's prompt is a file Claude reads, and the structured handoff is a
 * file Claude writes. Pasting the prompt is avoided because Claude Code treats
 * pasted text as untrusted material rather than instructions.
 */

const POLL_MS = 250;
const START_TIMEOUT_MS = 120_000;
const SUBMIT_TIMEOUT_MS = 15_000;
const MAX_HANDOFF_REMINDERS = 2;
const STOP_TIMEOUT_MS = 2_000;
/**
 * Startup answers a worker may give: workspace trust, trust for its own state directory, the bypass
 * warning, and resuming an old or large session in full (a summary would lose the exact conversation).
 */
const ACCEPT_OPTIONS = [/Yes, I trust this folder/, /Yes, add it/, /Yes, proceed/, /Yes, I accept/,
  /\b(?:resume|continue|keep|load)\b.*\bfull\b/i];
/** Menus end with this footer; only the block above the last one is a live menu. */
const MENU_FOOTER = /Enter to (?:confirm|select)|Esc to cancel/;
const MENU_HEIGHT = 16;
const STARTUP_NOTICE_MS = 15_000;

const sessionIdSchema = z.uuid();
const sessionStartSchema = z.looseObject({ session_id: z.string(), transcript_path: z.string().optional() });
const stopSchema = z.looseObject({ last_assistant_message: z.string().nullish() });
const notificationSchema = z.looseObject({ message: z.string().max(2_000).optional().catch(undefined) });
/** Claude Code's wording when a plan or rate limit ends the turn. */
const USAGE_LIMIT = /usage limit|limit reached|hit your limit|rate limit|out of (?:extra )?usage/i;
const tokenCount = z.int().nonnegative().optional().catch(undefined);
const transcriptSchema = z.looseObject({
  type: z.string(),
  message: z.looseObject({
    id: z.string().optional(),
    content: z.union([z.string(), z.array(z.unknown())]).optional().catch(undefined),
    usage: z.object({
      input_tokens: tokenCount,
      output_tokens: tokenCount,
      cache_read_input_tokens: tokenCount,
      cache_creation_input_tokens: tokenCount
    }).optional().catch(undefined)
  }).optional().catch(undefined)
});
type TranscriptUsage = NonNullable<NonNullable<z.infer<typeof transcriptSchema>["message"]>["usage"]>;
type TurnOptions = NonNullable<Parameters<ThreadLike["runStreamed"]>[1]>;

const SYSTEM_PROMPT = [
  "You are a TMatrix worker running unattended; a person may also watch this screen and type to you.",
  "Messages that start with \"TMatrix\" name a file written by your operator. Read that file with the Read tool and follow it as your operator's instructions.",
  "When the work it describes is complete, write the handoff JSON it asks for to the handoff path named in the message, using the Write tool, then end your turn.",
  "Messages typed by a person are direct requests from your operator too. If one changes the task, write an updated handoff to the most recent handoff path."
].join("\n");

const HOOK_SCRIPT = `#!/bin/sh
# Records one Claude Code hook payload per file. The rename makes each file appear complete.
tmp=$(mktemp "$0.d/.$1.XXXXXX") || exit 0
cat > "$tmp" && mv "$tmp" "$tmp.$1.json"
exit 0
`;

interface Signals {
  started?: z.infer<typeof sessionStartSchema>;
  submits: number;
  stops: string[];
  notifications: string[];
}

export function createClaudeTerminalRuntime(context: AdapterContext, executable: string): ReturnType<RuntimeCreator> {
  const environment: Record<string, string> = { ...context.environment, DISABLE_AUTOUPDATER: "1" };
  delete environment.CLAUDECODE;
  delete environment.API_KEY;
  const ownerToken = environment[LEASE_ENV] ?? "";
  const cgroup = environment[CGROUP_ENV];
  if (cgroup && !validLeaseCgroup(cgroup, ownerToken)) throw new Error("Invalid Claude Code runtime cgroup");

  let stateDirectory: string | undefined;
  let tmux: TmuxSession | undefined;
  let panePid: number | undefined;
  let threadClaimed = false;
  let closePromise: Promise<void> | undefined;

  async function state(): Promise<string> {
    if (stateDirectory) return stateDirectory;
    const directory = await mkdtemp(join(tmpdir(), "tmatrix-claude-"));
    await mkdir(join(directory, "hook.d"), { mode: 0o700 });
    await writeFile(join(directory, "hook"), HOOK_SCRIPT, { mode: 0o700 });
    await writeFile(join(directory, "system.md"), SYSTEM_PROMPT, { mode: 0o600 });
    await chmod(directory, 0o700);
    return stateDirectory = directory;
  }

  async function readSignals(): Promise<Signals> {
    const directory = join(await state(), "hook.d");
    const names = (await readdir(directory)).filter(name => name.endsWith(".json"));
    const signals: Signals = { submits: 0, stops: [], notifications: [] };
    const stops: { path: string; at: number }[] = [];
    const notifications: { path: string; at: number }[] = [];
    for (const name of names) {
      const path = join(directory, name);
      if (name.endsWith(".UserPromptSubmit.json")) signals.submits += 1;
      else if (name.endsWith(".Stop.json")) stops.push({ path, at: (await stat(path)).mtimeMs });
      else if (name.endsWith(".Notification.json")) notifications.push({ path, at: (await stat(path)).mtimeMs });
      else if (name.endsWith(".SessionStart.json") && !signals.started) {
        const started = sessionStartSchema.safeParse(parseJson(await readFile(path, "utf8"))).data;
        if (started) signals.started = started;
      }
    }
    signals.stops = stops.sort((a, b) => a.at - b.at).map(stop => stop.path);
    signals.notifications = notifications.sort((a, b) => a.at - b.at).map(notification => notification.path);
    return signals;
  }

  async function stopSession(): Promise<void> {
    const session = tmux;
    const pid = panePid;
    tmux = undefined;
    panePid = undefined;
    await session?.kill();
    if (pid === undefined) return;
    // kill-server hangs up the pane; make sure Claude and its children are gone.
    if (await processGone(pid)) return;
    signal(pid, "SIGTERM");
    if (await processGone(pid)) return;
    signal(pid, "SIGKILL");
    if (!await processGone(pid)) throw new Error("Claude Code terminal shutdown could not be confirmed");
  }

  async function close(): Promise<void> {
    try {
      await stopSession();
      await confirmLeaseStopped(cgroup, ownerToken);
    } finally {
      if (stateDirectory) await rm(stateDirectory, { recursive: true, force: true }).catch(() => undefined);
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
    let turnNumber = 0;
    let messageNumber = 0;
    let transcript: { path: string; offset: number; partial: string } | undefined;
    const tools: ToolNames = new Map();
    /** Present while a turn accepts more messages. */
    let inbox: { handoffPath: string; pending: number } | undefined;

    /** Types a pointer to an operator file and waits for Claude to accept it. */
    async function deliver(text: string, prompt: (file: string) => string, signal?: AbortSignal): Promise<void> {
      const session = tmux;
      if (!session) throw turnFailure("Claude Code terminal is not running");
      const file = join(await state(), `message-${++messageNumber}.md`);
      await writeFile(file, text, { mode: 0o600 });
      const before = (await readSignals()).submits;
      await session.type(prompt(file));
      await delay(150);
      await session.keys("Enter");
      const expires = performance.now() + SUBMIT_TIMEOUT_MS;
      let retried = false;
      while ((await readSignals()).submits <= before) {
        ensureOpen(signal);
        if (!retried && performance.now() > expires - SUBMIT_TIMEOUT_MS / 2) {
          // The input box can miss an Enter that arrives while it redraws.
          retried = true;
          await session.keys("Enter");
        }
        if (performance.now() > expires) throw turnFailure("Claude Code did not accept the message");
        await delay(POLL_MS);
      }
    }

    async function* launch(turn: TurnOptions): AsyncGenerator<WorkerThreadEvent, "started" | "missing"> {
      const directory = await state();
      await rm(join(directory, "hook.d"), { recursive: true, force: true });
      await mkdir(join(directory, "hook.d"), { mode: 0o700 });
      const hook = (event: string) => [{ hooks: [{ type: "command", command: `'${join(directory, "hook")}' ${event}` }] }];
      const settings = JSON.stringify({
        // Unattended workers must not stop at the bypass warning or the project MCP approval dialog.
        skipDangerousModePermissionPrompt: true,
        enableAllProjectMcpServers: true,
        hooks: {
          SessionStart: hook("SessionStart"), UserPromptSubmit: hook("UserPromptSubmit"),
          Stop: hook("Stop"), Notification: hook("Notification")
        }
      });
      const args = [
        "--model", claudeModel(options.model),
        "--effort", options.modelReasoningEffort === "ultra" ? "max" : options.modelReasoningEffort,
        "--permission-mode", "bypassPermissions",
        "--settings", settings,
        "--append-system-prompt-file", join(directory, "system.md"),
        "--add-dir", directory,
        ...(resume ? ["--resume", sessionId] : ["--session-id", sessionId, `--name=${options.threadName}`])
      ];
      const command = cgroup
        ? ["/bin/sh", "-c", 'printf %s "$$" > "$1/cgroup.procs" && shift && exec "$@"', "tmatrix-claude", cgroup, executable, ...args]
        : [executable, ...args];
      const session = new TmuxSession(environment, directory);
      tmux = session;
      try {
        await session.start(command, options.workingDirectory);
      } catch {
        tmux = undefined;
        throw turnFailure("Unable to start Claude Code in tmux");
      }
      panePid = (await session.pane())?.pid;
      yield { type: "local.terminal", ...session.reference };

      const began = performance.now();
      const expires = began + START_TIMEOUT_MS;
      let noticed = false;
      while (true) {
        ensureOpen(turn.signal);
        const signals = await readSignals();
        if (signals.started) {
          if (signals.started.session_id !== sessionId) throw turnFailure("Claude Code connected to an unexpected conversation");
          const path = signals.started.transcript_path;
          transcript = path && isAbsolute(path) ? { path, offset: transcript?.path === path ? transcript.offset : await size(path), partial: "" } : undefined;
          resume = true;
          return "started";
        }
        const pane = await session.pane();
        if (!pane || pane.dead) {
          const output = await session.capture(true).catch(() => "");
          await stopSession();
          if (resume && output.includes(`No conversation found with session ID: ${sessionId}`)) return "missing";
          if (/Please run \/login|Not logged in/i.test(output)) {
            throw turnFailure("Claude Code authentication failed. Check the worker account's Claude Code sign-in.");
          }
          throw turnFailure("Claude Code exited before the session started");
        }
        await acceptStartupDialog(session);
        if (!noticed && performance.now() - began > STARTUP_NOTICE_MS) {
          noticed = true;
          yield { type: "local.activity", kind: "claude.waiting", text: "Claude Code is still starting. Press v to see its screen or a to attach and answer any prompt." };
        }
        if (performance.now() > expires) throw turnFailure("Claude Code did not finish starting. Attach to its terminal to check for a prompt.");
        await delay(POLL_MS);
      }
    }

    async function* readTranscript(usage: Map<string, TranscriptUsage>): AsyncGenerator<WorkerThreadEvent> {
      if (!transcript) return;
      const chunk = await readFrom(transcript.path, transcript.offset);
      if (!chunk.length) return;
      transcript.offset += chunk.length;
      const lines = (transcript.partial + chunk.toString("utf8")).split("\n");
      transcript.partial = lines.pop() ?? "";
      for (const line of lines) {
        const entry = transcriptSchema.safeParse(parseJson(line));
        if (!entry.success || !entry.data.message) continue;
        const { id, content, usage: tokens } = entry.data.message;
        if (entry.data.type === "user" && Array.isArray(content)) yield* toolResultActivity(content, tools);
        if (entry.data.type !== "assistant") continue;
        if (id && tokens) usage.set(id, tokens);
        if (Array.isArray(content)) yield* assistantActivity(content, tools);
      }
    }

    async function* run(input: Input, turn: TurnOptions = {}): AsyncGenerator<WorkerThreadEvent> {
      if (closePromise || running) throw turnFailure("Claude Code runtime is unavailable");
      running = true;
      const abort = () => { void stopSession().catch(() => undefined); };
      turn.signal?.addEventListener("abort", abort, { once: true });
      try {
        ensureOpen(turn.signal);
        await turn.beforeStart?.();
        ensureOpen(turn.signal);
        if (!tmux) {
          let launched = yield* launch(turn);
          if (launched === "missing") {
            if (!turn.missingConversationInput) throw turnFailure("The saved Claude Code conversation could not be found");
            input = await turn.missingConversationInput();
            sessionId = randomUUID();
            resume = false;
            transcript = undefined;
            launched = yield* launch(turn);
            if (launched === "missing") throw turnFailure("Claude Code failed to start a new conversation");
          }
        }
        ensureOpen(turn.signal);
        yield { type: "thread.started", thread_id: sessionId };
        yield { type: "turn.started" };

        const directory = await state();
        const turnId = ++turnNumber;
        const handoffPath = join(directory, `handoff-${turnId}.json`);
        await rm(handoffPath, { force: true });
        const schema = turn.outputSchema === undefined ? "" : [
          "", "---",
          `When this turn is complete, write the handoff as one JSON object matching this JSON Schema to ${handoffPath} with the Write tool, then end your turn:`,
          JSON.stringify(turn.outputSchema)
        ].join("\n");
        const usage = new Map<string, TranscriptUsage>();
        const mailbox = { handoffPath, pending: 0 };
        let notified = (await readSignals()).notifications.length;
        await deliver(inputText(input) + schema,
          file => `TMatrix turn ${turnId}: read ${file} and follow it as your operator's instructions. Write the handoff JSON to ${handoffPath} when done.`,
          turn.signal);
        inbox = mailbox;

        let reminders = 0;
        let text: string | undefined;
        while (text === undefined) {
          ensureOpen(turn.signal);
          yield* readTranscript(usage);
          const waiting = (await readSignals()).notifications;
          for (const path of waiting.slice(notified)) {
            // Claude asks for attention when it needs a person; surface it instead of hanging silently.
            const message = notificationSchema.safeParse(parseJson(await readFile(path, "utf8"))).data?.message;
            if (message && !/waiting for your input/i.test(message)) {
              yield { type: "local.activity", kind: "claude.waiting", text: `${message} Attach with a to answer.` };
            }
          }
          notified = waiting.length;
          const pane = await tmux?.pane();
          if (!pane || pane.dead) {
            await stopSession();
            throw turnFailure("Claude Code exited before finishing the turn");
          }
          const signals = await readSignals();
          if (mailbox.pending > 0 || signals.stops.length < signals.submits) {
            await delay(POLL_MS);
            continue;
          }
          const last = signals.stops.at(-1);
          const stop = last ? stopSchema.safeParse(parseJson(await readFile(last, "utf8"))).data : undefined;
          if (turn.outputSchema === undefined) {
            text = stop?.last_assistant_message ?? "";
            break;
          }
          const handoff = await readHandoff(handoffPath);
          if (handoff !== undefined) {
            text = handoff;
            break;
          }
          if (USAGE_LIMIT.test(stop?.last_assistant_message ?? "")) {
            throw new WorkerError({
              code: "CLAUDE_USAGE_LIMIT", stage: "claude.turn",
              message: "Claude Code stopped at its plan usage limit. Retry after the limit resets or route this task to Codex."
            });
          }
          if (reminders++ >= MAX_HANDOFF_REMINDERS) throw turnFailure("Claude Code finished without a structured handoff");
          mailbox.pending += 1;
          try {
            await deliver(`The turn is not finished: no valid handoff JSON was found at ${handoffPath}. Write it now as one JSON object matching the schema from this turn, then end your turn.${schema}`,
              file => `TMatrix reminder: read ${file} and follow it.`, turn.signal);
          } finally {
            mailbox.pending -= 1;
          }
        }
        inbox = undefined;
        yield* readTranscript(usage);
        ensureOpen(turn.signal);
        yield { type: "item.completed", item: { id: randomUUID(), type: "agent_message", text } };
        yield { type: "turn.completed", usage: totalUsage(usage) };
      } finally {
        inbox = undefined;
        turn.signal?.removeEventListener("abort", abort);
        running = false;
      }
    }

    async function steer(input: Input, turn: { signal?: AbortSignal } = {}): Promise<boolean> {
      const mailbox = inbox;
      if (!mailbox || closePromise) return false;
      // Keep the turn open until this message is accepted and answered.
      mailbox.pending += 1;
      try {
        await deliver(`${inputText(input)}\n\n---\nWhen done, write the updated handoff JSON to ${mailbox.handoffPath}, replacing the earlier one.`,
          file => `TMatrix update: read ${file} and follow it as your operator's instructions.`, turn.signal);
        return true;
      } finally {
        mailbox.pending -= 1;
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

/**
 * Answers only known startup menus by moving the cursor to the accept option. Resumed history
 * is drawn on the same screen, so only the block above the bottom-most menu footer counts.
 */
export function startupAnswer(screen: string): string[] | undefined {
  const lines = screen.split("\n");
  let footer = -1;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (MENU_FOOTER.test(lines[index] ?? "")) { footer = index; break; }
  }
  if (footer < 0 || lines.slice(footer + 1).some(line => line.trim())) return undefined;
  const menu = lines.slice(Math.max(0, footer - MENU_HEIGHT), footer);
  const cursor = menu.findIndex(line => /^\s*❯/.test(line));
  const target = menu.findIndex(line => ACCEPT_OPTIONS.some(option => option.test(line)));
  if (cursor < 0 || target < 0) return undefined;
  const moves = target - cursor;
  return [...Array<string>(Math.abs(moves)).fill(moves > 0 ? "Down" : "Up"), "Enter"];
}

async function acceptStartupDialog(session: TmuxSession): Promise<void> {
  const keys = startupAnswer(await session.capture().catch(() => ""));
  if (!keys) return;
  await session.keys(...keys);
  await delay(500);
}

function inputText(input: Input): string {
  if (typeof input === "string") return input;
  return input.map(entry => entry.type === "text" ? entry.text
    : `Attached image: ${entry.path} (view it with the Read tool).`).join("\n\n");
}

async function readHandoff(path: string): Promise<string | undefined> {
  const value = parseJson(await readFile(path, "utf8").catch(() => ""));
  return value !== null && typeof value === "object" && !Array.isArray(value) ? JSON.stringify(value) : undefined;
}

function totalUsage(usage: Map<string, TranscriptUsage>): Usage {
  let input = 0, cached = 0, written = 0, output = 0;
  for (const tokens of usage.values()) {
    input += tokens.input_tokens ?? 0;
    cached += tokens.cache_read_input_tokens ?? 0;
    written += tokens.cache_creation_input_tokens ?? 0;
    output += tokens.output_tokens ?? 0;
  }
  return {
    input_tokens: input + cached + written, cached_input_tokens: cached,
    cache_write_input_tokens: written, output_tokens: output, reasoning_output_tokens: 0
  };
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}

async function size(path: string): Promise<number> {
  return (await stat(path).catch(() => undefined))?.size ?? 0;
}

async function readFrom(path: string, offset: number): Promise<Buffer> {
  const file = await open(path, "r").catch(() => undefined);
  if (!file) return Buffer.alloc(0);
  try {
    const length = Math.max(0, (await file.stat()).size - offset);
    const buffer = Buffer.alloc(Math.min(length, 4 * 1024 * 1024));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

function signal(pid: number, name: NodeJS.Signals): void {
  try { process.kill(pid, name); } catch { /* Already gone. */ }
}

async function processGone(pid: number): Promise<boolean> {
  const expires = performance.now() + STOP_TIMEOUT_MS;
  while (performance.now() < expires) {
    try { process.kill(pid, 0); } catch { return true; }
    await delay(25);
  }
  return false;
}
