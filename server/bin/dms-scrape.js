import { homedir } from 'node:os';
import path from 'node:path';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolveStatePath, checkStatePath, parseBaseUrl, resolveRuntimeDir, checkRuntimeDir, parseMaxListRequests } from '../src/config.js';
import { transformRoutePortrait } from '../src/transform/route-profile.js';
import { saveStationSnapshot, writeLastFailure } from '../src/store/route-profiles-file.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export async function runScrape({ args = process.argv.slice(2), env = process.env, log = console.log,
  errorLog = console.error, sessionExists = access, capture, save = saveStationSnapshot, failure = writeLastFailure } = {}) {
  let station, headless = false, runtimeDir, step = 'config';
  try {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--station' && station === undefined) station = args[++i];
      else if (args[i] === '--headless' && !headless) headless = true;
      else throw new Error();
    }
    if (station !== 'SFO01') { errorLog('T3 只支持 SFO01；请传入 --station SFO01。'); return 1; }
    const options = { env, platform: process.platform, homedir: homedir(), repoRoot };
    const runtime = checkRuntimeDir(resolveRuntimeDir(options), repoRoot);
    runtimeDir = runtime.path;
    const state = checkStatePath(resolveStatePath(options), repoRoot);
    for (const warning of [...state.warnings, ...runtime.warnings]) log(warning);
    const url = parseBaseUrl(env.DMS_BASE_URL);
    const maxListRequests = parseMaxListRequests(env.MAX_PAGE_LOADS_PER_STATION);
    step = 'session';
    try { await sessionExists(state.path); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      errorLog('Session 文件不存在，请先运行 npm run dms:login。'); return 1;
    }
    step = 'capture';
    if (!capture) ({ captureRoutePortrait: capture } = await import('../src/dms/route-profile-page.js'));
    const result = await capture({ statePath: state.path, baseUrl: url.href, station, headless, maxListRequests, log });
    step = 'transform';
    const { stationSnapshot, warnings } = transformRoutePortrait(result.body, { station, fetchedAt: new Date().toISOString() });
    step = 'store';
    const filename = await save({ runtimeDir, station, stationSnapshot });
    log(`station：${station}；行数：${stationSnapshot.rows.length}；total：${stationSnapshot.total}；list 请求数：${result.listRequestCount}；输出：${filename}；parse_errors：${warnings.length}`);
    return 0;
  } catch (error) {
    const allowed = ['NeedsLoginError', 'SelectorError', 'LoadLimitError', 'CircuitBreakerError', 'CaptureError', 'SchemaError', 'StoreError'];
    const errorType = allowed.includes(error.name) ? error.name : 'Error';
    const detail = errorType === 'Error' ? null : error.message;
    if (errorType === 'NeedsLoginError') errorLog('请重新运行 npm run dms:login。');
    else {
      errorLog(`错误类型：${errorType}；阶段：${step}${detail ? `；原因：${detail}` : ''}`);
      if (runtimeDir) {
        try { await failure({ runtimeDir, station, step, errorType, detail }); }
        catch { errorLog('失败记录写入失败，请检查本地目录权限。'); }
      }
    }
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = await runScrape();
}
