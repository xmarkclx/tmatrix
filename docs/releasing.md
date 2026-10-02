# Release and install

After merging the changes, run from a clean, full-history checkout on the
origin default branch (currently `main`):

```sh
python3 scripts/release.py v0.1.7
```

Choose a new stable `vMAJOR.MINOR.PATCH` greater than all existing stable tags.
The command fetches tags, pulls with `--ff-only`, checks that the local commit
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

Local installation supports Linux, macOS and WSL and requires `sh`, `curl`,
`tar`, `install` and `uname`. It downloads the installer attached to the published
tag; that installer verifies the platform archive checksum, installs immutable
bundles, and invokes the existing setup flow. Existing workers finish before the
new engine starts, so keep the command open. Node.js/npm must be ready on Linux;
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

To publish without installing on the release machine:

```sh
python3 scripts/release.py v0.1.7 --skip-install
```

## Failure recovery

- A failed pull or preflight never creates a new tag. Resolve the reported
  branch, checkout or prerequisite issue before retrying.
- Failed checks/builds retain the local tag for inspection. If it still points
  to the clean current origin commit and nothing reached origin, rerun the same
  command. If source fixes need a new commit, inspect and delete only the
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
  A setup error or stop request does not prove a requested drain has completed.

For a build without any remote writes or installation, the original
`python3 scripts/release-local.py v0.1.7` remains available for an existing local
tag at HEAD. Building a source binary alone never publishes or installs a release.
