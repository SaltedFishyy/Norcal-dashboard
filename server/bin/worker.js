import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntimeDir, checkRuntimeDir } from '../src/config.js';
import { createJsonDataSource } from '../src/store/data-source.js';
import { createDbDataSource } from '../src/db/db-data-source.js';
import { startWorkerServer } from '../src/worker/worker.js';
import { setupWarehouses, WarehousePrivilegeError } from '../src/warehouses/warehouse-setup.js';
import { createQuotationSyncScheduler, quotationSyncInterval } from '../src/quotations/quotation-sync-scheduler.js';
import { runScheduledQuotationSync } from '../src/quotations/quotation-sync-job.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
export async function runWorker({ env = process.env, log = console.log, errorLog = console.error,
  start = startWorkerServer, setup = setupWarehouses,
  makeScheduler = createQuotationSyncScheduler, syncJob = runScheduledQuotationSync } = {}) {
  const source = env.DATA_SOURCE ?? 'json';
  const value = env.WORKER_PORT ?? '3100';
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
    errorLog('WORKER_PORT 必须是 1–65535 的整数。'); return 1;
  }
  if (!['json', 'db'].includes(source)) { errorLog('DATA_SOURCE 必须是 json 或 db。'); return 1; }
  let dataSource, warehouses;
  try {
    const runtime = checkRuntimeDir(resolveRuntimeDir({ env, platform: process.platform, homedir: homedir(), repoRoot }), repoRoot);
    for (const warning of runtime.warnings) log(warning);
    dataSource = source === 'db' ? createDbDataSource({ env }) : createJsonDataSource({ runtimeDir: runtime.path });
    warehouses = await setup({ env, port, log });
    const intervalMinutes = quotationSyncInterval(env, source, log);
    const server = await start({ port, runtimeDir: runtime.path, repoRoot, dataSource, log, warehouses,
      quotationSyncIntervalMinutes: intervalMinutes });
    if (intervalMinutes > 0) {
      const scheduler = makeScheduler({ intervalMinutes, log,
        runOnce: () => syncJob({ env, runtimeDir: runtime.path }) });
      server.once('close', () => scheduler.stop());
      scheduler.start();
    }
    server?.once('close', () => { void dataSource.close?.(); });
    server?.once('close', () => { void warehouses.close(); });
    log(`Worker: http://127.0.0.1:${port}（仅本机 localhost-only）`);
    log(`Data source: ${source}`);
    return 0;
  } catch (error) {
    await dataSource?.close?.().catch(() => {});
    await warehouses?.close().catch(() => {});
    if (error instanceof WarehousePrivilegeError) { errorLog(error.message); return 1; }
    errorLog('Worker 启动失败，请检查端口和本地配置。'); return 1;
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = await runWorker();
}
