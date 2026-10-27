import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntimeDir, checkRuntimeDir } from '../src/config.js';
import { connectDb } from '../src/db/connection.js';
import { importJson, JsonImportError } from '../src/db/json-import.js';

export async function runImportJson({ env = process.env, log = console.log, errorLog = console.error,
  connect = () => connectDb('NC_DB_SCRAPER_URL', { env }) } = {}) {
  let client;
  try {
    const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
    const runtime = checkRuntimeDir(resolveRuntimeDir({ env, platform: process.platform, homedir: homedir(), repoRoot }), repoRoot);
    client = await connect();
    const counts = await importJson({ runtimeDir: runtime.path, client });
    log(`导入 Station: ${counts.stations}; Route: ${counts.routes}; detail: ${counts.details}`);
    return 0;
  } catch (error) {
    errorLog(error instanceof JsonImportError ? error.message : 'JSON 导入失败，请检查本地配置和数据库服务。');
    return 1;
  } finally { await client?.end().catch(() => {}); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) process.exitCode = await runImportJson();
