# TMatrix

Use your own AI subscriptions, computers and models to add AI powers to supported apps.

Save money since AI subscriptions are cheaper, your own computers are already paid for (vs expensive cloud servers).
Furthermore the models you pay for are possibly more powerful, and you already pay for them so may as well use them.

Concept:
- Your computer runs TMatrix app, this app, which is very easy to install/uninstall.
- TMatrix orchestraters tasks, pollers and workers.
- A **poller** gets tasks from a **source** like tzudo.app.
- An **AI worker** works on those tasks, a worker can be something like Codex.
- This goes on until the number of workers limit is reached. You can set the max # yourself.

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

- Connect using your TzuDo API key on https://tzudo.app/settings.
- Currently only supports Codex for now. Claude Code Integration is on the roadmap.

**Uninstalling** 
Removes the daemon and tmatrix command from path:

```sh
tmatrix service uninstall && rm -f "$HOME/.local/bin/tmatrix"
```

# Security Recommendations
- Best to run on its own secure environment like on a VM.
- Turn off / pause intake when not being used.


## Prompt security alerts

See [security alerts](docs/security-alerts.md) for the independent, alert-only
classifier, existing adapter authentication, Tzu Do mail endpoint and operational limits.

### Team workers

Set `TEAM_ID` to a Team UUID (or add `"team_id": "<Team UUID>"` in the engine configuration) to select one Team. For the standalone TMatrix daemon, set `team_id` in its private `config.json`; the Go launcher forwards it to the engine. A Team Leader must grant the API key access, and its owner must remain an active member. Polls, ticket history, progress, results and cancellation acknowledgments all send the same Team selection; the control WebSocket does too. Omit `TEAM_ID` for Personal work. A granted key does not select a Team automatically.

Access revocation prevents later reads and writes, including results from a worker already running. Granting access again does not revive a prior claim.
