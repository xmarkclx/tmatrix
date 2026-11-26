# TMatrix

Use your own AI subscriptions, computers and models to add AI powers to supported apps.

Save money since AI subscriptions are cheaper, your own computers are already paid for (vs expensive cloud servers).
Furthermore the models you pay for are possibly more powerful, and you already pay for them so may as well use them.

Concept:
- Your computer runs TMatrix app, this app, which is very easy to install/uninstall.
- TMatrix orchestraters tasks, pollers and workers.
- A **poller** gets tasks from a **source** like tzudo.app.
- An **AI worker** runs those tasks with Codex or Claude Code.
- This goes on until the number of workers limit is reached. You can set the max # yourself.

---

Created for [Tzudo](https://tzudo.app/), the ultimate to do list and time tracker to 10x your productivity and work stress-free.

![example](images/sample.png)

## Quick install

Mac, Linux, or Windows WSL:

```sh
curl -fsSL https://github.com/xmarkclx/tmatrix/releases/latest/download/install.sh | sh
```

- Open `tmatrix`, press `c`, and add TzuDo using your worker API key from https://tzudo.app/settings.

Press `s` to open Settings and view the TMatrix version, build number, and commit at the top.

## Route work across subscriptions

Sign Codex in to ChatGPT under the user that runs TMatrix. To add Claude, [install Claude Code](https://code.claude.com/docs/en/setup) 2.1.220 or newer and run `claude auth login` under that same user. In Claude's account settings, turn off **Usage credits** so Claude can report when its subscription is exhausted. TMatrix looks for `claude` on `PATH` and in `~/.local/bin`. Set `TMATRIX_CLAUDE_PATH` in the engine environment for a different location.

TMatrix checks allowance before each new turn. By default it tries the Codex plan, then the Claude plan, then Codex credits. When Codex reports an exhausted plan and available credits, TMatrix uses credits if Claude's plan is exhausted or unavailable, including when Claude Code is signed out or has no paid subscription. If Claude's usage report cannot be read, Claude still gets the turn and fails clearly if its plan is spent; other unverifiable routes report the reason without starting a turn. Any completed handoff is saved. Codex can draw from credits if its plan runs out during an active turn. [OpenAI credit billing](https://help.openai.com/en/articles/12642688-using-credits-for-flexible-usage-in-chatgpt-plus-pro)

Press `s` to open **Settings**, move to **Routing policy**, and use Left or Right to choose a policy. Press `Ctrl+S` to save. You can put Claude first, omit the Codex credits fallback, or choose a single provider. A policy change applies to new turns.

Open a worker to see which provider and allowance TMatrix selected. A task stays on the provider that holds its conversation while that plan has allowance, so follow-ups keep their context. When the provider changes, TMatrix starts a conversation with the task's saved handoff and the new input. The terminal shows each provider's responses and tool activity. Active turns stay with their current provider.

TMatrix checks Anthropic's stable npm channel at startup and daily. Open **Settings**, press `o` for **Runtime updates**, and use Left or Right to choose a provider. TMatrix verifies each Claude Code release in its private runtime store before selecting it. Active workers keep the version they started with. Set `DISABLE_UPDATES=1` in the engine environment to turn off Claude update checks.

TMatrix reports included plan allowance and available paid balances to Tzu Do when it has one production Tzu Do source. It refreshes these figures at startup and every five minutes while the engine runs. Claude Code does not report a prepaid balance, so Tzu Do can show Claude's plan allowance and whether Usage credits are off.

To report to one account when several production sources are configured, set `TMATRIX_USAGE_SOURCE_ID` in the engine or service environment to that source's `id` in `config.json`. Use the same setting to opt in to reporting on official Tzu Do staging or a PR preview. Use `legacy` for a single-source legacy engine. A missing or invalid selection on a multi-account engine leaves reporting off.

## Watch and talk to Claude workers

Open a worker to follow it live: the activity log shows Claude's replies, each tool call with its input (commands, file paths, edits), a preview of each tool result, and todo updates. Press `Enter` to send a message into the running conversation; Claude handles it after its current step, in the same session. Each new Tzu Do comment resumes the task's Claude conversation, so context and the prompt cache carry over. If a task moves to the other provider because a plan ran out, the worker says so in its reply.

## Connect multiple sources

One TMatrix instance can poll several supported apps. Existing installations keep their saved connection, key, poller identity, and conversations when the settings upgrade.

1. Press `c` to add a source.
2. Enter a name, the complete HTTPS poll URL, and that source's worker API key.
3. Press `Ctrl+S` to save. TMatrix starts the new poller while existing workers continue. If intake is paused, the new source also waits for you to resume.

For Mindmap chat, use this complete poll URL and the dedicated key from **Settings → Integrations → Set up TMatrix**:

```text
https://mindmap.tzudo.app/api/ai-chat/worker/poll
```

One Mindmap connection serves your account's maps in that team, including LifeCCC. It uses a different key from the team graph API. Entering only a server domain selects the default TzuDo `/api/v1/ai/poll` endpoint.

Press `p` to inspect each source's status. Use Up and Down to select a source, `e` to edit it, or `d` to request removal and `y` to confirm. A blank key while editing reuses only the selected source's saved key. Adding a source always requires its own key. Editing or removing a source waits for active work before restarting. Removing the last source leaves the console disconnected.

The maximum worker count limits all sources together. Space pauses or resumes new intake across every source. Worker cards identify the source that owns each task. Source credentials stay in separate private files on this machine.

For offline conversation recovery, select the source ID shown in Pollers when several sources are configured:

```sh
tmatrix --source <source-id> conversation recover <canonical-task-id> --confirm-runtime-stopped
```

**Uninstalling** 
Removes the daemon and tmatrix command from path:

```sh
tmatrix service uninstall && rm -f "$HOME/.local/bin/tmatrix"
```

# Security Recommendations
- Best to run on its own secure environment like on a VM.
- Turn off / pause intake when not being used.


## Executing-worker security warnings

See [security warnings](docs/security-alerts.md) for the executing agent's advisory
action, private runtime integration, Tzu Do mail endpoint and delivery limits.

## Engine launch logs

The daemon rotates `engine-launch.log` at 10 MiB and keeps three backups.
See [engine launch logs](docs/launch-logs.md) for retention and upgrade behavior.
