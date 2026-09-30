import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const entry = fileURLToPath(new URL('../bin/dms-login.js', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
function run(env = {}) {
  return spawnSync(process.execPath, [entry], {
    cwd: path.dirname(repoRoot), encoding: 'utf8', timeout: 10000,
    env: { ...process.env, DMS_BASE_URL: '', DMS_STATE_PATH: '', ...env },
  });
}
test('missing URL exits with configuration guidance before loading browser', () => {
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /本地 .env 中配置 DMS_BASE_URL/);
});
test('repository path rejected even when launched from another working directory', () => {
  const result = run({ DMS_STATE_PATH: 'sub/../dms-state.json', DMS_BASE_URL: 'https://example.invalid' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Session 路径位于仓库内/);
  assert.doesNotMatch(result.stdout, /打开：/);
});
test('external sync path warns without itself rejecting execution', () => {
  const result = run({ DMS_STATE_PATH: path.resolve(repoRoot, '../Dropbox/state.json') });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /warning: Session 路径包含同步目录名称/);
  assert.match(result.stderr, /配置 DMS_BASE_URL/);
});
