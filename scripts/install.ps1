# Full worker installation uses WSL; -Native installs the Windows demo binary.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')][string]$Repo,
    [ValidatePattern('^(latest|v?[0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9.-]+)?)$')][string]$Version = 'latest',
    [switch]$Native,
    [string]$Distribution
)
$ErrorActionPreference = 'Stop'
if (!$Native) {
    if (!(Get-Command wsl.exe -ErrorAction SilentlyContinue)) { throw 'Install WSL with wsl --install, restart, and rerun this installer.' }
    $wslArgs = @()
    if ($Distribution) { $wslArgs += @('-d', $Distribution) }
    # Fetch the installer from the same published release, not a moving branch.
    $release = if ($Version -eq 'latest') { 'latest/download' } else { 'download/v' + $Version.TrimStart('v') }
    $scriptUrl = "https://github.com/$Repo/releases/$release/install.sh"
    & wsl.exe @wslArgs -- sh -c 'set -eu; t=$(mktemp); trap ''rm -f "$t"'' EXIT; curl -fsSL --proto ''=https'' "$1" -o "$t"; sh "$t" --repo "$2" --version "$3"' sh $scriptUrl $Repo $Version
    if ($LASTEXITCODE -ne 0) { throw 'WSL setup failed. Ensure the distribution has Node 20+, npm, Python 3.11+, curl and a working user systemd session, then rerun.' }
    Write-Host 'Installed in WSL. Open that distribution and run tmatrix. The daemon runs while WSL is running.'
    return
}
$arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
$arch = switch ($arch) { 'x64' { 'amd64' } 'arm64' { 'arm64' } default { throw "Unsupported CPU: $arch" } }
if ($Version -eq 'latest') {
    $Version = (Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest").tag_name
    if ($Version -notmatch '^v?[0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9.-]+)?$') { throw 'Invalid release tag' }
}
$v = $Version.TrimStart('v')
$name = "tmatrix_${v}_windows_${arch}.zip"
$base = "https://github.com/$Repo/releases/download/v$v"
$temp = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
New-Item -ItemType Directory $temp | Out-Null
try {
    Invoke-WebRequest "$base/$name" -OutFile "$temp/$name" -UseBasicParsing
    Invoke-WebRequest "$base/checksums.txt" -OutFile "$temp/checksums.txt" -UseBasicParsing
    $matches = @(Get-Content "$temp/checksums.txt" | Where-Object { ($_ -split '\s+')[1] -ceq $name })
    if ($matches.Count -ne 1) { throw 'Missing or ambiguous checksum' }
    $expected = ($matches[0] -split '\s+')[0]
    if ($expected -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash "$temp/$name" -Algorithm SHA256).Hash -ne $expected) { throw 'Checksum mismatch' }
    Expand-Archive "$temp/$name" "$temp/unpacked"
    $bin = Join-Path $env:LOCALAPPDATA 'TMatrix/bin'
    New-Item -ItemType Directory -Force $bin | Out-Null
    Copy-Item "$temp/unpacked/tmatrix.exe" "$bin/tmatrix.exe" -Force
    $path = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (($path -split ';') -notcontains $bin) { [Environment]::SetEnvironmentVariable('Path', "$bin;$path", 'User') }
    $env:Path = "$bin;$env:Path"
    Write-Host 'Installed native TMatrix demo. Run tmatrix --demo. For live workers, rerun without -Native to install in WSL.'
} finally { Remove-Item -Recurse -Force $temp }
