# Bundled Codex CLI updates

TMatrix updates its bundled Codex CLI independently of TMatrix releases. The
engine starts a background check at startup and repeats it every 24 hours while
running. Worker intake does not wait for registry requests, installation or
verification. This applies to the bundled `codex` adapter; custom adapters keep
their own runtime lifecycle.

## Check or roll back

Open **Settings**, then press **o** for **Codex updates**. The page shows the
current and previous versions, the latest stable version found, check times and
the update status. Its actions are also clickable:

| Key | Action | Effect |
| --- | --- | --- |
| **c** | **Check now** | Start an asynchronous check; watch the status for completion. |
| **b** | **Roll back** | Verify the retained previous version and activate it for new workers. Available when a previous version exists. |
| **Esc** | Back | Return to Settings. |

Only one check or rollback runs at a time. A request being accepted does not mean
an update has finished. Automatic checks retain their 24-hour schedule after a
manual check.

Rollback swaps the current and previous versions and records the version being
replaced. Subsequent automatic and manual checks skip that exact version, so
**Check now** does not immediately undo the rollback. A newer stable release can
be installed normally. **Roll back** again explicitly swaps the retained versions
back after verification.

## Installation and activation

The updater resolves the `latest` tag for `@openai/codex` at the official npm
registry. It accepts plain stable `major.minor.patch` versions only, then resolves
the exact native platform package declared by that release. Supported targets
are Linux, macOS and Windows on x64 and arm64. It does not install preview tags or
invoke npm, package lifecycle scripts, a shell installer or an external archive
tool.

1. Download the native package into a fresh temporary version directory. HTTPS
   requests stay on the official registry, disallow redirects and have deadlines
   and size limits.
2. Verify the package's SHA-512 integrity before extracting it. Extraction accepts
   ordinary USTAR files and directories, rejects links, unsafe paths and duplicate
   entries, and limits expanded size. The complete native distribution is kept,
   including search helpers, other executables, resources and licenses.
3. Confirm the package identity, run `codex --version`, initialize an isolated
   App Server and request a nonempty, valid model list. These probes do not start
   or resume a conversation. The probes follow the official [App Server protocol](https://learn.chatgpt.com/docs/app-server). Verification must also confirm process shutdown.
4. Move the verified candidate to an immutable version directory and atomically
   replace the local current/previous manifest. Only then can new workers select
   it. Before the first upgrade, copy the original bundled native distribution
   into the managed store as the previous version, preserving that rollback
   target across changes to TMatrix's installation.

An unavailable registry, corrupt package, unsupported archive layout or failed
probe leaves the current version selected. Settings displays a compact failure
message without raw CLI output. A later check can retry. An unavailable, invalid
or already-owned update store disables updates for that engine and falls back to
the bundled CLI so workers can continue.

## Worker isolation and retention

Each new worker acquires its executable path and a durable version pin before its
runtime can start. Activation never changes that path for an existing worker.
No update action restarts the engine, pauses intake or interrupts active workers.

The current and previous installations are retained. Older versions are eligible
for deletion only when they have no pins. A pin is released after the runtime's
`close()` confirms shutdown; requesting cancellation or reporting task completion
alone does not release it. Failed teardown retains the pin. The original TMatrix
bundle itself is never garbage-collected by the updater and remains the fallback
if the managed store cannot safely supply a worker pin.

The updater owns CLI files and its own manifest only. It uses the existing
sanitized worker environment and `CODEX_HOME`; authentication remains in its
existing location. Conversation routing, task ownership, cancellation receipts
and drain handling continue through the existing worker lifecycle.

## Storage and recovery

Stores are isolated by engine instance:

| Engine launch | Update store |
| --- | --- |
| TMatrix-managed engine | `codex/` beside `TMATRIX_CONTROL_FILE` |
| Standalone engine | `$XDG_STATE_HOME/tmatrix/codex/<instance-hash>/`, or `~/.local/state/tmatrix/codex/<instance-hash>/` when `XDG_STATE_HOME` is unset |

The standalone hash is SHA-256 of the poll origin, a newline and the instance ID.
The store contains `current.json`, immutable `v-<uuid>/` installations, version
`.pins/` directories and an ownership lock. A second engine cannot update a store
whose owner process is still present. The ownership lock is recovered only when
the recorded process is demonstrably gone; ambiguous state is preserved. If an
interrupted ownership-recovery guard disables updates, confirm that all engines
using the store have exited before removing the stale `.owner.recovery` directory
and restarting the engine. Do not remove another live engine's `.owner` lock.

After a crash, durable pins can outlive their workers. A verification process
whose shutdown could not be confirmed also leaves its `.candidate-*` directory
intact. These are deliberately not removed automatically. Before manually
removing an orphan pin or retained candidate, independently confirm that no
process still uses that version, including child processes from a crashed engine.
An engine restart or a stop request alone is insufficient evidence. Keeping these
artifacts uses disk space but protects any remaining execution.

Routine failed downloads and verification failures with confirmed process exit
clean up their temporary candidates. Check times and status describe the current
engine session; the selected versions and rollback hold survive restarts through
the manifest. The store does not contain task logs, copied credentials or
conversation data.
