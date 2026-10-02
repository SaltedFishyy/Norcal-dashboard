import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from '../src/store/atomic-file.js';

test('atomic write creates directory, uses wx and 0600, renames then cleans', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-atomic-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'nested', 'file.csv'); const events = [];
  const fileOps = { ...fs,
    writeFile: async (...args) => { events.push(['write', ...args]); await fs.writeFile(...args); },
    rename: async (...args) => { events.push(['rename', ...args]); await fs.rename(...args); },
  };
  await writeFileAtomic(filename, 'mock\n', { fileOps });
  assert.equal(await fs.readFile(filename, 'utf8'), 'mock\n');
  assert.deepEqual(events[0][3], { flag: 'wx', mode: 0o600 });
  assert.deepEqual(events[1], ['rename', events[0][1], filename]);
  assert.deepEqual(await fs.readdir(path.dirname(filename)), ['file.csv']);
  for (const operation of ['writeFile', 'rename']) {
    await assert.rejects(writeFileAtomic(filename, 'new', { fileOps: { ...fs, [operation]: async (...args) => {
      if (operation === 'writeFile') await fs.writeFile(...args);
      throw new Error('synthetic failure');
    } } }), /synthetic failure/);
    assert.equal(await fs.readFile(filename, 'utf8'), 'mock\n');
    assert.deepEqual(await fs.readdir(path.dirname(filename)), ['file.csv']);
  }
});
