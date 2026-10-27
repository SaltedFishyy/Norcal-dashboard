[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$NodePath,
    [string]$RepoRoot = $null,
    [string]$Base = (Join-Path $env:LOCALAPPDATA 'nc-ops-console')
)
$ErrorActionPreference = 'Stop'
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $RepoRoot) { $RepoRoot = [IO.Path]::GetFullPath((Join-Path $scriptDir '..\..')) }
$logDir = Join-Path $Base 'logs'
$null = New-Item -ItemType Directory -Path $logDir -Force
$logPath = Join-Path $logDir 'services.log'
function Write-ServiceLog([string]$Message) {
    if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 10MB) {
        Move-Item -LiteralPath $logPath -Destination "$logPath.1" -Force
    }
    Add-Content -LiteralPath $logPath -Encoding UTF8 -Value "$(Get-Date -Format o) $Message"
}
function Quote-Argument([string]$Value) {
    if ($Value.Contains('"') -or $Value.EndsWith('\')) { throw 'Unsupported argument path.' }
    return '"' + $Value + '"'
}
function Test-Database {
    $ready = Join-Path $Base 'pgsql\bin\pg_isready.exe'
    if (!(Test-Path -LiteralPath $ready)) { return $false }
    & $ready -h 127.0.0.1 -p 5432 *> $null
    return ($LASTEXITCODE -eq 0)
}
function Ensure-Database {
    if (Test-Database) { return }
    Write-ServiceLog 'PostgreSQL unavailable; attempting start.'
    $pgLog = Join-Path $logDir 'postgres.log'
    $pgCtl = Join-Path $Base 'pgsql\bin\pg_ctl.exe'
    # Rotate PostgreSQL output only while the cluster is stopped. Never move an
    # actively open PostgreSQL log file on Windows.
    if (Test-Path -LiteralPath $pgCtl) {
        & $pgCtl status -D (Join-Path $Base 'pgdata') *> $null
        $stopped = ($LASTEXITCODE -eq 3)
        if ($stopped -and (Test-Path -LiteralPath $pgLog) -and (Get-Item -LiteralPath $pgLog).Length -gt 10MB) {
            Move-Item -LiteralPath $pgLog -Destination "$pgLog.1" -Force
        }
        & $pgCtl start -D (Join-Path $Base 'pgdata') -l $pgLog -W *> $null
        Write-ServiceLog "pg_ctl start exit code $LASTEXITCODE."
    } else { Write-ServiceLog 'pg_ctl missing.' }
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    do {
        if (Test-Database) { Write-ServiceLog 'PostgreSQL ready.'; return }
        Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $deadline)
    Write-ServiceLog 'PostgreSQL readiness timed out; will retry.'
}
function Start-Guardian([string]$Name) {
    $runner = Join-Path $scriptDir 'run-service.ps1'
    $arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ' + (Quote-Argument $runner) +
        ' -Name ' + $Name + ' -NodePath ' + (Quote-Argument $NodePath) +
        ' -RepoRoot ' + (Quote-Argument $RepoRoot) + ' -Base ' + (Quote-Argument $Base)
    $process = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
        -ArgumentList $arguments -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru
    Write-ServiceLog "$Name guardian started, PID $($process.Id)."
    return $process
}
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$mutex = New-Object Threading.Mutex($false, "Global\NcOpsConsoleServices-$sid")
$ownsMutex = $false
$guardians = @{}
try {
    try { $ownsMutex = $mutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (!$ownsMutex) { Write-ServiceLog 'Another supervisor is running; exiting.'; return }
    Write-ServiceLog 'Services supervisor starting.'
    while ($true) {
        try { Ensure-Database }
        catch { Write-ServiceLog 'PostgreSQL check/start failed; will retry.' }
        foreach ($name in @('worker', 'readonly')) {
            try {
                if (!$guardians.ContainsKey($name) -or $guardians[$name].HasExited) {
                    if ($guardians.ContainsKey($name)) {
                        $guardians[$name].Dispose()
                        $guardians.Remove($name)
                    }
                    $guardians[$name] = Start-Guardian $name
                }
            } catch { Write-ServiceLog "$name guardian launch failed; will retry." }
        }
        Start-Sleep -Seconds 60
    }
} finally {
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
