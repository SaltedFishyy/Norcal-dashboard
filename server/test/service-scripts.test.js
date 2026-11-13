import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(`../../scripts/services/${name}.ps1`, import.meta.url), 'utf8');

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

test('logon task repeats every five minutes indefinitely without changing privilege', () => {
  const source = read('register-tasks');
  assert.match(source, /New-ScheduledTaskTrigger -AtLogOn -User \$user/);
  assert.match(source, /-RepetitionInterval \(New-TimeSpan -Minutes 5\)/);
  assert.match(source, /\$trigger.Repetition = \$repeat.Repetition/);
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
