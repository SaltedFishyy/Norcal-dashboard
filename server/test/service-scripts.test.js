import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(`../../scripts/services/${name}.ps1`, import.meta.url), 'utf8');

test('release exports commits through a tar file and reuses dependencies in priority order', () => {
  const source = read('release');
  assert.match(source, /rev-parse --verify --end-of-options/);
  assert.match(source, /archive --format=tar -o \$archive \$fullSha/);
  assert.doesNotMatch(source, /git[^\r\n]*archive[^\r\n]*\|/);
  assert.match(source, /System32\\tar.exe.*-xf \$archive -C \$staging/);
  assert.ok(source.indexOf('$candidates += (Join-Path $releases $old)') < source.indexOf('$candidates += $repoRoot'));
  assert.match(source, /Get-FileHash[^\r\n]*-Algorithm SHA256/);
  assert.match(source, /if \(\$code -ge 8\)/);
  assert.match(source, /@\('ci','--omit=dev'\)/);
  assert.match(source, /Archive contains forbidden/);
});

test('release switches only after smoke, writes an atomic pointer and guards staging cleanup', () => {
  const source = read('release');
  assert.ok(source.indexOf('    Invoke-Smoke $directory') < source.indexOf('[IO.File]::WriteAllText'));
  assert.match(source, /WriteAllText\("\$currentPath.tmp"/);
  assert.match(source, /\[IO.File\]::Replace\("\$currentPath.tmp", \$currentPath, \[NullString\]::Value\)/);
  assert.match(source, /GetDirectoryName\(\$resolvedStaging\) -eq \$releases/);
  assert.match(source, /GetFileName\(\$resolvedStaging\) -match '\^\\.staging-/);
  const recursiveDeletes = source.split(/\r?\n/).filter(line => /Remove-Item.*-Recurse/.test(line));
  assert.deepEqual(recursiveDeletes.map(line => line.trim()), ['Remove-Item -LiteralPath $resolvedStaging -Recurse -Force']);
  assert.match(source, /Clear-ReadonlyEnvironment -Environment \$info.EnvironmentVariables/);
  assert.match(source, /\['LISTEN_HOST'\] = '127.0.0.1'/);
  assert.match(source, /finally \{[\s\S]*\$child.Kill\(\)[\s\S]*Smoke process stopped but port is still occupied/);
  assert.match(source, /if \(\$SkipRestart\)/);
  assert.match(source, /ParentProcessId -eq \$guardians\[0\].ProcessId/);
  assert.match(source, /CreationDate -ne \$target.CreationDate/);
});

test('readonly guardian re-reads a validated release pointer with repo fallback', () => {
  const source = read('run-service');
  assert.match(source, /Join-Path \$Base 'releases\\current.txt'/);
  assert.match(source, /No release selected; using repo root\./);
  assert.ok(source.indexOf('No release selected; using repo root.') < source.indexOf('while ($true)'));
  assert.match(source, /\$selected -cmatch '\^\[0-9a-f\]\{7,40\}\$'/);
  assert.match(source, /Invalid release selection; using repo root\./);
  assert.ok(source.indexOf('ReadAllText($releasePointer)') > source.indexOf('while ($true)'));
  assert.match(source, /\$info.WorkingDirectory = \$RepoRoot/);
  assert.match(source, /\$info.WorkingDirectory = Join-Path \$Base "releases\\\$selected"/);
  assert.match(source, /if \(\$Name -eq 'worker'\) \{\s*\$info.Arguments = '--env-file-if-exists=.env server\/bin\/worker.js'/);
});

test('guardian owns a per-service per-user global mutex before any service work', () => {
  const source = read('run-service');
  assert.match(source, /Global\\NcOpsConsoleGuardian-\$Name-\$sid/);
  assert.match(source, /WindowsIdentity\]::GetCurrent\(\).User.Value/);
  assert.match(source, /\$ownsMutex = \$mutex.WaitOne\(0\)/);
  assert.match(source, /catch \[Threading.AbandonedMutexException\] \{ \$ownsMutex = \$true \}/);
  const duplicate = source.match(/if \(!\$ownsMutex\) \{([^}]+)\}/)?.[1];
  assert.ok(duplicate);
  assert.match(duplicate, /Write-Debug 'Another guardian is running; exiting\.'/);
  assert.match(duplicate, /exit 0/);
  assert.doesNotMatch(duplicate, /Write-ServiceLog|Add-Content|services\.log/);
  assert.ok(source.indexOf(duplicate) < source.indexOf('New-Item'));
  assert.match(source, /finally \{\s*try \{\s*if \(\$ownsMutex\) \{ \$mutex.ReleaseMutex\(\) \}\s*\} finally \{\s*\$mutex.Dispose\(\)/);
});

test('database probes and startup use the shared native invocation without output pipelines', () => {
  for (const name of ['start-services', 'run-service']) {
    const source = read(name);
    assert.match(source, /\. \(Join-Path \$scriptDir 'native-command.ps1'\)/);
    assert.match(source, /Invoke-Native -FilePath \$ready/);
    assert.doesNotMatch(source, /&\s*\$(?:ready|pgCtl)\b/);
  }
  const supervisor = read('start-services');
  assert.match(supervisor, /Invoke-Native -FilePath \$pgCtl -Arguments @\('status'/);
  const startCalls = supervisor.split(/\r?\n/).filter(line => /-Arguments @\('start'/.test(line));
  assert.equal(startCalls.length, 1);
  assert.match(startCalls[0], /Invoke-NativeDetached -FilePath \$pgCtl -Arguments @\('start'.*'-l', \$pgLog, '-W'\)/);
  assert.doesNotMatch(startCalls[0], /Invoke-Native\s|\||2>&1|Out-String/);
  assert.doesNotMatch(supervisor, /Invoke-Native[^\r\n]*\|/);
  const helper = read('native-command');
  assert.match(helper, /\$ErrorActionPreference = 'Continue'/);
  assert.match(helper, /& \$FilePath @Arguments > \$null 2>&1/);
  assert.match(helper, /return \$LASTEXITCODE/);
  assert.doesNotMatch(helper, /\|/);
});

test('resident-process launcher uses no pipes and bounds only the direct process wait', () => {
  const helper = read('native-command').split('function Invoke-NativeDetached {')[1];
  assert.ok(helper);
  for (const property of ['UseShellExecute', 'RedirectStandardOutput', 'RedirectStandardError']) {
    assert.match(helper, new RegExp(`\\$info\\.${property} = \\$false`));
  }
  assert.match(helper, /\$info.CreateNoWindow = \$true/);
  assert.match(helper, /\$TimeoutMilliseconds = 30000/);
  assert.match(helper, /\$process.WaitForExit\(\$TimeoutMilliseconds\)/);
  assert.match(helper, /return 'timeout'/);
  assert.match(helper, /return \$process.ExitCode/);
  assert.match(helper, /\$process.Dispose\(\)/);
  const code = helper.replace(/^\s*#.*$/gm, '');
  assert.doesNotMatch(code, /Start-Process|\.Kill\(|\||2>&1|Out-String/);
});

test('logon and independent five-minute timer register together without changing privilege', () => {
  const source = read('register-tasks');
  assert.match(source, /^\s*\$logon = New-ScheduledTaskTrigger -AtLogOn -User \$user\s*$/m);
  assert.match(source, /\$timer = New-ScheduledTaskTrigger -Once -At \(Get-Date\) -RepetitionInterval \(New-TimeSpan -Minutes 5\)/);
  assert.match(source, /Register-ScheduledTask[^\r\n]*-Trigger @\(\$logon, \$timer\)/);
  assert.doesNotMatch(source, /\$logon\.Repetition\s*=/);
  assert.doesNotMatch(source, /-RepetitionDuration/);
  assert.match(source, /-LogonType Interactive -RunLevel Limited/);
  assert.match(source, /-MultipleInstances IgnoreNew/);
  assert.match(source, /-Principal \$principal -Settings \$settings -Force/);
});

test('supervisor logs sanitized failure context and exit, with debug-only duplicate notice', () => {
  const source = read('start-services');
  assert.match(source, /step=\$step exit=\$script:databaseExit exception=/);
  assert.match(source, /finally \{\s*try \{\s*if \(\$ownsMutex\) \{ Write-ServiceLog "Services supervisor exiting:/);
  assert.match(source, /Write-Debug 'Another supervisor is running; exiting\.'/);
  assert.doesNotMatch(source, /Write-ServiceLog 'Another supervisor/);
});

test('dev preview isolates readonly environment and pins loopback after clearing', () => {
  const preview = readFileSync(new URL('../../scripts/dev-preview.ps1', import.meta.url), 'utf8');
  for (const source of [preview, read('run-service')]) {
    assert.match(source, /readonly-env.ps1/);
    assert.match(source, /Clear-ReadonlyEnvironment -Environment \$info.EnvironmentVariables/);
  }
  assert.match(preview, /\$Port = 3200/);
  assert.match(preview, /\['LISTEN_HOST'\] = '127.0.0.1'/);
  assert.match(preview, /\['PORT'\] = \[string\]\$Port/);
  assert.ok(preview.indexOf('Clear-ReadonlyEnvironment -Environment') < preview.indexOf("['LISTEN_HOST'] ="));
  assert.doesNotMatch(preview, /(?:--env-file-if-exists|['"]\.env['"])/);
  assert.match(preview, /--env-file=/);
  assert.match(preview, /Test-Path -LiteralPath \$EnvFile -PathType Leaf/);
  assert.match(preview, /GetActiveTcpListeners/);
  assert.match(preview, /finally[\s\S]*\$child.Kill\(\)/);
  const helper = read('readonly-env');
  for (const key of ['NC_DB_*', 'NC_TEST_DB_*', 'DMS_*', 'WAREHOUSE_*', 'DATA_SOURCE', 'RUNTIME_DATA_DIR', 'DB_DUAL_WRITE', 'NODE_OPTIONS']) {
    assert.ok(helper.includes(`'${key}'`));
    assert.ok(!preview.includes(`'${key}'`));
  }
  const launch = JSON.parse(readFileSync(new URL('../../.claude/launch.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(launch.version, '0.0.1');
  assert.equal(launch.configurations.length, 1);
  assert.deepEqual(launch.configurations[0], {
    name: 'dev-preview', runtimeExecutable: 'powershell',
    runtimeArgs: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/dev-preview.ps1'], port: 3200,
  });
});
