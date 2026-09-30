# The live Windows daemon is installed inside WSL, not as a Windows service.
[CmdletBinding()]
param(
    [string]$Distribution,
    [string]$Prefix,
    [string]$ConfigDir
)
$ErrorActionPreference = 'Stop'
if (!(Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    throw 'The TMatrix daemon uses WSL. Native Windows demo installations have no daemon to uninstall.'
}
$wslArgs = @()
if ($Distribution) { $wslArgs += @('-d', $Distribution) }
# Pass paths as arguments, never interpolate them into shell source. Call the
# installed CLI directly, so removal works without a network connection.
$uninstallScript = @'
set -eu
prefix=$1
[ "$prefix" != '-' ] || prefix="$HOME/.local"
case "$prefix" in /*) ;; *) echo 'Prefix must be an absolute WSL path.' >&2; exit 1;; esac
binary="$prefix/bin/tmatrix"
[ -x "$binary" ] || { echo "TMatrix not found at $binary" >&2; exit 1; }
lock="$prefix/lib/tmatrix/install.lock"
mkdir -p "$prefix/lib/tmatrix"
mkdir "$lock" || { echo 'Another install/uninstall is running; inspect install.lock if interrupted.' >&2; exit 1; }
trap 'rmdir "$lock"' EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
if [ "$2" != '-' ]; then
  case "$2" in /*) ;; *) echo 'ConfigDir must be an absolute WSL path.' >&2; exit 1;; esac
  "$binary" --config-dir "$2" service uninstall
else
  "$binary" service uninstall
fi
'@
# Normalize Windows line endings before passing shell source to WSL.
$uninstallScript = $uninstallScript.Replace("`r", "")
# Nonempty placeholders survive Windows PowerShell's native argument passing.
$prefixArg = if ($Prefix) { $Prefix } else { '-' }
$configArg = if ($ConfigDir) { $ConfigDir } else { '-' }
Write-Host 'Removing the TMatrix daemon. Keep this terminal open while active work drains.'
& wsl.exe @wslArgs -- sh -c $uninstallScript sh $prefixArg $configArg
if ($LASTEXITCODE -ne 0) { throw 'Daemon removal failed. Inspect the WSL error above; removal has not been confirmed.' }
Write-Host 'TMatrix daemon removed from WSL. Application, PATH, settings and conversations are retained. Opening tmatrix can start its engine again.'
