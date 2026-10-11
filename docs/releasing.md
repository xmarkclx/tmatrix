# Release and install

After merging the changes, run from a clean, full-history checkout on the
origin default branch (currently `main`):

```sh
python3 scripts/release.py
```

The command fetches tags and selects the next patch version after the highest
stable `vMAJOR.MINOR.PATCH` tag, comparing versions numerically. For example,
`v0.1.6` becomes `v0.1.7`; prerelease and malformed tags are ignored. Without any
stable tags it starts at `v0.1.0`. It reports the selected version. To choose a
minor or major release instead, supply an explicit version:

```sh
python3 scripts/release.py v0.2.0
```

The command pulls with `--ff-only`, checks that the local commit
equals origin, and creates a local tag. It calls `release-local.py --upload`
to run the existing checks, build all six platform archives, verify their
manifest-based contents, push the tag explicitly, and upload a draft. Only after
that succeeds does it publish the draft as latest and install that exact version
on the machine running the command. It does not push branch commits, move tags,
or replace existing releases/assets.

Prerequisites for publishing: Python 3, Git, authenticated GitHub CLI with release
write access to origin, Go, Node.js/npm, GoReleaser v2 and PowerShell (`pwsh`).
The existing local release script runs the TypeScript/Go tests, installer tests,
security audits and archive checks. Release staging remains separate from the
development engine.

The module prefers the patched Go 1.27.2 toolchain while retaining the Go 1.25
language minimum. With `GOTOOLCHAIN=auto`, Go selects this compiler or a newer
installed compiler and downloads it if needed. If `govulncheck` reports standard
library vulnerabilities, check `go env GOVERSION` from this checkout.
`GOTOOLCHAIN=local` or an explicit older version can prevent the upgrade.
Retry with automatic selection:

```sh
GOTOOLCHAIN=auto python3 scripts/release.py
```

The vulnerability check still blocks affected code. Follow the tag recovery
instructions below if the source commit changed after a failed release.

GitHub Actions workflows are not needed for this machine-run release process.
The local release command owns validation, building, archive verification and
publication; GitHub hosts the source and uploaded releases. All checks must
succeed locally before any release tag or asset is uploaded.

Local installation supports Linux, macOS and WSL and requires `sh`, `curl`,
`tar`, `install` and `uname`. It downloads the installer attached to the published
tag; that installer verifies the platform archive checksum, installs immutable
bundles, and invokes the existing setup flow. Installation is deferred while
workers are active. The existing daemon keeps processing its queue; retry
installation when it is idle. Node.js/npm must be ready on Linux;
the installer can provision missing runtimes on macOS. The install prefix defaults
to `TMATRIX_PREFIX` or `~/.local` and can be set with `--prefix /absolute/path`.
Run as the user whose installation and daemon should be updated.

To install the latest published version without pulling, building, tagging or
publishing, use this from any working directory (with the script path pointing
to this checkout):

```sh
python3 scripts/release.py --install-only
```

This needs Git and authenticated `gh` to resolve origin and download its release
installer, plus the installation prerequisites. It resolves latest once and pins
both installer and archive to that tag. An installed TMatrix also supports
`tmatrix update` without needing this checkout or GitHub CLI.

For the security-warning fix, confirm the latest published release contains
[PR #33](https://github.com/xmarkclx/tmatrix/pull/33) before using `--install-only`
or `tmatrix update`. Building a local CLI binary alone does not update the running
engine.

To publish without installing on the release machine:

```sh
python3 scripts/release.py --skip-install
```

## Failure recovery

- A failed pull or preflight never creates a new tag. Resolve the reported
  branch, checkout or prerequisite issue before retrying.
- Failed checks/builds retain the local tag for inspection. If it still points
  to the clean current origin commit and nothing reached origin, rerun the same
  command; automatic selection reuses that unpublished tag at HEAD. A commit
  already tagged on origin cannot be released again. If source fixes need a new
  commit, inspect and delete only the
  unpublished local tag before retrying; published tags must never be moved.
- A failed upload may have pushed the tag or created a draft. The wrapper refuses
  tags already on origin rather than overwrite or assume the draft is complete.
  Inspect GitHub first. If only the tag was pushed, the existing
  `python3 scripts/release-local.py v0.1.7 --upload` can rebuild, reverify and create
  the missing draft from that clean tagged commit. If a partial draft exists,
  manually reconcile its assets against the verified archives before publishing.
- If publication fails, inspect the verified draft and its current state before
  retrying `gh release edit v0.1.7 --repo xmarkclx/tmatrix --draft=false --latest`.
- Failed local installation leaves the published release intact. Inspect
  `tmatrix status` and resolve any installation/setup problem before using
  `--install-only` (which selects the latest published version at retry time).
  A setup error or stop request does not prove the old engine exited.

For a build without any remote writes or installation, the original
`python3 scripts/release-local.py v0.1.7` remains available for an existing local
tag at HEAD. Building a source binary alone never publishes or installs a release.

## Idle-only upgrades

`tmatrix update`, the release installer, `tmatrix setup`, and service installation
refuse upgrades while
workers are active. A deferred attempt leaves the existing CLI, engine settings,
service, and intake unchanged. There is no automatic retry that pauses the queue.
Run the update again when the daemon is idle.

The installer verifies and prepares the release, then asks the old engine to
stop only if it is still idle. A worker admitted after preflight defers the
upgrade. Installation proceeds only after the engine removes its discovery
record on exit. If the daemon cannot be reached or its state cannot be verified,
the upgrade is deferred.

Engines released before the idle-only shutdown protocol require a one-time
manual stop: after workers finish, run `tmatrix engine stop`, wait for the engine
to exit, then retry the upgrade. The installer never falls back to an unguarded
shutdown of an older engine. Explicit engine restarts and operator stop requests
retain their existing drain behavior.
