# TMatrix

Use your own cheaper AI subscriptions and powerful models to add AI powers to supported apps.
Use your own computers to save from using expensive Cloud computers.

Concept:
- Your computer runs TMatrix.
- A **poller** gets data from a **source**.
- An **AI worker** works on those data using **adapters** in parallel.
- Adapter translates models like Codex or Claude Code

---

Created for [Tzudo](https://tzudo.app/), the ultimate to do list and time tracker to 10x your productivity and work stress-free.

Codex adapter included.

Im not using Claude this month, so I may not work on a Claude adapter until I get back to using it.

![example](images/sample.png)

## Quick install

Mac, Linux, or Windows WSL:

```sh
curl -fsSL https://github.com/xmarkclx/tmatrix/releases/latest/download/install.sh | sh
```

Uninstall the daemon and command (default installation):

```sh
tmatrix service uninstall && rm -f "$HOME/.local/bin/tmatrix"
```

Settings and downloaded bundles are retained.

# Security Recommendations
- Best to run on its own secure environment like on a VM.
- Turn off / pause intake when not being used.

For an installed app and background daemon, see [Install on Mac or Windows](#releases-and-installation). To remove login startup later, see [Uninstall the daemon](#uninstall-the-daemon).

## Try it now

From this workspace:

```sh
cd /path/to/tmatrix
go run ./cmd/tmatrix --demo
```

Or run the compiled `./bin/tmatrix --demo`. The demo needs no account, makes no network requests, and writes no settings. It uses three fictional workers and explicitly simulated activity and receipts. Mouse navigation is enabled by default: click tabs, worker cards, Message/Stop controls, footer buttons, and form fields; wheel over the activity panel to scroll. Press **F2** to release mouse capture and select text with your terminal; press F2 again to restore clicks and wheel scrolling. Use `--no-mouse` (or `--mouse=false`) to start with terminal text selection enabled. A 110×40 terminal shows more activity; smaller terminals keep the selected worker and its status visible.


| Key                        | Action                                                  |
| -------------------------- | ------------------------------------------------------- |
| `←` / `→`, `Tab`, `1`–`9`  | Switch workers                                          |
| `Enter` / `i`              | Compose a message; `Enter` sends, `Esc` keeps the draft |
| `x`, then `y`              | Request a stop; `Esc` / `n` cancels confirmation        |
| `↑` / `↓`, `PgUp` / `PgDn` | Scroll activity; pages also work while composing        |
| `Home`                     | View the initial prompt                                 |
| `f` / `End`                | Follow newest activity                                  |
| `w`, `p`, `s`              | Workers, pollers, settings                              |
| `m`                        | Matrix replay for selected worker; `Esc` / `m` exits    |
| `c`                        | Connect with Tzu Do                                     |
| `Space`                    | Pause or resume task intake; existing work continues    |
| `?`                        | Full keyboard help                                      |
| `F2`                       | Toggle terminal text selection / mouse navigation       |
| `q` / `Ctrl+C`             | Detach the console; background work continues           |


Press **m** on the Workers screen for borderless Matrix playback: green text on
pure black, with new rows rising from the bottom and a brighter leading row.
It starts with the selected worker's latest activity entry (at most its last eight
screen rows), then queues new messages in order. Older activity and the initial
prompt remain available in the normal view. Entry, re-entry, and automatic task
switching all start from recent output. Scrolling adapts smoothly to incoming
screen-row volume and backlog (2–30 rows/second), without dumping new messages
onto the screen. **Esc** or **m** returns to the normal reading position. Other
worker controls are inactive during playback; q / Ctrl+C still detach. A finished
or removed worker's queued text finishes scrolling, then Matrix automatically
follows the first remaining active worker in tab order. If none is available,
it waits for the next task without leaving Matrix mode.
History already expired from the engine cannot be recovered, and sustained output
above the maximum playback rate can accumulate a backlog. NO_COLOR and terminal
color overrides still apply.

To copy, press F2, drag across visible text, and use your terminal's Copy
command (often Ctrl+Shift+C). To paste, open a message with Enter or activate
a form field, then use the terminal's Paste command (often Ctrl+Shift+V).
Ctrl+C still detaches the console. Bracketed paste inserts text without
triggering shortcuts or sending a message; Enter sends after you review it.
The editors are single-line, so pasted line breaks become spaces.
Copying uses the terminal's selection and clipboard, including over SSH;
it may include panel borders. Live updates can move text during selection.

Settings and connection forms open without an active text editor. Use a click,
`Tab` / `Shift+Tab`, or Up/Down to select a field, then press `Enter` to edit.
`Enter` or `Esc` finishes editing; `Ctrl+S` saves the form. Tabs remain clickable
while editing. Leaving the form discards unsaved changes.
The API key is masked. Drafts belong to individual workers. Clicking another
worker preserves its draft; stop requests still require an explicit confirmation.

Scroll up with the wheel, arrows or `PgUp` to hold your reading position while
new messages arrive. Each worker keeps its own position when you switch tabs.
The activity bar shows new entries; press `f` / `End`, click the bar, or scroll
back to the bottom to follow live output again. If the engine expires the very
entry you were reading from its bounded local history, the console says so and
shows the oldest retained activity. This is an in-session position, not a saved
transcript across console restarts.

While composing, `Ctrl+Home` opens the prompt and `Ctrl+End` resumes live output;
plain Home/End still move the input cursor. The activity bar is clickable.

Press `Home` to find the **INITIAL PROMPT** card: a double border and separate
pale-green surface distinguish the prepared input from later activity. It is the
first prompt prepared for this worker execution, including task context, not
necessarily the first message in the entire conversation. A prepared prompt does
not prove receipt. The local copy is limited to 16 KiB of serialized text;
truncated excerpts and redactions are labeled. Older or already-running engines
may show “Not captured for this run”; capturing requires a new run on the updated
engine. No prompt or transcript is uploaded as part of this console feature.

TMatrix uses **Lip Gloss v1.1** for its bordered tabs, worker cards and message
panels. Every activity type has its own foreground/background pair: mint on
forest for messages, lavender on indigo for steering, ice on teal for tools,
pale blue on slate for output, cream on olive for status, and blush on burgundy
for errors. The initial prompt uses dark ink on light sage with a double border.
Labels carry the same meaning without color. Edit the paired roles in
`internal/tui/palette.go`.

Emoji are preserved in worker titles, activity, drafts and sent messages. The
editor moves and deletes whole emoji sequences, including skin tones and joined
emoji. Rendering still depends on the terminal's font and Unicode-width support;
use an emoji-capable font/fallback in Windows Terminal. Older terminal multiplexers
can disagree about widths of variation-selector emoji.

`4m 32s elapsed` measures the current worker execution, not the conversation's
age. It advances while running or stopping, then freezes as `total` after a
confirmed end. Missing or uncertain timestamps show `Runtime unknown`.
The **Conversation** line shows the runtime conversation ID when available.
Tzu Do tasks use one active conversation, regardless of comment count or reply
ancestry. New servers return an explicit `conversation` reference (thread ID,
runtime, and opaque history-store scope). The worker prefers that reference,
then its local task mapping, then legacy ticket/comment links and signed handoffs.
An explicit reference for another runtime or history store starts with full
recovery context rather than resuming an obsolete local conversation. Successful
results publish the current reference; old servers can ignore the additive field. A resumed conversation receives the triggering
comment and only changed task/project context, without replaying unchanged
instructions, older comments or saved handoff. A short current worktree session
value accompanies runs with worktree management. Context fingerprints persist
per conversation after successful turns; older conversations establish this
baseline with a one-time context refresh. The worker still fetches full
Tzu Do recovery data; it sends that context to the model only for fresh starts
or legacy/incomplete payloads without an identifiable triggering comment.
A missing conversation link, confirmed conversation
loss, or a runtime without resume support starts a fresh conversation with task
context, comments and the relevant saved handoff. Task
updates still show queued delivery, runtime receipt and visible response in
activity; input version counters are not part of the console UI.
The engine saves conversation links for future follow-ups. Older replies may
lack a saved link; activity explains the fresh start, and the new conversation
link is saved for future replies.

## Colors and Windows Terminal / WSL

The console owns its canvas, distinct main pane and filled cards, including
text, borders, padding and blank rows. Nested styling restores each surface
instead of exposing the terminal's default background. The Matrix palette
remains readable when the host terminal uses a light or dark scheme; TMatrix
does not modify that scheme.

All palette variables live in `internal/tui/palette.go` (`matrixPalette`). Edit
the foreground and background roles together, including their `TrueColor`,
`ANSI256` and `ANSI` values, then rebuild to customize every screen:

```sh
go build -o bin/tmatrix ./cmd/tmatrix
./bin/tmatrix --demo
```

Color capability is detected automatically. Truecolor uses the exact RGB
palette; the 256-color fallback uses fixed entries above the 16 theme-controlled
slots. The 16-color fallback uses a quiet black canvas, green selection, and
text labels and borders to distinguish activity, avoiding saturated full-width
backgrounds. It is checked against the
Campbell and One Half Light palettes; arbitrary customized ANSI colors can still
change readability. Dark text avoids bold in that fallback because some
terminals brighten bold black into grey. `NO_COLOR` preserves labels and borders.

If a truecolor-capable Windows Terminal / WSL session only advertises 256 colors,
`COLORTERM=truecolor ./bin/tmatrix --demo` uses the exact palette. There is no
theme settings editor yet; these are source-level palette variables.

## SSH terminals

Use an interactive terminal: `ssh -t host tmatrix`. SSH sessions automatically
use portable rendering (`SSH_CONNECTION`, `SSH_CLIENT`, or `SSH_TTY`): ASCII
borders and symbols, display-only emoji placeholders, and one unused right-edge
column to avoid terminal autowrap. International text remains visible. Original
worker content, drafts, and sent messages are unchanged. Portable mode needs at
least **41 columns × 16 rows**. Resizing clears stale rows; **Ctrl+L** redraws
without discarding your draft or scroll position.

```sh
# Fictional demo; safe to try without connecting workers:
ssh -t host 'tmatrix --demo'
# Force portable rendering in a local terminal or persistent tmux session:
tmatrix --terminal portable
# Opt back into emoji and Unicode borders on a compatible SSH client:
tmatrix --terminal rich
# If the client supports 256 colors but SSH advertises only xterm:
tmatrix --color 256
```

`--color auto` trusts the advertised terminal capability; it does not assume SSH
supports truecolor. Overrides are `16`, `256`, `truecolor`, and `none`. Only select
capabilities supported by the client; `NO_COLOR` takes precedence. `--no-mouse`
allows normal terminal text selection. Existing tmux servers can retain old SSH
environment values; use `--terminal portable` or `--terminal rich` explicitly.

## Run real workers

The terminal is Go. Version 1 reuses the existing TypeScript Codex/Tzu Do engine
through a private local adapter, preserving its conversation, cancellation,
ownership, reporting, and worktree behavior. It is not yet an all-Go runtime.

Prerequisites: Go 1.25+ for source builds, Node.js 20.19 or 22.12+, Python 3.11+, and a Codex
login. Git is needed for repository/PR tasks. The live engine runs on Linux,
macOS, or WSL. The native Windows binary supports the demo; use WSL for real
workers because the existing worktree lifecycle requires POSIX file locking.

```sh
cd /path/to/tmatrix
npm ci
sh scripts/stage-engine.sh
./node_modules/.bin/codex login
go build -o bin/tmatrix ./cmd/tmatrix
./bin/tmatrix
```

Staging compiles this checkout's `src/` into `staging/engine`; stop the local
TMatrix engine before restaging its files. The built `bin/tmatrix` discovers that
engine relative to its own location. Release archives include an adjacent
`engine/` directory. Automatic discovery never searches your working directory
or its parent. For live development with `go run`, explicitly use
`go run ./cmd/tmatrix --engine-dir "$PWD/staging/engine"`. You can also set
`TMATRIX_ENGINE_DIR` to a trusted engine directory.

1. Press `c`, enter your Tzu Do URL and **worker API key**, and save. A bare
  `https://tzudo.app` URL expands to `/api/v1/ai/poll`. An empty key reuses a
   previously saved key.
2. Saving the connection pauses intake and drains any active workers before
  saving the new credentials and restarting automatically. Keep the terminal open
   until saving finishes; long-running workers are allowed to finish without a time limit.
   An installed TMatrix service is used for the restart when available. Authentication and poll
   errors appear on the poller screen. TMatrix uses a new, persistent instance UUID.
3. Press `Space` to pause or resume intake. Active workers continue when paused.
4. Open a worker, read its activity, send a message, or request a stop. These are
  real controls when the `DEMO` label is absent.
5. Press `q` to leave workers running. Run `tmatrix` again to reattach or automatically start the configured engine.

Use `tmatrix service install` / `tmatrix service uninstall` for an optional macOS LaunchAgent or Linux user systemd service. Installation enables startup at login, safely drains any existing TMatrix engine, and starts the service automatically; keep the command or app open until it finishes. `tmatrix daemon` runs the supervised foreground process. See [Switching from an existing worker](#switching-from-an-existing-worker) before replacing an existing service.

The existing unattended Codex engine executes with its existing unrestricted
tool policy; enabling intake allows queued tasks to run on this machine. Choose
the intended queue and working directories before enabling it.

Other commands (put flags before the command):

```sh
tmatrix status
tmatrix engine start
tmatrix engine stop
tmatrix engine restart
tmatrix --config-dir /private/path/tmatrix status
```

`engine start` is idempotent. New connections start intake automatically; later launches restore the saved intake preference. `engine stop` pauses
intake and drains current workers, then exits. It is a shutdown request, not an
instant stop confirmation. Reattach to monitor the drain or stop individual
workers. Optional macOS launchd installation supports login startup and crash recovery; Linux/WSL systemd also supports boot startup. After installation, run `tmatrix status` to check the engine. See [Switching from an existing worker](#switching-from-an-existing-worker) when migrating another service.

In the TUI, open Settings (`s`) and click **Restart engine** or press `r` when not editing a field, then confirm with `y`. All updated consoles sharing the configuration directory show `RESTART PENDING` in the top header during a restart, including one requested from the CLI. The indicator clears on completion or cancellation and expires if the restart process exits unexpectedly. The console shows drain progress and waits for readiness; keep it open until completion. Unsaved settings stay in the form and are not applied by restarting.

`engine restart` pauses intake and waits for all active workers to finish before starting a replacement. Keep the command open: draining has no time limit and never force-stops workers. The replacement uses the installed TMatrix service when present, preserves credentials and saved settings (including paused intake), and reports success only after its bridge responds. Ctrl+C cancels the restart wait; an already requested drain continues, so use `tmatrix status` to inspect it and rerun `engine restart` when ready. An unreachable engine blocks restart rather than risking a second poller.

TMatrix does not discover, restart, or take over the existing systemd/PM2 AI
Worker service. To view that service, its operator must separately opt it into
the new bridge (`TMATRIX_CONTROL_FILE` with an absolute private path) after
deploying the updated engine. Do not start multiple services with the same
instance identity. Creating a separate TMatrix connection may claim other
available tasks when intake is enabled.

## Delivery semantics

- A local message queues for the **next turn in the current conversation**.
It does not interrupt the current model turn. The UI distinguishes queued,
runtime received, response observed, and failed. Local messages do not invent
a Tzu Do task revision or post a new task comment.
- Tzu Do task edits continue through the existing steering mailbox in the
current conversation. Delivery states advance from actual engine events.
Internal revision counters synchronize updates; they do not create
conversations or appear as task versions in the console.
- A stop request interrupts the selected worker. `stopped` is shown only after
runtime teardown succeeds; uncertain teardown is `stop_unverified`.
- Press `P` (Shift+P), or click Pin/Unpin, to retain the selected worker. A `📌 PIN`
marker identifies pinned tabs and the selected worker’s status (`PIN` in portable mode). Pins live in the engine memory: detaching and
reopening the console preserves them; restarting the engine clears them.
Pinning retains the local history, not a running capacity slot. If the console
reports that an engine update is needed, use Settings → Restart engine: replacing
the binary alone does not reload a running engine. Restart waits for active work.
- Worker tabs show running workers, pending or unverified shutdowns, and pinned
workers. Unpinned completed, stopped, and failed workers disappear on refresh; their local activity, prompt,
drafts, and reading positions are released. Unverified shutdowns stay visible
because runtime termination has not been confirmed. Unpinning a finished worker
releases it immediately; unpinning an active or unverified worker keeps it until
the normal removal checks pass.
- A local stop affects this engine, not the task's durable Tzu Do cancellation
record. The claim is suppressed for this engine's lifetime; restarting the
engine can recover it if it remains owned. Use Tzu Do cancellation for a
durable cancellation across restarts. The UI states this in its confirmation.
- Reply in Tzu Do to continue a finished worker's associated conversation;
confirmed conversation loss recovers from saved task context. These console
limits do not delete Codex's own conversation history or the private ID mappings.
- Only runtime-provided commentary, commands, output, file/tool summaries, and
status appear. No private reasoning is invented or displayed. Recent activity
is bounded in local memory (128 KiB of serialized activity per worker, with no fixed line or entry limit; finished
unpinned workers are removed immediately), plus the separate initial-prompt excerpt (200 lines / 16 KiB), and is never uploaded as a transcript to Tzu Do. Task
reporting remains structured progress metadata and compact handoffs.
When the activity budget fills, the oldest whole entries are removed; retained
entries are never cut. An individual entry larger than the budget is removed
entirely, along with older entries.



## Settings and extension points

New configurations default to 10 workers; existing saved limits are preserved.
Max workers (1–100) and poll interval (250–300000 ms) apply through the live
supervisor and persist for restart. Reducing capacity does not kill active
workers. Worker type and poller type are separate validated settings: `codex`
and `tzudo` are included. Additional harnesses use the adapter API below.
Adapter selection is saved in `config.json` and takes effect after an engine restart.

`internal/backend.Backend` separates the terminal from transport and runtime.
The HTTP implementation uses the current engine's independent `Poller` and
`RuntimeFactory` boundaries; the demo implements the same console interface.
Adapters preserve the same receipt and teardown semantics.

Settings live under the OS user configuration directory (`~/.config/tmatrix`
on Linux). JSON settings and the separate `credentials` file are owner-only.
The bridge listens on numeric loopback with a random bearer token in a private
discovery file. It rejects browser-origin requests and redirects; credentials
never appear in `status`, task comments, or screenshots. Keep the configuration
directory private. Local engine logs may contain real task content.

## Install and select a harness adapter

Codex is the default bundled adapter (`src/adapters/codex.ts`). Existing
installations need no configuration changes. The engine loads it through the
same API used by third-party Claude, Hermes, or other harness adapters. This
release includes Codex and an illustrative echo adapter; it does **not** include
working Claude or Hermes integrations.

1. Install a trusted adapter in a persistent directory outside TMatrix's release
  and staging directories. For an npm-distributed adapter, use
   `npm install --prefix /absolute/path/to/my-adapters <adapter-package>@<version>`.
   Use the package author's documented JavaScript entry point and stable adapter
   ID. For a local adapter, place its `.mjs` file and dependencies there instead.
   No TMatrix rebuild is needed. TypeScript adapters must be compiled to JavaScript.
2. Edit the existing private TMatrix `config.json` (`~/.config/tmatrix/config.json`
  on Linux, or your `--config-dir`). Preserve its other settings and add/change:
   These are illustrative values: the ID must match the module's `id` and the
   path must point to an installed adapter. On Windows, use an absolute Windows
   path with JSON-escaped backslashes. Modules are imported from local absolute
   paths; the loader never downloads or installs code.
3. Run `tmatrix engine restart` (include your usual `--config-dir` if applicable).
  Restart drains current workers before loading the new adapter. Existing
   active workers keep their current harness until then. Adapter changes cannot
   be applied from the live Settings form; other settings still work normally.
4. Set the task's model to an identifier supported by your adapter in Tzu Do.
  TMatrix passes the model, reasoning effort, and service tier through; the
   adapter must map or reject unsupported settings explicitly. Selection is
   **per engine**, not inferred from model names or chosen per ticket.

To switch back, set `worker_type` to `codex`, remove `adapter_module`, and restart.
To uninstall, switch away and drain first, then remove the external adapter's
installation. Upgrading TMatrix does not modify these external files. Changing
harnesses starts fresh from durable task context; conversation IDs and signed
continuation references are scoped to the adapter ID. Existing Codex routing is
preserved. All adapters share task ownership locks for the same queue origin.

For the standalone Node engine, use `runtime_adapter` and `adapter_module` in
its configuration, or `RUNTIME_ADAPTER` and `ADAPTER_MODULE` in its environment.
`CONFIG_PATH=/absolute/path/engine.json npm run check:config` loads and validates
that adapter without polling or creating a runtime. TMatrix's Go launcher derives
these values from its own settings and blocks inherited adapter overrides.

Adapters are trusted executable code running with the engine user's permissions,
not sandboxed plugins. Install only code you trust. The provided child environment
omits the queue's `API_KEY`, but in-process modules can access process state and
files. Configure harness authentication using its own login or credential store;
never put secrets into task results, fixtures, or adapter source.

### Write an adapter

Implement the `RuntimeAdapter` **interface** in
`[src/runtime-adapter.ts](src/runtime-adapter.ts)`. Use TypeScript's `satisfies`
for an exported object or `implements` for a class; no base class is required.
JavaScript modules can implement the same contract without TypeScript. The
interface currently lives in this source tree, not a separately published SDK.

Start with this workflow:

1. Copy `[examples/echo-adapter.mjs](examples/echo-adapter.mjs)` into your own
  adapter directory and choose a unique `id`. It is a working protocol example,
   not an implementation of a real model.
2. Replace its example turn with your harness integration. Implement
  `startThread()` and `runStreamed()` to send prepared input and translate
   harness responses into the events documented below. A JavaScript adapter can
   launch a separate Claude Code, Hermes, or custom binary; TMatrix loads the
   JavaScript module, not the binary directly.
3. Implement `close()` to stop and await all execution. Add `resumeThread()` only
  if your harness supports saved conversations. Support successive turns on
   each thread for comments and steering.
4. Test successful output, successive turns, cancellation, and teardown failure
  locally. If implementing resume, test both existing and missing conversations.
   `[src/adapters/codex.ts](src/adapters/codex.ts)` and
   `[src/app-server-codex.ts](src/app-server-codex.ts)` show a production adapter;
   `[test/adapter-loader.test.ts](test/adapter-loader.test.ts)` demonstrates
   exercising an adapter through the runner without contacting Tzu Do.
5. Compile TypeScript to JavaScript if applicable, then follow
  [Install and select a harness adapter](#install-and-select-a-harness-adapter).
   Set `worker_type` to your exported `id` and `adapter_module` to the absolute
   JavaScript entry point. Loading a new adapter requires an engine restart.

The responsibility boundary is:


| Task                      | TMatrix core                                                 | Your adapter                                               |
| ------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------- |
| Original prompt           | Builds task instructions and history                         | Sends the prepared input to the harness                    |
| New comments and steering | Routes replies and queues subsequent turns                   | Runs the next turn, resuming a conversation when supported |
| Output                    | Displays local activity and sends compact progress to Tzu Do | Emits normalized events and the final structured handoff   |
| Stop                      | Tracks cancellation and task ownership                       | Interrupts the harness and confirms shutdown               |


Your adapter does not need a Tzu Do API client or a UI.

Export a default object with `apiVersion: 1`, a stable lowercase `id` (letters,
digits and hyphens, starting with a letter, up to 64 characters), and
`create(context, profile)`. The ID `codex` is reserved for the bundled adapter.
Unsupported versions, missing exports, and ID mismatches fail startup before
polling. The contract is in `src/runtime-adapter.ts`; it does not use a provider
SDK. `examples/echo-adapter.mjs` is a complete runnable example: use
`worker_type: "echo"` and its absolute path to smoke-test loading. It deliberately
returns `AI_NEEDS_FEEDBACK` and performs no real task work.

```js
export default {
  apiVersion: 1,
  id: "my-harness",
  create({ environment, logger }, profile) {
    // Return a fresh runtime for this ticket. Do not start processes here.
    // Implement your harness transport behind these methods.
    return {
      startThread(options) { /* return a ThreadLike */ },
      // Optional: omit if the harness cannot resume persisted conversations.
      resumeThread(threadId, options) { /* return a ThreadLike */ },
      async close() { /* stop and await every owned process/session */ }
    };
  }
};
```

`create` is synchronous and runs once per ticket. It receives a fresh copy of
`environment`, a local `logger` (`warn`/`error`), and the execution profile
(`execution_mode`, `model`, `reasoning_effort`, `service_tier`). Do not share
mutable runtime state across tickets. Start subprocesses lazily in the turn,
using the supplied environment. Do not log prompts, credentials or model output.

`startThread(options)` and optional `resumeThread(id, options)` return an object
with `async runStreamed(input, options)`, which returns `{ events }`, where
`events` is an async generator. Thread options contain `model`,
`modelReasoningEffort`, `serviceTier`, `workingDirectory`, `threadName`, and the
unattended execution policy (`sandboxMode: "danger-full-access"`,
`approvalPolicy: "never"`, `networkAccessEnabled: true`). Honor the working
directory and title, map supported policies explicitly, and reject unsupported
requirements rather than waiting for interactive approval.

Turn input is either a string or an array of `{ type: "text", text }` and
`{ type: "local_image", path }`. Image files exist for the duration of the turn;
consume them before the generator ends. Handle images or report a clear
unsupported-input error. Turn options include `signal`, `outputSchema`, and an
optional async `missingConversationInput()` callback. Use that callback only
when the harness **confirms** the saved conversation is missing: start a new
conversation with its returned full context and emit the replacement ID before
executing. Transient resume failures must fail, not silently start over.

Normalize harness events into this protocol:


| Event            | Required payload / meaning                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `thread.started` | `thread_id`: stable ID, at most 255 characters; emit before executing so routing can be persisted. Omit if resumability is unavailable.                                                    |
| `turn.started`   | The harness has accepted this turn.                                                                                                                                                        |
| `item.completed` | `item: { id, type: "agent_message", text }`; the last agent message must be the structured JSON handoff below.                                                                             |
| `turn.completed` | `usage` with numeric `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`; use zero for unavailable counts. Emit only on success. |
| `turn.failed`    | `error: { message }`; a safe failure explanation.                                                                                                                                          |
| `error`          | `message`: safe fatal stream failure.                                                                                                                                                      |
| `local.activity` | `kind`, `text`: optional activity for the local console, not remote task logs.                                                                                                             |


The contract also supports command, file-change, tool, search, reasoning, and
todo items with `item.started` / `item.updated` / `item.completed` events. The
core forwards only compact progress metadata to Tzu Do. Do not emit raw harness
objects as events. A successful turn must finish with both a handoff message and
`turn.completed`; an abruptly ended stream fails.

The final agent-message text must JSON-encode exactly:

```json
{
  "outcome": "AI_DONE",
  "context_summary": "Private compact continuation state, without secrets or raw logs.",
  "user_message": "Concise result for the human, with review links when available."
}
```

`AI_NEEDS_FEEDBACK` is the other valid outcome. Both text fields must be nonempty
and at most 100,000 characters. The core supplies the JSON schema and validates
the handoff before delivery. Adapters must support successive `runStreamed`
calls on the same thread for task revisions and local steering. Never send
results to Tzu Do directly: ownership, progress, result delivery, and cancellation
receipts belong to the core.

On abort, interrupt execution and settle the stream promptly. `close()` is
mandatory and must resolve **only when all owned execution has stopped**,
including descendants. If shutdown cannot be confirmed, reject: the core keeps
ownership locks and withholds a successful cancellation receipt. A stop request
alone is not proof of termination. No-process adapters can implement a no-op
`close()`. Verify normal completion, successive turns, resume/missing history,
abort, and failed teardown before using an adapter with real tasks.

## Releases and installation

TMatrix is a standalone source project. Everything needed to build it is inside
this directory; the former parent AI Worker checkout is not used.

```text
tmatrix/                  repository root (can live anywhere)
  src/                    TypeScript engine: poll Tzu Do, run Codex, report results
  test/                   engine and worktree regression tests
  package.json            engine dependencies and build commands
  scripts/worktrees.py     checkout lifecycle used by the engine
  cmd/ and internal/      Go terminal interface and service controls
  .github/workflows/      standalone tests and release automation
```

Source and release layout are different. `npm ci` installs the engine's build
and runtime dependencies here. Staging compiles `src/` to JavaScript. GoReleaser
then packages `tmatrix` (or `tmatrix.exe`) beside `engine/dist/`, the npm lockfile,
and the worktree helper. The installer installs the engine's pinned production
npm dependencies and configures the service. End users do not need the TypeScript
source or the former parent directory. Node, Python and a Codex login remain
runtime prerequisites. The engine and terminal are separate processes delivered
as one application.

AI Worker and TMatrix use the [MIT license](LICENSE). Contributions use that
license too; third-party dependencies retain their own licenses.

GoReleaser compiles into fresh release-only staging using
`scripts/stage-release.py`. It never copies from or changes the live
`staging/engine` directory. The payload includes freshly compiled JavaScript,
the npm manifests, the worktree helper, and project/Go dependency license notices.
An external manifest records the allowed payload files. CI runs
`scripts/verify-release.py` before uploading: missing, extra, duplicate and
non-regular archive files fail the release. The six platform archives, checksums
and installer scripts are uploaded to a draft for human review. Action commits
and GoReleaser v2.18.2 are pinned. This is archive hygiene, not release signing or
provenance attestation. npm dependencies install separately with their notices.

The installers select the latest published release for amd64 or arm64 and
verify its SHA-256 checksum before installing. Linux and macOS install the TUI,
the bundled engine and its pinned npm dependencies under `~/.local`, then add
`~/.local/bin` to `.profile`, `.bashrc` and `.zshrc`. Open a new terminal afterwards.
Node.js 20.19 or 22.12+, npm, Python 3.11+ and curl are prerequisites; Linux needs a working
user systemd session, and macOS needs a logged-in GUI session for launchd.
The scripts check these prerequisites; they do not install system dependencies.
On Macs with Homebrew, `brew install node python` supplies Node/npm and Python.
On Windows, first install a WSL distribution with `wsl --install` if needed,
then install the prerequisites inside that distribution.

These commands require a published release in a public GitHub repository.
The publishing repository is `xmarkclx/tmatrix`. Public release
downloads do not require GitHub authentication; these installers do not support
private repository downloads.

```sh
curl -fsSL https://github.com/xmarkclx/tmatrix/releases/latest/download/install.sh \
  -o /tmp/tmatrix-install.sh && sh /tmp/tmatrix-install.sh
```

The repository defaults to `xmarkclx/tmatrix`; forks can use `--repo OWNER/REPO`.
Piping to `sh` also works. Downloading first prevents a
failed/truncated transfer from being executed. Use `--version v1.2.3` to pin a
release or `--prefix /absolute/path` to change the installation directory.
`TMATRIX_REPO`, `TMATRIX_VERSION`, and `TMATRIX_PREFIX` provide equivalent defaults.

On Windows, run in PowerShell:

```powershell
curl.exe -fSL https://github.com/xmarkclx/tmatrix/releases/latest/download/install.ps1 -o "$env:TEMP/tmatrix-install.ps1"
if ($LASTEXITCODE -eq 0) { powershell -ExecutionPolicy Bypass -File "$env:TEMP/tmatrix-install.ps1" }
```

The default Windows setup installs the full worker **inside an existing WSL
distribution** using the Linux installer. Use `-Distribution Ubuntu` to choose
one. WSL needs the Linux prerequisites above and systemd enabled; the installer
does not install/reboot Windows or provision a distribution. Open that WSL
terminal to run `tmatrix`; its daemon runs while WSL is running. Add `-Native`
to install the Windows binary on the Windows user PATH for `tmatrix --demo` only.
Native Windows live workers remain unsupported by the POSIX engine.

On first installation, follow the printed Codex login command, open `tmatrix`,
and connect with `c`. The installer records pending service setup; connecting
then automatically installs and starts the login service. On an already
connected installation it installs/upgrades the service immediately. Credentials,
instance identity, conversations and saved intake settings are retained.

Rerun the same installer to upgrade. It prepares a new immutable release directory,
atomically switches the TUI executable, then uses the existing service lifecycle
to pause intake, wait without a deadline for admitted workers, and start the new
engine. Keep the installer open until completion. It never deletes old bundles
or modifies a separate AI Worker service. Concurrent installers are rejected.
If interrupted, inspect the service and `~/.local/lib/tmatrix/install.lock`
before removing a stale lock. An interrupted/failed service setup returns an
error and retains both bundles; after resolving the error, run `tmatrix setup`.
There is no automatic rollback after service startup failure. Only remove old
release directories once their engines are stopped. Custom `--config-dir`
instances must be managed separately; the installer targets the default instance.

Publishing uses `.github/workflows/tmatrix-release.yml` in this directory.
It checks the engine and Go code from the repository root, then
GoReleaser creates a **draft** release for a `vX.Y.Z` tag. Review and publish the
draft to make it available through `latest`. Archives include the engine and
lockfile; `checksums.txt`, both installers and both daemon-uninstall scripts are
release assets.
Publish this directory as the repository root; no parent source or build files
are needed. The old parent service and its private configuration are not copied.

### Uninstall the daemon

On macOS or Linux/WSL:

```sh
curl -fsSL https://github.com/xmarkclx/tmatrix/releases/latest/download/uninstall-daemon.sh \
  -o /tmp/tmatrix-uninstall-daemon.sh && sh /tmp/tmatrix-uninstall-daemon.sh
```

On Windows, from PowerShell:

```powershell
curl.exe -fSL https://github.com/xmarkclx/tmatrix/releases/latest/download/uninstall-daemon.ps1 -o "$env:TEMP/tmatrix-uninstall-daemon.ps1"
if ($LASTEXITCODE -eq 0) { powershell -ExecutionPolicy Bypass -File "$env:TEMP/tmatrix-uninstall-daemon.ps1" }
```

Use the same WSL distribution as installation (`-Distribution Ubuntu` if needed).
For custom locations, the shell script accepts `--prefix` and `--config-dir`;
PowerShell accepts `-Prefix` and `-ConfigDir` as absolute **WSL paths**.
Both scripts call the installed `tmatrix service uninstall`, wait for service
workers to drain, and remove login startup. Keep the terminal open until they
finish; failures do not confirm removal. They retain the executable, PATH,
credentials, settings and conversations. They do not remove WSL or touch other
worker services. A native Windows demo has no daemon to uninstall.

If TMatrix is already on PATH, no download is needed: run
`tmatrix service uninstall` in the Mac or WSL terminal. Downloaded uninstall
scripts also work offline. Opening `tmatrix` again can start its engine;
`tmatrix service install` restores login startup after account connection.

## Verification

```sh
# Run from the standalone repository root
cd /path/to/tmatrix
npm ci
npm run check
# Stop the local engine before restaging its development bundle.
sh scripts/stage-engine.sh

# Terminal, config, transport, and optional real-engine connection lifecycle
go test -race ./...
go vet ./...
python3 scripts/test_install.py
pwsh -File scripts/test_install.ps1 # offline Windows wrapper checks; requires PowerShell
python3 scripts/test_release.py
npm audit
TMATRIX_TEST_ENGINE_DIR="$PWD/staging/engine" go test -race ./internal/app -run TestActualEngineConnectionLifecycle -v
goreleaser check
goreleaser release --snapshot --clean --skip=publish,announce
python3 scripts/verify-release.py
```

GoReleaser needs a Git checkout with commits. Run the snapshot build and archive
verification above before publishing; packaging unit tests use fixtures and do
not verify actual release artifacts. The lifecycle integration uses an isolated
config directory and fake credentials,
polls reserved `.invalid` endpoints, and does not contact Tzu Do or launch a paid model run.

SSH rendering has a separate Unix PTY regression check. It runs only the
fictional demo, with SSH environment markers and `xterm` / `xterm-256color`,
at 160×54, 80×24, and 41×16. It checks refresh, navigation, composing,
Ctrl+L, resizing, the reserved margin, and clean detach in a terminal emulator:

```sh
go build -o bin/tmatrix ./cmd/tmatrix
python3 -m venv /tmp/tmatrix-terminal-tests
/tmp/tmatrix-terminal-tests/bin/pip install pyte==0.8.2
/tmp/tmatrix-terminal-tests/bin/python scripts/test_ssh_terminal.py bin/tmatrix
```

This covers the terminal byte stream; it does not replace checking the actual
SSH client's font and terminal settings.

Protocol and packaging references: [Codex App Server](https://learn.chatgpt.com/docs/app-server),
[Bubble Tea](https://github.com/charmbracelet/bubbletea),
[GoReleaser builds](https://goreleaser.com/customization/builds/builders/go/).

### Service controls in the app

Open Settings (`s`) and choose
**Install service** (`i`) or **Uninstall service** (`u`), then confirm with `y`
or cancel with `n`/Escape. Requires the local app on macOS/launchd or Linux/systemd.

Install enables startup at login, drains existing TMatrix work, and starts the service immediately.
Uninstall waits for service workers to drain, removes the service, and retains
settings and conversations. Keep the app open while it works. Demo mode cannot
change services. Save edited execution settings separately with Ctrl+S.
See [Switching from an existing worker](#switching-from-an-existing-worker) before migrating another service.

### Switching from an existing worker

Pause intake on the existing worker and wait for its active tasks to finish.
Confirm that its engine has stopped using that service's own controls before
starting the replacement. A stop request alone does not confirm shutdown.
TMatrix does not stop or take over a separate AI Worker service automatically.
Keep the old installation and its private configuration for rollback; do not
copy credentials or runtime state into this repository.

Start TMatrix, connect it to the intended queue, and use `tmatrix status` and the
Pollers screen to verify the connection. To roll back, pause TMatrix intake,
run `tmatrix engine stop`, and confirm shutdown before restarting the previous
service. Never run both services with the same instance identity.