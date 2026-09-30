#!/bin/sh
# Remove the login service; retain the application, PATH and private user data.
set -eu
prefix=${TMATRIX_PREFIX:-"$HOME/.local"}
config_dir=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --help) echo 'Usage: uninstall-daemon.sh [--prefix /absolute/path] [--config-dir /absolute/path]'; exit 0 ;;
    --prefix|--config-dir)
      [ "$#" -ge 2 ] || { echo "Missing value for $1" >&2; exit 1; }
      case "$2" in /*) ;; *) echo 'Paths must be absolute.' >&2; exit 1 ;; esac
      case "$1" in --prefix) prefix=$2 ;; --config-dir) config_dir=$2 ;; esac
      shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
case "$prefix" in /*) ;; *) echo 'Prefix must be an absolute path.' >&2; exit 1 ;; esac
binary="$prefix/bin/tmatrix"
[ -x "$binary" ] || { echo "TMatrix not found at $binary; use --prefix for a custom installation." >&2; exit 1; }
# Use the same lock as the installer so an upgrade cannot replace the service
# while this command is removing it. Never remove another process's lock.
lock="$prefix/lib/tmatrix/install.lock"
mkdir -p "$prefix/lib/tmatrix"
if ! mkdir "$lock" 2>/dev/null; then
  echo 'Another install/uninstall is running, or install.lock needs inspection after an interrupted operation.' >&2
  exit 1
fi
trap 'rmdir "$lock"' EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
echo 'Removing the TMatrix daemon. Keep this terminal open while active work drains.'
if [ -n "$config_dir" ]; then
  "$binary" --config-dir "$config_dir" service uninstall
else
  "$binary" service uninstall
fi
echo 'Daemon removed. TMatrix, PATH, settings, credentials and conversations are retained.'
echo 'Opening tmatrix can start its engine again. Run tmatrix service install to restore login startup.'
