[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('worker', 'readonly')][string]$Name,
    [Parameter(Mandatory)][string]$NodePath,
    [string]$RepoRoot = $null,
    [string]$Base = (Join-Path $env:LOCALAPPDATA 'nc-ops-console')
)
$ErrorActionPreference = 'Stop'
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
. (Join-Path $scriptDir 'native-command.ps1')
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$mutex = New-Object Threading.Mutex($false, "Global\NcOpsConsoleGuardian-$Name-$sid")
$ownsMutex = $false
try {
    try { $ownsMutex = $mutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (!$ownsMutex) { Write-Debug 'Another guardian is running; exiting.'; exit 0 }
if (-not $RepoRoot) { $RepoRoot = [IO.Path]::GetFullPath((Join-Path $scriptDir '..\..')) }
$logDir = Join-Path $Base 'logs'
$null = New-Item -ItemType Directory -Path $logDir -Force
$logPath = Join-Path $logDir "$Name.log"
function Write-ServiceLog([string]$Message) {
    if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 10MB) {
        Move-Item -LiteralPath $logPath -Destination "$logPath.1" -Force
    }
    Add-Content -LiteralPath $logPath -Encoding UTF8 -Value "$(Get-Date -Format o) $Message"
}
function Test-Database {
    $ready = Join-Path $Base 'pgsql\bin\pg_isready.exe'
    if (!(Test-Path -LiteralPath $ready)) { return $false }
    $exitCode = Invoke-Native -FilePath $ready -Arguments @('-h', '127.0.0.1', '-p', '5432')
    return ($exitCode -eq 0)
}
function Test-ServicePort {
    $port = if ($Name -eq 'worker') { 3100 } else { 3000 }
    # Inspect all listener addresses, including wildcard/IPv6 bindings.
    return (@([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
        Where-Object { $_.Port -eq $port }).Count -gt 0)
}
function Quote-Argument([string]$Value) {
    if ($Value.Contains('"') -or $Value.EndsWith('\')) { throw 'Unsupported argument path.' }
    return '"' + $Value + '"'
}
$delays = @(5, 15, 60)
$retry = 0
while ($true) {
    $child = $null
    $started = $null
    try {
        $envPath = Join-Path $Base 'config\readonly.env'
        if ($Name -eq 'readonly' -and !(Test-Path -LiteralPath $envPath)) {
            Write-ServiceLog 'readonly.env missing; retry in 60 seconds (no .env fallback).'
            Start-Sleep -Seconds 60
            continue
        }
        if (Test-ServicePort) {
            Write-ServiceLog 'Service port occupied; retry in 60 seconds.'
            Start-Sleep -Seconds 60
            continue
        }
        if (!(Test-Database)) {
            Write-ServiceLog 'PostgreSQL unavailable; retry in 60 seconds.'
            Start-Sleep -Seconds 60
            continue
        }
        $info = New-Object Diagnostics.ProcessStartInfo
        $info.FileName = $NodePath
        $info.WorkingDirectory = $RepoRoot
        $info.UseShellExecute = $false
        $info.CreateNoWindow = $true
        $info.RedirectStandardOutput = $true
        $info.RedirectStandardError = $true
        $info.StandardOutputEncoding = [Text.Encoding]::UTF8
        $info.StandardErrorEncoding = [Text.Encoding]::UTF8
        if ($Name -eq 'worker') {
            $info.Arguments = '--env-file-if-exists=.env server/bin/worker.js'
        } else {
            $info.Arguments = (Quote-Argument "--env-file=$envPath") + ' server/bin/server.js'
            # Do not inherit writer/DMS configuration from the interactive parent.
            foreach ($key in @($info.EnvironmentVariables.Keys)) {
                if ($key -like 'NC_DB_*' -or $key -like 'NC_TEST_DB_*' -or $key -like 'DMS_*' -or $key -like 'WAREHOUSE_*' -or
                    $key -in @('DATA_SOURCE', 'LISTEN_HOST', 'PORT', 'RUNTIME_DATA_DIR', 'DB_DUAL_WRITE', 'NODE_OPTIONS')) {
                    $info.EnvironmentVariables.Remove($key)
                }
            }
        }
        $child = New-Object Diagnostics.Process
        $child.StartInfo = $info
        $null = $child.Start()
        $started = [DateTime]::UtcNow
        Write-ServiceLog "Started PID $($child.Id)."
        # Drain both pipes concurrently, on this runspace; callbacks from .NET threads
        # cannot safely invoke PowerShell script blocks in Windows PowerShell 5.1.
        $streams = @($child.StandardOutput, $child.StandardError)
        $reads = @($streams[0].ReadLineAsync(), $streams[1].ReadLineAsync())
        while ($null -ne $reads[0] -or $null -ne $reads[1]) {
            for ($i = 0; $i -lt 2; $i++) {
                if ($null -ne $reads[$i] -and $reads[$i].IsCompleted) {
                    $line = $reads[$i].GetAwaiter().GetResult()
                    if ($null -eq $line) { $reads[$i] = $null }
                    else {
                        $channel = if ($i -eq 0) { 'stdout' } else { 'stderr' }
                        Write-ServiceLog "[$channel] $line"
                        $reads[$i] = $streams[$i].ReadLineAsync()
                    }
                }
            }
            Start-Sleep -Milliseconds 100
        }
        $child.WaitForExit()
        Write-ServiceLog "Exited with code $($child.ExitCode)."
    } catch {
        # Avoid printing exception messages that might contain configuration values.
        Write-ServiceLog 'Service launch or log capture failed.'
    } finally {
        if ($null -ne $child) {
            if ($started -and !$child.HasExited) { $child.Kill(); $child.WaitForExit() }
            $child.Dispose()
        }
    }
    if ($started -and ([DateTime]::UtcNow - $started).TotalMinutes -gt 10) { $retry = 0 }
    $delay = $delays[[Math]::Min($retry, 2)]
    Write-ServiceLog "Restart in $delay seconds."
    Start-Sleep -Seconds $delay
    $retry = [Math]::Min($retry + 1, 2)
}
} finally {
    try {
        if ($ownsMutex) { $mutex.ReleaseMutex() }
    } finally {
        $mutex.Dispose()
    }
}
