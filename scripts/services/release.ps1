[CmdletBinding(DefaultParameterSetName='Commit')]
param(
    [Parameter(ParameterSetName='Commit')][string]$Commit = 'HEAD',
    [Parameter(Mandatory, ParameterSetName='Rollback')][switch]$Rollback,
    [Parameter(Mandatory, ParameterSetName='Version')][ValidatePattern('^[0-9a-f]{7,40}$')][string]$Version,
    [string]$Base = (Join-Path $env:LOCALAPPDATA 'nc-ops-console'),
    [string]$EnvFile,
    [ValidateRange(1,65535)][int]$SmokePort = 3299,
    [switch]$SkipRestart,
    [string]$NodePath = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'readonly-env.ps1')
. (Join-Path $PSScriptRoot 'native-command.ps1')
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$Base = [IO.Path]::GetFullPath($Base)
if (!$EnvFile) { $EnvFile = Join-Path $Base 'config\readonly.env' }
$EnvFile = [IO.Path]::GetFullPath($EnvFile)
$releases = Join-Path $Base 'releases'
$currentPath = Join-Path $releases 'current.txt'
$historyPath = Join-Path $releases 'history.log'
$staging = $null
$archive = $null
$releaseLock = $null
function Test-VersionName([string]$Value) { return $Value -cmatch '^[0-9a-f]{7,40}$' }
function Get-CurrentVersion {
    if (Test-Path -LiteralPath $currentPath -PathType Leaf) {
        $value = ([IO.File]::ReadAllText($currentPath)).Trim()
        if (Test-VersionName $value) { return $value }
    }
    return ''
}
function Test-Port([int]$Port) {
    return @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
        Where-Object { $_.Port -eq $Port }).Count -gt 0
}
function Test-Http([int]$Port) {
    try { return (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/districts" -TimeoutSec 1).StatusCode -eq 200 }
    catch { return $false }
}
function Invoke-Smoke([string]$Directory) {
    if (!(Test-Path -LiteralPath $EnvFile -PathType Leaf)) { throw 'Smoke env file missing.' }
    if (Test-Port $SmokePort) { throw 'Smoke port already occupied; no process was stopped.' }
    if ($EnvFile.Contains('"')) { throw 'Unsupported env file path.' }
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $NodePath
    $info.WorkingDirectory = $Directory
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.Arguments = '"--env-file=' + $EnvFile + '" server/bin/server.js'
    Clear-ReadonlyEnvironment -Environment $info.EnvironmentVariables
    $info.EnvironmentVariables['LISTEN_HOST'] = '127.0.0.1'
    $info.EnvironmentVariables['PORT'] = [string]$SmokePort
    $child = New-Object Diagnostics.Process
    $child.StartInfo = $info
    $started = $false
    try {
        $started = $child.Start()
        # Drain without printing configuration-dependent server output.
        $stdout = $child.StandardOutput.ReadToEndAsync()
        $stderr = $child.StandardError.ReadToEndAsync()
        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        while ([DateTime]::UtcNow -lt $deadline -and !$child.HasExited) {
            if ((Test-Http $SmokePort) -and !$child.HasExited) { return }
            Start-Sleep -Milliseconds 200
        }
        throw 'Smoke check failed: server exited or /api/districts did not return 200 within 30 seconds.'
    } finally {
        if ($started) {
            if (!$child.HasExited) { $child.Kill() }
            $child.WaitForExit()
        }
        $child.Dispose()
        $deadline = [DateTime]::UtcNow.AddSeconds(5)
        while ((Test-Port $SmokePort) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
        if (Test-Port $SmokePort) { throw 'Smoke process stopped but port is still occupied.' }
    }
}
function Restart-Readonly {
    if ($SkipRestart) { return 'Skipped (-SkipRestart).' }
    $runner = Join-Path $PSScriptRoot 'run-service.ps1'
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $processes = @(Get-CimInstance Win32_Process)
    $guardians = @($processes | Where-Object {
        $_.Name -in @('powershell.exe','pwsh.exe') -and $_.CommandLine -and
        $_.CommandLine.IndexOf($runner, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $_.CommandLine -match '(?i)-Name\s+["'']?readonly(?:["'']?)(?:\s|$)'
    } | Where-Object {
        $owner = Invoke-CimMethod -InputObject $_ -MethodName GetOwner
        "$($owner.Domain)\$($owner.User)" -eq $identity
    } | Where-Object {
        # A custom test Base must never restart the production guardian.
        $guardianBase = Join-Path $env:LOCALAPPDATA 'nc-ops-console'
        if ($_.CommandLine -match '(?i)-Base\s+(?:"([^"]+)"|''([^'']+)''|(\S+))') {
            $guardianBase = @($Matches[1], $Matches[2], $Matches[3]) | Where-Object { $_ } | Select-Object -First 1
        }
        [IO.Path]::GetFullPath($guardianBase).TrimEnd('\') -eq $Base.TrimEnd('\')
    })
    if (!$guardians.Count) { return '已切换，readonly guardian 未运行，下次启动时生效。' }
    if ($guardians.Count -ne 1) { throw 'Multiple readonly guardians found; no process stopped.' }
    $targets = @($processes | Where-Object {
        $_.Name -eq 'node.exe' -and $_.ParentProcessId -eq $guardians[0].ProcessId -and
        $_.CommandLine -match 'server[\\/]bin[\\/]server\.js(?:\s|"|$)'
    })
    if ($targets.Count -gt 1) { throw 'Multiple readonly children found; no process stopped.' }
    foreach ($target in $targets) {
        $fresh = Get-CimInstance Win32_Process -Filter "ProcessId = $($target.ProcessId)"
        if (!$fresh -or $fresh.CreationDate -ne $target.CreationDate -or $fresh.CommandLine -ne $target.CommandLine) {
            throw 'Readonly process changed; no process stopped.'
        }
        Stop-Process -Id $target.ProcessId
        $deadline = [DateTime]::UtcNow.AddSeconds(5)
        while ((Test-Port 3000) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-Http 3000) { return 'Readonly /api/districts returned 200.' }
        Start-Sleep -Milliseconds 200
    }
    throw 'Version switched, but readonly restart readiness timed out.'
}
try {
    $null = New-Item -ItemType Directory -Path $releases -Force
    # Serialize switches and protect current.txt.tmp from concurrent publishers.
    $releaseLock = [IO.File]::Open((Join-Path $releases 'release.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    $old = Get-CurrentVersion
    $fullSha = $null
    if ($Rollback) {
        if (Test-Path -LiteralPath $historyPath -PathType Leaf) {
            $lines = @([IO.File]::ReadAllLines($historyPath))
            for ($i = $lines.Count - 1; $i -ge 0; $i--) {
                $parts = $lines[$i] -split '\s+'
                if ($parts.Count -eq 3 -and (Test-VersionName $parts[1]) -and $parts[1] -cne $old -and
                    (Test-Path -LiteralPath (Join-Path $releases $parts[1]) -PathType Container)) {
                    $Version = $parts[1]; $fullSha = $parts[2]; break
                }
            }
        }
        if (!$Version) { throw 'No previous release available.' }
    } elseif ($PSCmdlet.ParameterSetName -eq 'Commit') {
        $resolved = @(& git -C $repoRoot rev-parse --verify --end-of-options "$Commit`^{commit}" 2>$null)
        if ($LASTEXITCODE -ne 0 -or $resolved.Count -ne 1 -or $resolved[0] -cnotmatch '^[0-9a-f]{40}$') { throw 'Cannot resolve commit.' }
        $fullSha = $resolved[0]
        $Version = $fullSha.Substring(0,10)
        if (@(& git -C $repoRoot status --porcelain).Count) { Write-Warning '工作区有未提交改动；仅导出指定 commit。' }
    }
    if (!(Test-VersionName $Version)) { throw 'Invalid release directory name.' }
    $target = Join-Path $releases $Version
    if ($PSCmdlet.ParameterSetName -ne 'Commit' -and !(Test-Path -LiteralPath $target -PathType Container)) {
        throw 'Requested release does not exist.'
    }
    if (!$fullSha) {
        if (Test-Path -LiteralPath $historyPath) {
            foreach ($line in [IO.File]::ReadAllLines($historyPath)) {
                if ($line -cmatch "^\S+ $Version ([0-9a-f]{40})$") { $fullSha = $Matches[1] }
            }
        }
        if (!$fullSha) {
            $resolved = @(& git -C $repoRoot rev-parse --verify --end-of-options "$Version`^{commit}" 2>$null)
            if ($LASTEXITCODE -ne 0 -or $resolved.Count -ne 1) { throw 'Cannot resolve release full SHA.' }
            $fullSha = $resolved[0]
        }
    }
    if ($fullSha -cnotmatch '^[0-9a-f]{40}$') { throw 'Invalid release full SHA.' }
    $directory = $target
    if ($PSCmdlet.ParameterSetName -eq 'Commit' -and !(Test-Path -LiteralPath $target)) {
        $staging = Join-Path $releases ('.staging-' + $Version + '-' + [Guid]::NewGuid().ToString('N'))
        $null = New-Item -ItemType Directory -Path $staging
        $archive = "$staging.tar"
        & git -C $repoRoot archive --format=tar -o $archive $fullSha
        if ($LASTEXITCODE -ne 0) { throw 'git archive failed.' }
        & "$env:SystemRoot\System32\tar.exe" -xf $archive -C $staging
        if ($LASTEXITCODE -ne 0) { throw 'tar extraction failed.' }
        Remove-Item -LiteralPath $archive
        $archive = $null
        # Never inspect secret contents; reject forbidden files/directories by name.
        $forbidden = @(Get-ChildItem -LiteralPath $staging -Recurse -Force | Where-Object {
            $_.Name -in @('.env','readonly.env','secrets','runtime-data','playwright') -or
            ($_.Name -like '.env.*' -and $_.Name -ne '.env.example')
        })
        if ($forbidden.Count) { throw 'Archive contains forbidden environment, credential or runtime paths.' }
        $lockFile = Join-Path $staging 'package-lock.json'
        $hash = (Get-FileHash -LiteralPath $lockFile -Algorithm SHA256).Hash
        $dependencySource = $null
        $candidates = @()
        if ($old) { $candidates += (Join-Path $releases $old) }
        $candidates += $repoRoot
        foreach ($candidate in $candidates) {
            $candidateLock = Join-Path $candidate 'package-lock.json'
            if ((Test-Path -LiteralPath $candidateLock -PathType Leaf) -and
                (Test-Path -LiteralPath (Join-Path $candidate 'node_modules') -PathType Container) -and
                (Get-FileHash -LiteralPath $candidateLock -Algorithm SHA256).Hash -eq $hash) {
                $dependencySource = $candidate; break
            }
        }
        if ($dependencySource) {
            Write-Output "Dependencies copied from: $dependencySource"
            $code = Invoke-Native -FilePath (Get-Command robocopy -CommandType Application).Source -Arguments @(
                (Join-Path $dependencySource 'node_modules'), (Join-Path $staging 'node_modules'), '/E','/NFL','/NDL','/NJH','/NJS','/NP')
            if ($code -ge 8) { throw "Dependency copy failed (robocopy exit $code)." }
        } else {
            Push-Location -LiteralPath $staging
            try {
                $code = Invoke-Native -FilePath (Get-Command npm.cmd -CommandType Application).Source -Arguments @('ci','--omit=dev')
                if ($code -ne 0) { throw 'npm ci failed.' }
            } finally { Pop-Location }
        }
        $directory = $staging
    }
    if (!(Test-Path -LiteralPath (Join-Path $directory 'server\bin\server.js') -PathType Leaf) -or
        !(Test-Path -LiteralPath (Join-Path $directory 'node_modules') -PathType Container)) { throw 'Release missing or incomplete; existing releases are never overwritten.' }
    Invoke-Smoke $directory
    Write-Output 'Smoke: passed; process stopped and port released.'
    if ($staging) {
        Move-Item -LiteralPath $staging -Destination $target
        $staging = $null
    }
    [IO.File]::WriteAllText("$currentPath.tmp", $Version, (New-Object Text.UTF8Encoding($false)))
    if (Test-Path -LiteralPath $currentPath) { [IO.File]::Replace("$currentPath.tmp", $currentPath, [NullString]::Value) }
    else { Move-Item -LiteralPath "$currentPath.tmp" -Destination $currentPath }
    Add-Content -LiteralPath $historyPath -Encoding UTF8 -Value "$(Get-Date -Format o) $Version $fullSha"
    $logDir = Join-Path $Base 'logs'
    $null = New-Item -ItemType Directory -Path $logDir -Force
    $logPath = Join-Path $logDir 'services.log'
    if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 10MB) {
        Move-Item -LiteralPath $logPath -Destination "$logPath.1" -Force
    }
    Add-Content -LiteralPath $logPath -Encoding UTF8 -Value "$(Get-Date -Format o) Release switched: $old -> $Version"
    Write-Output "Release switched: $old -> $Version"
    $restartResult = Restart-Readonly
    Write-Output "Restart: $restartResult"
} catch {
    Write-Error $_.Exception.Message -ErrorAction Continue
    exit 1
} finally {
    if ($archive -and (Test-Path -LiteralPath $archive)) { Remove-Item -LiteralPath $archive }
    if ($staging -and (Test-Path -LiteralPath $staging)) {
        $resolvedStaging = [IO.Path]::GetFullPath($staging)
        if ([IO.Path]::GetDirectoryName($resolvedStaging) -eq $releases -and
            [IO.Path]::GetFileName($resolvedStaging) -match '^\.staging-[0-9a-f]{10}-[0-9a-f]{32}$') {
            Remove-Item -LiteralPath $resolvedStaging -Recurse -Force
        }
    }
    if ($releaseLock) { $releaseLock.Dispose() }
}
