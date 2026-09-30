# Offline wrapper tests: no WSL process, network, or real service is invoked.
$ErrorActionPreference = 'Stop'
function Assert($Condition, $Message) {
    if (!$Condition) { throw $Message }
}
$global:CapturedWsl = @()
$global:MockWslExit = 0
function global:wsl.exe {
    $global:CapturedWsl = @($args)
    $global:LASTEXITCODE = $global:MockWslExit
}
try {
    & "$PSScriptRoot/install.ps1" -Distribution 'Test Distro'
    Assert ($CapturedWsl[0] -eq '-d' -and $CapturedWsl[1] -eq 'Test Distro') 'Distribution was not preserved'
    Assert ($CapturedWsl[-2] -eq 'xmarkclx/tmatrix') 'Wrong default repository'
    Assert ($CapturedWsl[-1] -eq 'latest') 'Wrong default version'
    Assert ($CapturedWsl[-3] -eq 'https://github.com/xmarkclx/tmatrix/releases/latest/download/install.sh') 'Wrong installer URL'

    & "$PSScriptRoot/uninstall-daemon.ps1"
    Assert ($CapturedWsl[-2] -eq '-' -and $CapturedWsl[-1] -eq '-') 'Defaults must survive native empty argument handling'
    & "$PSScriptRoot/uninstall-daemon.ps1" -Distribution 'Test Distro' -Prefix '/opt/my install' -ConfigDir '/private/my config;literal'
    Assert ($CapturedWsl[-2] -eq '/opt/my install') 'Prefix changed'
    Assert ($CapturedWsl[-1] -eq '/private/my config;literal') 'Config path changed'
    Assert ($CapturedWsl[1] -eq 'Test Distro') 'Wrong uninstall distribution'
    Assert (!$CapturedWsl[5].Contains('/private/my config;literal')) 'Path interpolated into shell source'

    $global:MockWslExit = 42
    foreach ($script in @('install.ps1', 'uninstall-daemon.ps1')) {
        $failed = $false
        try { & "$PSScriptRoot/$script" } catch { $failed = $true }
        Assert $failed "$script hid a WSL failure"
    }
    # The final mocked failure is expected; do not leak it to the CI shell.
    $global:LASTEXITCODE = 0
    Write-Host 'PowerShell WSL wrapper tests passed.'
} finally {
    Remove-Item Function:\wsl.exe
}
