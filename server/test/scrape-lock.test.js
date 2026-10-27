import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { acquireScrapeLock, LockedError } from '../src/batch/scrape-lock.js';
import { batchFixture } from './multi-station-fixtures.js';

const directory = async t => {
  const runtimeDir = await fs.mkdtemp(path.join(tmpdir(), 'nc-scrape-lock-'));
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  return runtimeDir;
};
test('scrape lock excludes competitors, cleans stale locks and releases only its own owner', async t => {
  const runtimeDir = await directory(t), filename = path.join(runtimeDir, 'scrape.lock');
  const release = await acquireScrapeLock({ runtimeDir, pid: 123, startedAt: 'first', trigger: 'ui', isAlive: () => true });
  assert.deepEqual(JSON.parse(await fs.readFile(filename)), { pid: 123, started_at: 'first', trigger: 'ui' });
  await assert.rejects(acquireScrapeLock({ runtimeDir, pid: 124, isAlive: () => true }), LockedError);
  await fs.writeFile(filename, JSON.stringify({ pid: 123, started_at: 'other' }));
  await release(); assert.equal(JSON.parse(await fs.readFile(filename)).started_at, 'other');
  await fs.writeFile(filename, JSON.stringify({ pid: 124, started_at: 'first' }));
  await release(); assert.equal(JSON.parse(await fs.readFile(filename)).pid, 124);
  const staleRelease = await acquireScrapeLock({ runtimeDir, pid: 125, isAlive: () => false });
  assert.equal(JSON.parse(await fs.readFile(filename)).pid, 125);
  await staleRelease(); await staleRelease();
  await assert.rejects(fs.access(filename), { code: 'ENOENT' });
  await fs.writeFile(filename, 'invalid');
  await assert.rejects(acquireScrapeLock({ runtimeDir, isAlive: () => false }), LockedError);
});

test('scrape lock blocks second batch before DB/DMS and preserves state and progress', async t => {
  const runtimeDir = await directory(t), progressFile = path.join(runtimeDir, 'progress.json');
  await fs.writeFile(progressFile, 'original progress');
  const release = await acquireScrapeLock({ runtimeDir, pid: 123, isAlive: () => true });
  t.after(release);
  const h = batchFixture(); let dbStarts = 0, writes = 0;
  assert.equal(await h.run({ args: ['--stations', 'SFO01', '--progress-file', progressFile],
    env: { DMS_BASE_URL: 'https://example.invalid', RUNTIME_DATA_DIR: runtimeDir, DB_DUAL_WRITE: '1' },
    acquireLock: args => acquireScrapeLock({ ...args, isAlive: () => true }),
    dbSinkFactory: () => { dbStarts++; }, writeBatch: () => { writes++; } }), 1);
  assert.equal(dbStarts, 0); assert.equal(writes, 0); assert.equal(h.pageHarness.requests, 0);
  assert.equal(h.state, null); assert.equal(await fs.readFile(progressFile, 'utf8'), 'original progress');
  assert.ok(h.logs.some(value => value.endsWith('config:LockedError')));
});

test('batch lock releases after session failure and after a completed run', async t => {
  const runtimeDir = await directory(t);
  for (const fail of [true, false]) {
    const h = batchFixture();
    assert.equal(await h.run({ env: { DMS_BASE_URL: 'https://example.invalid', RUNTIME_DATA_DIR: runtimeDir },
      acquireLock: args => acquireScrapeLock({ ...args, isAlive: () => true }),
      ...(fail ? { session: async () => { throw new Error('synthetic'); } } : {}) }), fail ? 1 : 0);
    await assert.rejects(fs.access(path.join(runtimeDir, 'scrape.lock')), { code: 'ENOENT' });
  }
});
