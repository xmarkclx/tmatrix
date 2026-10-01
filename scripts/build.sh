#!/bin/sh
# Build a local CLI with the same commit-count identity as release binaries.
# Usage: sh scripts/build.sh [output-path]
set -eu
cd "$(dirname "$0")/.."
if [ "$(git rev-parse --is-shallow-repository)" = true ]; then
  echo 'A full Git history is required for the build number; run git fetch --unshallow.' >&2
  exit 1
fi
count=$(git rev-list --count HEAD)
commit=$(git rev-parse HEAD)
version=$(git describe --tags --exact-match HEAD 2>/dev/null) || version=dev
# Exact tags are optional locally; only pass safe version text into Go ldflags.
case "$version" in *[!a-zA-Z0-9._-]*) version=dev ;; esac
if [ -n "$(git status --porcelain)" ]; then commit="$commit-dirty"; fi
go build -ldflags "-X main.version=$version -X main.commit=$commit -X main.commitCount=$count" -o "${1:-bin/tmatrix}" ./cmd/tmatrix
