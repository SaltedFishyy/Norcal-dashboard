import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { autoRefreshConfig, createAutoRefreshScheduler } from '../src/worker/auto-refresh-scheduler.js';
import { createWorkerServer } from '../src/worker/worker.js';
import { runWorker } from '../bin/worker.js';

const config = autoRefreshConfig({ AUTO_REFRESH_TIME: '17:00' }, 'db');
const completed = { status: 'completed', run_id: 'run', stop_reason: null };
async function fixture(t, instant = '2026-11-12T00:59:00Z', options = {}) {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), 'nc-auto-'));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  let clock = Date.parse(instant), timer, busy = false;
  const calls = [], logs = [];
  const launcher = { isBusy: async () => busy, start: async args => {
    calls.push(args); return { started: true, done: Promise.resolve(completed) };
  }, ...options.launcher };
  const scheduler = createAutoRefreshScheduler({ config, runtimeDir, launcher,
    readDistricts: options.readDistricts ?? (async () => ({ districts: [{ id: 'first' }, { id: 'second' }] })),
    now: () => new Date(clock), setTimeoutImpl: (fn, delay) => { timer = { fn, at: clock + delay }; return timer; },
    clearTimeoutImpl: () => { timer = undefined; }, log: line => logs.push(JSON.parse(line)) });
  t.after(() => scheduler.stop());
  return { scheduler, calls, logs, launcher, runtimeDir, busy: value => { busy = value; },
    timer: () => timer, setTime: value => { clock = Date.parse(value); },
    async tick() { const current = timer; assert.ok(current); timer = undefined; clock = current.at; await current.fn(); },
    file: () => readFile(path.join(runtimeDir, 'auto-refresh-status.json'), 'utf8').then(JSON.parse) };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 1));
async function until(predicate) {
  for (let i = 0; i < 1000 && !predicate(); i++) await flush();
  assert.ok(predicate(), 'async scheduler reached expected state');
}

test('late timers miss their planned date or cutoff, including startup catchup', async t => {
  for (const [start, wake, next] of [
    ['2026-11-12T00:00:00Z', '2026-11-12T18:00:00Z', '2026-11-13T01:00:00.000Z'],
    ['2026-11-12T00:00:00Z', '2026-11-12T07:30:00Z', '2026-11-13T01:00:00.000Z'],
    ['2026-11-12T06:59:00Z', '2026-11-12T07:01:00Z', '2026-11-13T01:00:00.000Z'],
    ['2026-11-12T02:00:00Z', '2026-11-12T18:00:00Z', '2026-11-13T01:00:00.000Z']]) {
    const f = await fixture(t, start);
    await f.scheduler.start();
    const pending = f.timer(); f.setTime(wake); await pending.fn();
    assert.equal(f.calls.length, 0);
    assert.equal(f.scheduler.status().next_run_at, next);
    assert.deepEqual(f.logs, [{ event: 'auto_refresh_missed', date: '2026-11-11' }]);
  }
});

test('login preserves earlier failures and skips only later targets in each round', async t => {
  for (const retry of [false, true]) {
    const f = await fixture(t, undefined, { readDistricts: async () =>
      ['north', 'south', 'later'].map(id => ({ id })) });
    let count = 0;
    f.launcher.start = async args => {
      f.calls.push(args); count++;
      return { started: true, done: Promise.resolve({ status: 'stopped',
        stop_reason: count === (retry ? 5 : 2) ? 'capture:NeedsLoginError' : 'list:SelectorError' }) };
    };
    await f.scheduler.start();
    const running = f.tick();
    if (retry) {
      await until(() => f.calls.length === 3 && !!f.timer());
      await f.tick();
    }
    await running;
    const last = await f.file();
    assert.equal(last.result, 'needs_login');
    assert.equal(last.districts[0].status, 'stopped');
    assert.equal(last.districts[0].stop_reason, 'list:SelectorError');
    assert.equal(last.districts[2].status, 'not_run_login');
    assert.equal(last.retry_round, retry ? 1 : 0);
  }
});

