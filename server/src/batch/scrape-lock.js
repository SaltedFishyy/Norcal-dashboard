import * as fs from 'node:fs/promises';
import path from 'node:path';

export class LockedError extends Error {
  constructor() { super('已有抓取运行或锁无法安全确认。'); this.name = 'LockedError'; }
}
export function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
export async function acquireScrapeLock({ runtimeDir, trigger = 'cli', pid = process.pid,
  startedAt = new Date().toISOString(), isAlive = processIsAlive, fileOps = fs }) {
  const filename = path.join(runtimeDir, 'scrape.lock');
  const owner = { pid, started_at: startedAt, trigger };
  await fileOps.mkdir(runtimeDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fileOps.open(filename, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(owner)); }
      catch (error) { await fileOps.unlink(filename).catch(() => {}); throw error; }
      finally { await handle.close(); }
      return async () => {
        try {
          const value = JSON.parse(await fileOps.readFile(filename, 'utf8'));
          if (value.pid === pid && value.started_at === startedAt) await fileOps.unlink(filename);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let value;
      try { value = JSON.parse(await fileOps.readFile(filename, 'utf8')); }
      catch { throw new LockedError(); }
      if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || await isAlive(value.pid) || attempt) throw new LockedError();
      await fileOps.unlink(filename);
    }
  }
  throw new LockedError();
}
