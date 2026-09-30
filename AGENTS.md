# TMatrix contributor instructions

This directory is the standalone project root. Do not import build inputs,
dependencies, credentials, or configuration from the former parent AI Worker
checkout. The engine source is in `src/`, its tests are in `test/`, and the Go
terminal/service code is in `cmd/` and `internal/`.

- Keep credentials, local configuration, logs and real task data out of source,
  fixtures and release artifacts. Tzu Do receives structured results and compact
  continuation context, not raw runtime logs or tool output.
- Preserve conversation routing, cancellation receipts, worker ownership and
  drain semantics. A stop request is not confirmation that execution stopped.
- Keep the terminal separate from transport and runtime logic. Keep helpers
  small and dependencies explicit; do not reorganize unrelated code.
- `npm ci` installs this project's pinned engine dependencies. Run `npm run check`
  for TypeScript and worktree tests; run `go test -race ./...` and `go vet ./...`
  for Go changes. Rebuild `bin/tmatrix` with `go build -o bin/tmatrix ./cmd/tmatrix`.
- `scripts/stage-engine.sh` refreshes the development runtime; only restage it
  when that engine is stopped. `scripts/stage-release.py` builds separate clean
  release staging and never modifies the running development engine.
- Release checks are `python3 scripts/test_release.py`,
  `python3 scripts/test_install.py`, and `scripts/verify-release.py` after a
  GoReleaser build. Keep the manifest-based archive verification before upload.
- Follow ticket-specific delivery/worktree instructions. Do not restart running
  services or publish a release as a side effect of a source build.