test('restart preserves stopped reasons while finalizing pending districts', async t => {
  const f = await fixture(t, '2026-11-12T02:00:00Z');
  await writeFile(path.join(f.runtimeDir, 'auto-refresh-status.json'), JSON.stringify({
    date: '2026-11-11', result: 'running', districts: [
      { id: 'first', status: 'stopped', stop_reason: 'capture:SelectorError' },
      { id: 'second', status: 'pending' }] }));
  await f.scheduler.start();
  const last = await f.file();
  assert.equal(last.districts[0].status, 'stopped');
  assert.equal(last.districts[0].stop_reason, 'capture:SelectorError');
  assert.equal(last.districts[1].status, 'stopped');
  assert.equal(last.districts[1].stop_reason, 'worker:Restarted');
  assert.equal(f.calls.length, 0);
});

test('invalid status JSON or shape is logged and replaced at the scheduled run', async t => {
  for (const contents of ['{bad json', 'null', '[]', '42', '{}', '{"date":"2026-11-11"}',
    '{"date":"2026-11-11","districts":{}}']) {
    const f = await fixture(t);
    await writeFile(path.join(f.runtimeDir, 'auto-refresh-status.json'), contents);
    await f.scheduler.start();
    assert.equal(f.scheduler.status().last, null);
    assert.deepEqual(f.logs, [{ event: 'auto_refresh_status_invalid' }]);
    assert.equal(f.scheduler.status().next_run_at, '2026-11-12T01:00:00.000Z');
    await f.tick();
    assert.equal(f.calls.length, 2);
    assert.equal((await f.file()).result, 'completed');
  }
});

test('auto refresh config validates switches, clock, zone and source', () => {
  for (const time of [undefined, '', 'off', '24:00', '17:60', '9:00', 'oops'])
    assert.equal(autoRefreshConfig({ AUTO_REFRESH_TIME: time }, 'db').enabled, false);
  assert.equal(autoRefreshConfig({ AUTO_REFRESH_TIME: '17:00', AUTO_REFRESH_TZ: 'bad/zone' }, 'db').enabled, false);
  const logs = [];
  assert.equal(autoRefreshConfig({ AUTO_REFRESH_TIME: '17:00' }, 'json', x => logs.push(x)).enabled, false);
  assert.deepEqual(logs, ['auto_refresh_disabled: DATA_SOURCE=json']);
  assert.deepEqual(config, { enabled: true, time: '17:00', time_zone: 'America/Los_Angeles' });
});

test('17:00 starts districts serially; status is atomic and next day is scheduled', async t => {
  let resolve;
  const f = await fixture(t);
  f.launcher.start = async args => {
    f.calls.push(args);
    return { started: true, done: f.calls.length === 1 ? new Promise(r => { resolve = r; }) : Promise.resolve(completed) };
  };
  await f.scheduler.start();
  assert.equal(f.scheduler.status().next_run_at, '2026-11-12T01:00:00.000Z');
  const running = f.tick();
  await until(() => !!resolve);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.file()).result, 'running');
  resolve(completed); await running;
  assert.deepEqual(f.calls, ['first', 'second'].map(id => ({ scope: `district:${id}`, trigger: 'schedule' })));
  assert.equal((await f.file()).result, 'completed');
  assert.deepEqual(await readdir(f.runtimeDir), ['auto-refresh-status.json']);
  assert.equal(f.scheduler.status().next_run_at, '2026-11-13T01:00:00.000Z');
  f.setTime('2026-11-12T08:01:00Z'); await f.tick();
  assert.equal((await f.file()).date, '2026-11-12');
});

