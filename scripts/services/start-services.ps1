[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$NodePath,
    [string]$RepoRoot = $null,
    [string]$Base = (Join-Path $env:LOCALAPPDATA 'nc-ops-console')
)
$ErrorActionPreference = 'Stop'
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
. (Join-Path $scriptDir 'native-command.ps1')
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
    if (!(Test-Path -LiteralPath $ready)) { throw [IO.FileNotFoundException]::new('Readiness executable missing.') }
    $script:databaseExit = Invoke-Native -FilePath $ready -Arguments @('-h', '127.0.0.1', '-p', '5432')
    return ($script:databaseExit -eq 0)
}
function Ensure-Database {
    $step = 'pg_isready'
    $script:databaseExit = 'not-run'
    try {
        if (Test-Database) { return }
        Write-ServiceLog 'PostgreSQL unavailable; attempting start.'
        $pgLog = Join-Path $logDir 'postgres.log'
        $pgCtl = Join-Path $Base 'pgsql\bin\pg_ctl.exe'
        # Rotate PostgreSQL output only while the cluster is stopped. Never move an
        # actively open PostgreSQL log file on Windows.
        if (Test-Path -LiteralPath $pgCtl) {
            $step = 'pg_ctl status'
            $script:databaseExit = Invoke-Native -FilePath $pgCtl -Arguments @('status', '-D', (Join-Path $Base 'pgdata'))
            $stopped = ($script:databaseExit -eq 3)
            if ($script:databaseExit -notin @(0, 3)) {
                Write-ServiceLog "PostgreSQL check failed: step=$step exit=$script:databaseExit exception=none; will retry."
                return
            }
            if ($stopped -and (Test-Path -LiteralPath $pgLog) -and (Get-Item -LiteralPath $pgLog).Length -gt 10MB) {
                $step = 'postgres log rotation'
                Move-Item -LiteralPath $pgLog -Destination "$pgLog.1" -Force
            }
            $step = 'pg_ctl start'
            $script:databaseExit = 'not-run'
            $script:databaseExit = Invoke-NativeDetached -FilePath $pgCtl -Arguments @('start', '-D', (Join-Path $Base 'pgdata'), '-l', $pgLog, '-W')
            Write-ServiceLog "pg_ctl start exit code $script:databaseExit."
            if ($script:databaseExit -ne 0) {
                Write-ServiceLog "PostgreSQL start failed: step=$step exit=$script:databaseExit exception=none; checking readiness."
            }
        } else { Write-ServiceLog 'PostgreSQL start failed: step=pg_ctl start exit=not-run exception=FileNotFound; will retry.'; return }
        $step = 'pg_isready'
        $deadline = [DateTime]::UtcNow.AddSeconds(60)
        do {
            if (Test-Database) { Write-ServiceLog 'PostgreSQL ready.'; return }
            Start-Sleep -Seconds 2
        } while ([DateTime]::UtcNow -lt $deadline)
        Write-ServiceLog "PostgreSQL readiness timed out: step=$step exit=$script:databaseExit exception=none; will retry."
    } catch {
        Write-ServiceLog "PostgreSQL check/start failed: step=$step exit=$script:databaseExit exception=$($_.Exception.GetType().Name); will retry."
    }
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
$exitReason = 'interrupted or host shutdown (cause unavailable)'
try {
    try { $ownsMutex = $mutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (!$ownsMutex) { Write-Debug 'Another supervisor is running; exiting.'; return }
    Write-ServiceLog 'Services supervisor starting.'
    while ($true) {
        Ensure-Database
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
} catch {
    $exitReason = "exception=$($_.Exception.GetType().Name)"
    throw
} finally {
    try {
        if ($ownsMutex) { Write-ServiceLog "Services supervisor exiting: $exitReason" }
    } finally {
        if ($ownsMutex) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}
