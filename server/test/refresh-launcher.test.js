import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { centralFixture } from './central-db-fixtures.js';
import { createRefreshLauncher } from '../src/worker/refresh-launcher.js';

async function fixture(t, alive = false) {
  const f = await centralFixture(t), calls = [], children = [];
  await fs.writeFile(f.districtsPath, JSON.stringify({ schema_version: 1, districts: [
    { id: 'mock', name_zh: '模拟', name_en: 'Mock', stations: ['AAA01'] },
    { id: 'empty', name_zh: '空', name_en: 'Empty', stations: ['BBB01'], scrape_disabled: { BBB01: 'disabled' } },
  ] }));
  const launcher = createRefreshLauncher({ ...f, repoRoot: path.resolve('.'), isAlive: () => alive,
    spawn: (...args) => { calls.push(args); const child = new EventEmitter(); children.push(child); return child; } });
  return { ...f, launcher, calls, children,
    progress: value => fs.writeFile(path.join(f.runtimeDir, 'refresh-progress.json'), JSON.stringify(value)),
    lock: value => fs.writeFile(path.join(f.runtimeDir, 'scrape.lock'), JSON.stringify(value)) };
}

test('launcher validates triggers and forwards ui/schedule without spawning real processes', async t => {
  for (const trigger of ['ui', 'schedule']) {
    const f = await fixture(t);
    assert.equal(await f.launcher.isBusy(), false);
    const result = await f.launcher.start({ scope: 'all', trigger });
    assert.equal(result.started, true);
    const args = f.calls[0][1];
    assert.equal(args[args.indexOf('--trigger') + 1], trigger);
    assert.equal(await f.launcher.isBusy(), true);
    f.children[0].emit('exit', 1);
    assert.deepEqual(await result.done, { status: 'stopped', stop_reason: 'process:Exited', run_id: null, exit_code: 1 });
    assert.equal(await f.launcher.isBusy(), false);
  }
  const f = await fixture(t);
  for (const trigger of ['cli', 'invalid', undefined])
    await assert.rejects(f.launcher.start({ scope: 'all', trigger }), /Invalid trigger/);
  assert.equal(f.calls.length, 0);
});

test('launcher shares concurrent reservation, live locks and scope validation', async t => {
  const f = await fixture(t);
  const results = await Promise.all(['ui', 'schedule'].map(trigger => f.launcher.start({ scope: 'all', trigger })));
  assert.equal(results.filter(r => r.started).length, 1);
  assert.deepEqual(results.find(r => !r.started), { started: false, error: 'refresh_in_progress' });
  assert.equal(f.calls.length, 1);
  f.children[0].emit('exit', 0);
  await results.find(r => r.started).done;
  const live = await fixture(t, true); await live.lock({ pid: 123 });
  assert.equal(await live.launcher.isBusy(), true);
  assert.deepEqual(await live.launcher.start({ scope: 'all', trigger: 'schedule' }), { started: false, error: 'refresh_in_progress' });
  assert.equal(live.calls.length, 0);
  for (const [scope, error] of [['district:empty', 'empty_scope'], ['invalid', 'invalid_scope'], ['district:missing', 'invalid_scope']])
    assert.deepEqual(await f.launcher.start({ scope, trigger: 'schedule' }), { started: false, error });
});

test('launcher done returns final progress, or process:Exited for missing/unreadable/running progress', async t => {
  for (const progress of [
    { status: 'completed', stop_reason: null, run_id: 'mock-completed' },
    { status: 'stopped', stop_reason: 'capture:NeedsLoginError', run_id: 'mock-stopped' },
    { status: 'running', stop_reason: null, run_id: 'mock-running' }, null, 'malformed',
  ]) {
    const f = await fixture(t), result = await f.launcher.start({ scope: 'all', trigger: 'schedule' });
    if (progress === null) await fs.unlink(path.join(f.runtimeDir, 'refresh-progress.json'));
    else if (progress === 'malformed') await fs.writeFile(path.join(f.runtimeDir, 'refresh-progress.json'), '{');
    else await f.progress(progress);
    f.children[0].emit('exit', 2);
    const final = progress && ['completed', 'stopped'].includes(progress.status);
    assert.deepEqual(await result.done, { status: final ? progress.status : 'stopped',
      stop_reason: final ? progress.stop_reason : 'process:Exited', run_id: progress?.run_id ?? null, exit_code: 2 });
  }
});

test('launcher done resolves once on spawn error, including a subsequent exit', async t => {
  const f = await fixture(t), result = await f.launcher.start({ scope: 'all', trigger: 'ui' });
  f.children[0].emit('error', new Error('synthetic spawn error'));
  f.children[0].emit('exit', -1);
  assert.deepEqual(await result.done, { status: 'stopped', stop_reason: 'process:Exited', run_id: null, exit_code: null });
  assert.equal(await f.launcher.isBusy(), false);
});
