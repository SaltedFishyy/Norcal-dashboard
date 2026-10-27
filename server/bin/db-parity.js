import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntimeDir, checkRuntimeDir } from '../src/config.js';
import { createJsonDataSource } from '../src/store/data-source.js';
import { createDbDataSource } from '../src/db/db-data-source.js';
import { compareDataSources } from '../src/db/parity.js';
import { defaultGeoDir } from '../src/api/server.js';
import { defaultDistrictsPath } from '../src/store/districts-file.js';

export async function runParity({ env = process.env, log = console.log, errorLog = console.error,
  geoDir = defaultGeoDir, districtsPath = defaultDistrictsPath,
  createDbSource = createDbDataSource, compare = compareDataSources } = {}) {
  let dbSource;
  try {
    const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
    const runtime = checkRuntimeDir(resolveRuntimeDir({ env, platform: process.platform, homedir: homedir(), repoRoot }), repoRoot);
    dbSource = createDbSource({ env });
    const result = await compare({ runtimeDir: runtime.path, geoDir, districtsPath,
      jsonSource: createJsonDataSource({ runtimeDir: runtime.path }), dbSource, log });
    return result.exitCode;
  } catch (error) {
    const name = typeof error?.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(error.name) ? error.name : 'Error';
    const code = typeof error?.code === 'string' && /^[0-9A-Z_]{1,40}$/.test(error.code) ? ` / ${error.code}` : '';
    errorLog(`对照失败（${name}${code}），请检查本地数据和数据库配置。`);
    return 1;
  }
  finally { await dbSource?.close().catch(() => {}); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) process.exitCode = await runParity();
