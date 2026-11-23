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

## Run with Claude Code

1. [Install Claude Code](https://code.claude.com/docs/en/setup) 2.1.220 or newer and run `claude auth login` as the user who runs TMatrix. The engine looks on `PATH` and in `~/.local/bin`. To use a different executable, set `TMATRIX_CLAUDE_PATH` to its absolute path in the engine environment.
2. In the TMatrix `config.json`, set `"worker_type": "claude"` and remove `adapter_module` if present. The default settings directory is `~/.config/tmatrix` on Linux and `~/Library/Application Support/tmatrix` on macOS. Use the directory passed to `--config-dir` if you set one.
3. Run `tmatrix engine restart` to drain active work and apply the setting. Open a worker in the terminal to follow Claude's responses and tool activity. Messages sent during a turn enter the next turn in that conversation.

One runtime handles all sources on an engine. Use the same runtime on engines that share a source queue. Claude uses the configured model when you give it a Claude model ID or alias. Existing Codex model settings use Sonnet on Claude engines.

TMatrix checks Anthropic's stable npm channel at startup and daily. Open **Settings → Runtime updates** to check now. The engine verifies each new binary in its private runtime store before selecting it for new workers. Active workers keep the version they started with. TMatrix keeps the two most recent managed releases and disables Claude's own update prompts inside worker sessions. Set `DISABLE_UPDATES=1` in the engine environment to turn off update checks.

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
