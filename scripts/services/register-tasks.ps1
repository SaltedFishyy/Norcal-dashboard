[CmdletBinding()]
param([switch]$Unregister)
$ErrorActionPreference = 'Stop'
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$taskName = 'NC Ops Console Services'
try {
    $user = "$env:USERDOMAIN\$env:USERNAME"
    $existing = Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue
    if ($existing) {
        $existing | Select-Object TaskName, TaskPath, State, Actions, Triggers, Principal, Settings | Format-List
        if ($existing.Principal.UserId -notin @($user, $env:USERNAME,
                [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)) {
            throw 'Task belongs to another user.'
        }
    }
    if ($Unregister) {
        if ($existing) { Unregister-ScheduledTask -TaskName $taskName -TaskPath '\' -Confirm:$false }
        Write-Output 'Task unregistered (or already absent).'
        return
    }
    $node = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $repo = [IO.Path]::GetFullPath((Join-Path $scriptDir '..\..'))
    $entry = Join-Path $scriptDir 'start-services.ps1'
    if ($node.Contains('"') -or $entry.Contains('"')) { throw 'Unsupported argument path.' }
    $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
        -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$entry`" -NodePath `"$node`"" `
        -WorkingDirectory $repo
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    # AtLogOn has no repetition parameters; reuse the CIM repetition object
    # from a Once trigger. Omitting Duration means repeat indefinitely.
    $repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
    $trigger.Repetition = $repeat.Repetition
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 999 `
        -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
    $null = Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings -Force
    Write-Output 'Task registered for current-user logon with indefinite 5-minute recovery; it has not been started.'
} catch {
    Write-Error 'Task registration/removal failed. Check current-user Task Scheduler permissions and Node installation. No elevation attempted.'
    exit 1
}
