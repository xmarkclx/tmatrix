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

