import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntimeDir, checkRuntimeDir } from '../src/config.js';
import { startApiServer } from '../src/api/server.js';
import { createDbDataSource } from '../src/db/db-data-source.js';
import { dbConfig } from '../src/db/connection.js';
import { isIP } from 'node:net';
import { excessivePrivileges } from '../src/warehouses/warehouse-setup.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export async function runServer({ env = process.env, log = console.log, errorLog = console.error,
  start = startApiServer, createDataSource = createDbDataSource } = {}) {
  const host = env.LISTEN_HOST ?? '127.0.0.1';
  const lan = !['127.0.0.1', 'localhost'].includes(host);
  const rejectLan = () => { errorLog('局域网只读服务配置不安全，拒绝启动。'); return 1; };
  if (host !== 'localhost' && isIP(host) !== 4) {
    errorLog('LISTEN_HOST 必须是 IPv4 地址或 localhost。'); return 1;
  }
  const source = env.DATA_SOURCE === undefined ? 'json' : env.DATA_SOURCE;
  if (lan && (source !== 'db' || ['NC_DB_SCRAPER_URL', 'NC_DB_OWNER_URL', 'NC_DB_WAREHOUSE_URL', 'DMS_BASE_URL', 'DMS_STATE_PATH']
    .some(key => env[key] !== undefined && env[key] !== ''))) return rejectLan();
  if (!['json', 'db'].includes(source)) {
    errorLog('DATA_SOURCE 必须是 json 或 db。'); return 1;
  }
  if (source === 'db') {
    try { dbConfig('NC_DB_READER_URL', { env }); }
    catch { if (lan) return rejectLan(); errorLog('DB 数据源连接配置缺失或无效，请检查 NC_DB_READER_URL。'); return 1; }
  }
  const value = env.PORT === undefined ? '3000' : env.PORT.trim();
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
    errorLog('PORT 必须是 1–65535 的整数。'); return 1;
  }
  let dataSource;
  try {
    const runtime = checkRuntimeDir(resolveRuntimeDir({ env, platform: process.platform, homedir: homedir(), repoRoot }), repoRoot);
    for (const warning of runtime.warnings) log(warning);
    if (source === 'db') dataSource = createDataSource({ env });
    if (lan) {
      try { if (await dataSource.canWriteRuns() !== false) { await dataSource.close(); return rejectLan(); } }
      catch { await dataSource.close().catch(() => {}); return rejectLan(); }
      try {
        if (excessivePrivileges(await dataSource.checkReaderWarehouseIsolation())) {
          await dataSource.close(); return rejectLan();
        }
      } catch { await dataSource.close().catch(() => {}); return rejectLan(); }
    }
    const server = await start({ port, host, runtimeDir: runtime.path, log, ...(dataSource ? { dataSource } : {}) });
    if (dataSource) server?.once('close', () => { void dataSource.close(); });
    log(`Data source: ${source}`);
    log(`Server: http://${host}:${port}${lan ? '（局域网只读）' : ''}`);
    log(`Runtime data: ${runtime.path}`);
    return 0;
  } catch (error) {
    await dataSource?.close().catch(() => {});
    errorLog(error?.code === 'EADDRINUSE' ? `端口 ${port} 已被占用。` : 'Server 启动失败，请检查端口和本地配置。');
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = await runServer();
}
