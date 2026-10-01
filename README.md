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

For an installed app and background daemon, see [Install on Mac or Windows](#releases-and-installation). To remove login startup later, see [Uninstall the daemon](#uninstall-the-daemon).



## Build releases on your machine

Release compilation and packaging run locally. GitHub Actions still checks pull
requests and pushes to `main`, but tag pushes do not start hosted release builds.
GitHub only stores the uploaded release assets.

Use Linux, macOS, or WSL with full Git history, a current Go toolchain, Node/npm,
Python 3.11+, PowerShell (`pwsh`, for the Windows installer tests), and GoReleaser
2.18.2. Uploads also require authenticated GitHub CLI (`gh auth login`) and Git
push access to `origin`.

From a clean checkout of the commit you want to release:

```sh
git fetch origin main --tags
git switch main
git pull --ff-only origin main
git tag v0.1.2 # choose a new version; one version tag per commit
python3 scripts/release-local.py v0.1.2 --upload
```

The command runs the CI checks locally, builds all six Linux/macOS/Windows
archives, embeds the commit count and hash, and verifies the archive manifest.
Only after verification does it push the tag and upload a **draft**. It never
restarts the daemon or modifies the running development engine. Omit `--upload`
to build and verify without pushing or uploading anything.

After reviewing the draft:

```sh
gh release edit v0.1.2 --repo xmarkclx/tmatrix --draft=false --latest
```

Publishing makes the existing `releases/latest/download/install.sh` URL serve
the new installer. Failed local builds leave the local tag available for a retry;
the command never moves tags or overwrites an existing release. If an upload
fails partway through, inspect its draft before retrying. Changes to the source
require committing them and choosing a matching new tag.
