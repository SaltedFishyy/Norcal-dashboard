import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntimeDir, checkRuntimeDir } from '../src/config.js';
import { readRouteProfiles } from '../src/store/route-profiles-file.js';
import { writeFileAtomic } from '../src/store/atomic-file.js';
import { exportTableauRouteZips } from '../src/export/tableau-route-zips.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export async function runExport({ env = process.env, log = console.log, errorLog = console.error,
  read = readRouteProfiles, write = writeFileAtomic } = {}) {
  try {
    const runtime = checkRuntimeDir(resolveRuntimeDir({ env, platform: process.platform, homedir: homedir(), repoRoot }), repoRoot);
    for (const warning of runtime.warnings) log(warning);
    const result = exportTableauRouteZips(await read({ runtimeDir: runtime.path }));
    const filename = path.join(runtime.path, 'tableau', 'route-zips.csv');
    await write(filename, result.csv);
    for (const item of result.summary) log(`Station ${item.station}: Route 数 ${item.route_count} / 行数 ${item.row_count} / 唯一 ZIP 数 ${item.unique_zip_count}`);
    log(`冲突数 ${result.conflict_count}；输出：${filename}`);
    return 0;
  } catch (error) {
    const known = ['SchemaError', 'SnapshotNotFoundError', 'SnapshotInvalidError'].includes(error.name);
    errorLog(known ? error.message : 'CSV 导出读取或写入失败，旧文件保留。');
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = await runExport();
}
