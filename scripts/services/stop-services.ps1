[CmdletBinding()]
param(
    [switch]$IncludePostgres,
    [switch]$Force,
    [string]$RepoRoot = $null,
    [string]$Base = (Join-Path $env:LOCALAPPDATA 'nc-ops-console'),
    [string]$RuntimeDir
)
$ErrorActionPreference = 'Stop'
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $RepoRoot) { $RepoRoot = [IO.Path]::GetFullPath((Join-Path $scriptDir '..\..')) }
# Resolve the worker's actual override with the existing Node configuration.
# Only the resolved directory is printed; no environment contents are exposed.
if (!$RuntimeDir) {
    Push-Location -LiteralPath $RepoRoot
    try {
        $node = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
        $resolve = "import {resolveRuntimeDir} from './server/src/config.js'; import {homedir} from 'node:os'; console.log(resolveRuntimeDir({env:process.env,platform:process.platform,homedir:homedir(),repoRoot:process.cwd()}));"
        $result = @(& $node --env-file-if-exists=.env --input-type=module -e $resolve 2>$null)
        if ($LASTEXITCODE -ne 0 -or $result.Count -ne 1) { throw 'Cannot resolve runtime directory; supply -RuntimeDir.' }
        $RuntimeDir = $result[0]
    } finally { Pop-Location }
}
$lockPath = Join-Path $RuntimeDir 'scrape.lock'
if (!$Force -and (Test-Path -LiteralPath $lockPath)) {
    try {
        $lock = Get-Content -LiteralPath $lockPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $lockPid = 0
        if (![int]::TryParse([string]$lock.pid, [ref]$lockPid) -or $lockPid -le 0) { throw 'Invalid lock.' }
        if (Get-Process -Id $lockPid -ErrorAction SilentlyContinue) {
            throw 'Refresh may be running. Stop refused; use -Force only after reviewing the active refresh.'
        }
    } catch {
        # Fail closed on unreadable/corrupt locks as well as live PIDs.
        throw 'Refresh lock is live or cannot be verified. Stop refused; review it before using -Force.'
    }
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
$runnerPath = Join-Path $scriptDir 'run-service.ps1'
$entryPath = Join-Path $scriptDir 'start-services.ps1'
$roots = @($processes | Where-Object {
    $_.Name -in @('powershell.exe', 'pwsh.exe') -and $_.CommandLine -and
    ($_.CommandLine.IndexOf($runnerPath, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
     $_.CommandLine.IndexOf($entryPath, [StringComparison]::OrdinalIgnoreCase) -ge 0)
} | Where-Object {
    $owner = Invoke-CimMethod -InputObject $_ -MethodName GetOwner
    "$($owner.Domain)\$($owner.User)" -eq $identity
})
# Capture descendants before stopping the task (children can become orphaned).
$ownedIds = @{}
foreach ($item in $roots) { $ownedIds[[int]$item.ProcessId] = $true }
do {
    $added = $false
    foreach ($item in $processes) {
        if ($ownedIds.ContainsKey([int]$item.ParentProcessId) -and !$ownedIds.ContainsKey([int]$item.ProcessId)) {
            $ownedIds[[int]$item.ProcessId] = $true
            $added = $true
        }
    }
} while ($added)
$task = Get-ScheduledTask -TaskName 'NC Ops Console Services' -TaskPath '\' -ErrorAction SilentlyContinue
if ($task) {
    if ($task.Principal.UserId -notin @($identity, $env:USERNAME,
            [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) -or
        !(@($task.Actions | Where-Object { $_.Arguments -and
            $_.Arguments.IndexOf($entryPath, [StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count)) {
        throw 'Scheduled task ownership/path does not match; refusing to stop.'
    }
    Stop-ScheduledTask -TaskName 'NC Ops Console Services' -TaskPath '\'
}
# Stop supervisors/guardians first so they cannot relaunch Node.
$targets = @($roots) + @($processes | Where-Object {
    $ownedIds.ContainsKey([int]$_.ProcessId) -and $_.Name -eq 'node.exe' -and
    $_.CommandLine -match 'server[\\/]bin[\\/](worker|server|dms-scrape-stations)\.js(?:\s|"|$)'
})
foreach ($item in $targets) {
    $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($item.ProcessId)" -ErrorAction Stop
    # Protect against PID reuse between discovery and termination.
    if ($current -and $current.CreationDate -eq $item.CreationDate -and $current.CommandLine -eq $item.CommandLine) {
        Stop-Process -Id $item.ProcessId -ErrorAction Stop
    }
}
if ($IncludePostgres) {
    & (Join-Path $Base 'pgsql\bin\pg_ctl.exe') stop -D (Join-Path $Base 'pgdata') -m fast
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL stop failed.' }
}
Write-Output 'Service processes stopped. The logon task remains registered.'