test('only failed districts retry, at 15 minutes, at most twice', async t => {
  const f = await fixture(t);
  f.launcher.start = async args => { f.calls.push(args); return { started: true,
    done: Promise.resolve(args.scope.endsWith('first') ? { status: 'stopped', stop_reason: 'capture:SelectorError' } : completed) }; };
  await f.scheduler.start(); const running = f.tick();
  await until(() => f.calls.length === 2 && !!f.timer());
  assert.equal(f.timer().at, Date.parse('2026-11-12T01:15:00Z'));
  await f.tick(); await until(() => f.calls.length === 3 && !!f.timer());
  await f.tick(); await running;
  assert.equal(f.calls.length, 4);
  assert.deepEqual((await f.file()).districts.map(d => d.attempts), [3, 1]);
  assert.equal((await f.file()).result, 'partial');
  assert.equal((await f.file()).retry_round, 2);
});

test('login stops remaining districts without retry; empty scopes succeed without launching runs', async t => {
  for (const empty of [false, true]) {
    const f = await fixture(t, undefined, { launcher: { start: async () => empty
      ? { started: false, error: 'empty_scope' }
      : { started: true, done: Promise.resolve({ status: 'stopped', stop_reason: 'capture:NeedsLoginError' }) } } });
    await f.scheduler.start(); await f.tick();
    const last = await f.file();
    assert.equal(last.result, empty ? 'completed' : 'needs_login');
    assert.equal(last.districts[1].status, empty ? 'skipped_empty' : 'not_run_login');
    assert.equal(last.retry_round, 0);
  }
});

test('busy waits five minutes, launches when freed, and abandons at 19:00 including start races', async t => {
  for (const race of [false, true]) {
    const f = await fixture(t);
    if (race) f.launcher.start = async () => ({ started: false, error: 'refresh_in_progress' });
    else f.busy(true);
    await f.scheduler.start(); const running = f.tick();
    await until(() => !!f.timer());
    assert.equal(f.timer().at, Date.parse('2026-11-12T01:05:00Z'));
    f.setTime('2026-11-12T02:59:00Z');
    // Simulate a sleeping machine waking at the deadline.
    const pending = f.timer(); f.setTime('2026-11-12T03:00:00Z'); await pending.fn();
    await running;
    assert.equal((await f.file()).result, 'skipped_busy');
    assert.ok((await f.file()).districts.every(d => d.status === 'skipped_busy'));
  }
  const f = await fixture(t); f.busy(true);
  await f.scheduler.start(); const running = f.tick(); await until(() => !!f.timer());
  f.busy(false); await f.tick(); await running;
  assert.equal((await f.file()).result, 'completed');
});

test('startup catchup cutoff, duplicate prevention, and restart recovery', async t => {
  for (const [instant, expected] of [
    ['2026-11-12T01:00:00Z', '2026-11-12T01:02:00.000Z'],
    ['2026-11-12T06:59:00Z', '2026-11-12T07:01:00.000Z'],
    ['2026-11-12T07:00:00Z', '2026-11-13T01:00:00.000Z']]) {
    const f = await fixture(t, instant); await f.scheduler.start();
    assert.equal(f.scheduler.status().next_run_at, expected);
  }
  for (const success of [false, true]) {
    const f = await fixture(t, '2026-11-12T02:00:00Z');
    await writeFile(path.join(f.runtimeDir, 'auto-refresh-status.json'), JSON.stringify({ date: '2026-11-11', result: 'running',
      districts: [{ id: 'first', status: success ? 'completed' : 'pending' }, { id: 'second', status: 'pending' }] }));
    await f.scheduler.start();
    assert.equal((await f.file()).result, success ? 'partial' : 'failed');
    assert.equal((await f.file()).districts[1].stop_reason, 'worker:Restarted');
    assert.equal(f.scheduler.status().next_run_at, '2026-11-13T01:00:00.000Z');
    f.scheduler.stop(); await f.scheduler.start();
    assert.equal(f.scheduler.status().next_run_at, '2026-11-13T01:00:00.000Z');
    assert.equal(f.calls.length, 0);
  }
});

