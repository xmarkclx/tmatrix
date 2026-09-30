#!/bin/sh
# Produce a portable runtime bundle without changing the installed worker dist/.
set -eu
tmatrix_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
source_dir="$tmatrix_dir"
destination="$tmatrix_dir/staging/engine"
mkdir -p "$destination/dist" "$destination/scripts"
cd "$source_dir"
./node_modules/.bin/tsc -p tsconfig.build.json --outDir "$destination/dist" --sourceMap false --declaration false
cp package.json package-lock.json "$destination/"
cp scripts/worktrees.py "$destination/scripts/"
