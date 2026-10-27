import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectDb } from '../src/db/connection.js';

export async function abandonRun({ args = process.argv.slice(2), connect = () => connectDb('NC_DB_SCRAPER_URL'),
  log = console.log, errorLog = console.error } = {}) {
  if (args.length !== 2 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args[0])
    || args[1] !== '--confirm-no-scrape-running') {
    errorLog('需要有效 UUID 和 --confirm-no-scrape-running，确认当前没有抓取运行。'); return 1;
  }
  let client;
  try {
    client = await connect();
    const result = await client.query(`UPDATE scrape_runs SET status='abandoned', finished_at=now(),
      stop_reason='manual:abandoned' WHERE id=$1 AND status='running'`, [args[0]]);
    if (!result.rowCount) { errorLog('该 run 不存在或不是 running'); return 1; }
    log('run 已标记为 abandoned。'); return 0;
  } catch { errorLog('数据库操作失败，请检查本地配置和数据库服务。'); return 1; }
  finally { if (client) await client.end().catch(() => {}); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await abandonRun();
