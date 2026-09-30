#!/bin/sh
# Usage: sh install.sh [--repo OWNER/REPO] [--version vX.Y.Z]
# Requires a published release; defaults to the official public repository.
set -eu
repo=${TMATRIX_REPO:-xmarkclx/tmatrix}
version=${TMATRIX_VERSION:-latest}
prefix=${TMATRIX_PREFIX:-"$HOME/.local"}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --help) echo "Usage: install.sh [--repo OWNER/REPO] [--version vX.Y.Z] [--prefix /absolute/path]"; exit 0 ;;
    --repo|--version|--prefix) [ "$#" -ge 2 ] || { echo "Missing value for $1" >&2; exit 1; }; case "$1" in
    --repo) repo=$2; shift 2 ;;
    --version) version=$2; shift 2 ;;
    --prefix) prefix=$2; shift 2 ;;
    esac ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
case "$repo" in
  ''|*[!a-zA-Z0-9_./-]*|/*|*/|*..*|*/*/*) echo 'Set --repo OWNER/REPO to the published TMatrix repository.' >&2; exit 1 ;;
  */*) ;;
  *) echo 'Repository must be OWNER/REPO.' >&2; exit 1 ;;
esac
case "$version" in *[!a-zA-Z0-9._-]*|'') echo 'Invalid release version.' >&2; exit 1 ;; esac
case "$prefix" in /*) ;; *) echo 'Prefix must be an absolute path.' >&2; exit 1 ;; esac
for tool in curl tar node npm python3 install; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing prerequisite: $tool" >&2; exit 1; }
done
node -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(!((major===20&&minor>=19)||(major===22&&minor>=12)||major>22))process.exit(1)' || { echo 'Node.js 20.19 or 22.12+ is required by the Codex adapter.' >&2; exit 1; }
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3,11) else 1)' || { echo 'Python 3.11+ is required by the worker lifecycle.' >&2; exit 1; }
case $(uname -s) in Linux) os=linux ;; Darwin) os=darwin ;; *) echo 'Use WSL or the Windows release ZIP.' >&2; exit 1 ;; esac
case $(uname -m) in x86_64|amd64) arch=amd64 ;; arm64|aarch64) arch=arm64 ;; *) echo 'Supported CPUs: amd64 and arm64.' >&2; exit 1 ;; esac
temp=$(mktemp -d)
lock=
cleanup() { rm -rf "$temp"; if [ -n "$lock" ]; then rmdir "$lock"; fi; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
if [ "$version" = latest ]; then
  curl -fsSL --proto '=https' "https://api.github.com/repos/$repo/releases/latest" -o "$temp/release.json"
  version=$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!/^v?[0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9.-]+)?$/.test(j.tag_name||""))process.exit(1);process.stdout.write(j.tag_name)' "$temp/release.json")
fi
tag=$version
case "$tag" in v*) archive_version=${tag#v} ;; *) archive_version=$tag; tag=v$tag ;; esac
archive="tmatrix_${archive_version}_${os}_${arch}.tar.gz"
base="https://github.com/$repo/releases/download/$tag"
curl -fsSL --proto '=https' "$base/$archive" -o "$temp/$archive"
curl -fsSL --proto '=https' "$base/checksums.txt" -o "$temp/checksums.txt"
# Verify exactly the requested archive, before unpacking or executing anything.
node - "$temp" "$archive" <<'NODE'
const fs=require('fs'),crypto=require('crypto'),path=require('path');
const [dir,name]=process.argv.slice(2);
const matches=fs.readFileSync(path.join(dir,'checksums.txt'),'utf8').split(/\r?\n/).filter(line=>line.trim().split(/\s+/)[1]===name);
if(matches.length!==1)throw new Error('Archive checksum missing or ambiguous');
const expected=matches[0].trim().split(/\s+/)[0];
const actual=crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,name))).digest('hex');
if(!/^[a-f0-9]{64}$/.test(expected)||actual!==expected)throw new Error('Archive checksum mismatch');
NODE
tar -xzf "$temp/$archive" -C "$temp"
[ -f "$temp/tmatrix" ] && [ -f "$temp/engine/dist/index.js" ] || { echo 'Incomplete release bundle.' >&2; exit 1; }
# Install platform-specific Codex dependencies before replacing an existing install.
(cd "$temp/engine" && npm ci --omit=dev --no-audit --no-fund)
# Serialize installers; a crashed installer leaves an explicit lock for inspection.
mkdir -p "$prefix/bin" "$prefix/lib/tmatrix/releases"
lock="$prefix/lib/tmatrix/install.lock"
if ! mkdir "$lock" 2>/dev/null; then
  lock=
  echo 'Another install is running, or install.lock needs inspection after an interrupted install.' >&2
  exit 1
fi
# Unique immutable bundles keep old runtime code available throughout draining.
bundle=$(mktemp -d "$prefix/lib/tmatrix/releases/${archive_version}.XXXXXX")
mv "$temp/engine" "$bundle/engine"
install -m 755 "$temp/tmatrix" "$bundle/tmatrix"
# Atomic rename works even while the old executable is in use.
ln -s "$bundle/tmatrix" "$temp/tmatrix-link"
mv -f "$temp/tmatrix-link" "$prefix/bin/.tmatrix-new"
mv -f "$prefix/bin/.tmatrix-new" "$prefix/bin/tmatrix"
export PATH="$prefix/bin:$PATH"
# Persist PATH without interpolating executable shell syntax from custom paths.
python3 - "$prefix/bin" <<'PYTHON'
import os, pathlib, shlex, sys
home = pathlib.Path.home()
line = '\n# TMatrix installer\nexport PATH=' + shlex.quote(sys.argv[1]) + ':"$PATH"\n'
for name in ('.profile', '.bashrc', '.zshrc'):
    path = home / name
    text = path.read_text() if path.exists() else ''
    if line not in text:
        with path.open('a') as f: f.write(line)
PYTHON
echo "Installed: $prefix/bin/tmatrix (open a new terminal to refresh PATH)"
echo "Authenticate Codex: $bundle/engine/node_modules/.bin/codex login"
# The new CLI drains existing workers via the bridge and refreshes the OS service.
# First installs defer service creation until the user connects with credentials.
if ! "$prefix/bin/tmatrix" --engine-dir "$bundle/engine" setup; then
  echo "Service setup incomplete. Bundle retained at $bundle; rerun tmatrix setup after resolving the reported error. Previous releases are retained." >&2
  exit 1
fi
