function Invoke-Native {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [string[]]$Arguments = @()
    )
    if (!(Test-Path -LiteralPath $FilePath -PathType Leaf)) {
        throw [IO.FileNotFoundException]::new('Native executable missing.')
    }
    # Function-local preference: stderr is diagnostic output, not a terminating
    # PowerShell error. Use only for probes that leave no resident descendants:
    # PowerShell 5.1 redirection still waits for inherited pipe handles to close.
    $ErrorActionPreference = 'Continue'
    & $FilePath @Arguments > $null 2>&1
    return $LASTEXITCODE
}

function Invoke-NativeDetached {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [string[]]$Arguments = @(),
        [ValidateRange(1, 2147483647)][int]$TimeoutMilliseconds = 30000
    )
    if (!(Test-Path -LiteralPath $FilePath -PathType Leaf)) {
        throw [IO.FileNotFoundException]::new('Native executable missing.')
    }
    # For launchers such as pg_ctl start: create no stdout/stderr pipes, and wait
    # only for the direct process. Start-Process -Wait waits for the process tree
    # on Windows PowerShell 5.1, which would include the resident postmaster.
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $FilePath
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $false
    $info.RedirectStandardError = $false
    # Windows argv quoting: escape quotes and double trailing backslashes before
    # the closing quote. ProcessStartInfo.ArgumentList is unavailable on .NET 4.
    $quoted = foreach ($argument in $Arguments) {
        if ($argument.Length -gt 0 -and $argument -notmatch '[\s"]') {
            $argument
        } else {
            '"' + ([regex]::Replace(
                [regex]::Replace($argument, '(\\*)"', '$1$1\"'),
                '(\\+)$', '$1$1')) + '"'
        }
    }
    $info.Arguments = $quoted -join ' '
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $info
    try {
        $null = $process.Start()
        if (!$process.WaitForExit($TimeoutMilliseconds)) {
            # Leave the process running; the caller can check readiness and retry.
            return 'timeout'
        }
        return $process.ExitCode
    } finally {
        $process.Dispose()
    }
}