test('DST days use local 17:00 with changing UTC offsets', async t => {
  for (const [instant, expected] of [
    ['2026-11-01T07:00:00Z', '2026-11-02T01:00:00.000Z'],
    ['2027-03-14T08:00:00Z', '2027-03-15T00:00:00.000Z'],
    ['2026-10-31T23:00:00Z', '2026-11-01T00:00:00.000Z']]) {
    const f = await fixture(t, instant); await f.scheduler.start();
    assert.equal(f.scheduler.status().next_run_at, expected);
  }
});

test('stop cancels waiting without terminating a child or launching more districts', async t => {
  let resolve;
  const f = await fixture(t, undefined, { launcher: { start: async () => ({ started: true,
    done: new Promise(r => { resolve = r; }) }) } });
  await f.scheduler.start(); const running = f.tick(); await until(() => !!resolve);
  f.scheduler.stop(); resolve(completed); await running;
  assert.equal(f.timer(), undefined);
  assert.equal(f.scheduler.status().next_run_at, null);
});

test('Worker status endpoint returns scheduler status and defaults disabled', async t => {
  const f = await fixture(t);
  const server = createWorkerServer({ runtimeDir: f.runtimeDir, dataSource: {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const request = () => new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${server.address().port}/api/auto-refresh/status`, res => {
      let body = ''; res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ code: res.statusCode, body: JSON.parse(body) }));
    }).on('error', reject);
  });
  assert.deepEqual(await request(), { code: 200, body: { enabled: false } });
  server.autoRefreshScheduler = f.scheduler;
  assert.deepEqual((await request()).body, f.scheduler.status());
});

test('start exceptions and rejected completion retry without blocking later districts', async t => {
  const f = await fixture(t);
  let attempts = 0;
  f.launcher.start = async args => {
    f.calls.push(args);
    if (args.scope.endsWith('second')) return { started: true, done: Promise.resolve(completed) };
    attempts++;
    if (attempts === 1) throw new Error('private upstream failure');
    if (attempts === 2) return { started: true, done: Promise.reject(new Error('private upstream failure')) };
    return { started: true, done: Promise.resolve(completed) };
  };
  await f.scheduler.start(); const running = f.tick();
  await until(() => f.calls.length === 2 && !!f.timer());
  await f.tick(); await until(() => f.calls.length === 3 && !!f.timer());
  await f.tick(); await running;
  assert.equal((await f.file()).result, 'completed');
  assert.equal(f.calls.length, 4);
  assert.ok(!JSON.stringify(f.logs).includes('private'));
});

test('disabled scheduler never sets a timer; stop releases a busy wait', async t => {
  const disabled = createAutoRefreshScheduler({ config: { ...config, enabled: false }, runtimeDir: tmpdir(),
    setTimeoutImpl: () => assert.fail('disabled timer'), readDistricts: () => assert.fail('disabled read') });
  await disabled.start(); assert.equal(disabled.status().next_run_at, null);
  const f = await fixture(t); f.busy(true);
  await f.scheduler.start(); const running = f.tick(); await until(() => !!f.timer());
  f.scheduler.stop(); await running;
  assert.equal(f.timer(), undefined); assert.equal(f.calls.length, 0);
});

test('Worker creates enabled scheduler, shares launcher, and stops on close', async t => {
  const f = await fixture(t);
  const server = new EventEmitter(); server.refreshLauncher = {};
  let started = 0, stopped = 0;
  assert.equal(await runWorker({ env: { DATA_SOURCE: 'db', RUNTIME_DATA_DIR: f.runtimeDir,
    AUTO_REFRESH_TIME: '17:00', NC_DB_READER_URL: 'postgres://mock@localhost/mock' },
    log: () => {}, errorLog: () => assert.fail('startup failed'),
    setup: async () => ({ close: async () => {} }), start: async () => server,
    makeAutoRefreshScheduler: options => {
      assert.equal(options.launcher, server.refreshLauncher);
      assert.deepEqual(options.config, config);
      return { start: () => { started++; }, stop: () => { stopped++; } };
    } }), 0);
  assert.equal(started, 1); server.emit('close'); assert.equal(stopped, 1);
});
