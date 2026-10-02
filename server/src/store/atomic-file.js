import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function writeFileAtomic(filename, text, { fileOps = fs } = {}) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await fileOps.mkdir(path.dirname(filename), { recursive: true });
    await fileOps.writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
    await fileOps.rename(temporary, filename);
  } finally {
    await fileOps.rm(temporary, { force: true }).catch(() => {});
  }
}
