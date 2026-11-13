[CmdletBinding()]
param(
    [ValidateRange(1, 65535)][int]$Port = 3200,
    [string]$EnvFile = (Join-Path $env:LOCALAPPDATA 'nc-ops-console\config\readonly.env'),
    [string]$NodePath = (Get-Command node -ErrorAction Stop).Source
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'services\readonly-env.ps1')
$child = $null
$started = $false
$exitCode = 1
try {
    if (!(Test-Path -LiteralPath $EnvFile -PathType Leaf)) {
        throw '只读配置文件不存在，请使用 -EnvFile 指定有效文件。'
    }
    $occupied = @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
        Where-Object { $_.Port -eq $Port }).Count -gt 0
    if ($occupied) { throw "端口 $Port 已在运行或被占用。" }
    $envPath = (Resolve-Path -LiteralPath $EnvFile).ProviderPath
    if ($envPath.Contains('"') -or $envPath.EndsWith('\')) { throw '配置文件路径无效。' }
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $NodePath
    $info.WorkingDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    # Inherit console handles so output and Ctrl+C remain attached to this foreground session.
    $info.Arguments = '"--env-file=' + $envPath + '" server/bin/server.js'
    Clear-ReadonlyEnvironment -Environment $info.EnvironmentVariables
    $info.EnvironmentVariables['LISTEN_HOST'] = '127.0.0.1'
    $info.EnvironmentVariables['PORT'] = [string]$Port
    $child = New-Object Diagnostics.Process
    $child.StartInfo = $info
    $started = $child.Start()
    Write-Host "开发预览：http://127.0.0.1:$Port （Ctrl+C 结束）"
    # A bounded wait lets PowerShell handle Ctrl+C and execute finally promptly.
    while (!$child.WaitForExit(200)) { }
    $exitCode = $child.ExitCode
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
} finally {
    if ($null -ne $child) {
        if ($started -and !$child.HasExited) { $child.Kill(); $child.WaitForExit() }
        $child.Dispose()
    }
}
exit $exitCode
