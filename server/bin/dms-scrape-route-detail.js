import { homedir } from 'node:os';
import path from 'node:path';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolveStatePath, checkStatePath, parseBaseUrl, resolveRuntimeDir, checkRuntimeDir, parseMaxListRequests, parseMaxRouteDetailRequests } from '../src/config.js';
import { transformRouteDetail } from '../src/transform/route-detail.js';
import { SchemaError } from '../src/transform/route-profile.js';
import { writeLastFailure } from '../src/store/route-profiles-file.js';
import { saveRouteDetail } from '../src/store/route-details-file.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export async function runRouteDetailScrape({ args = process.argv.slice(2), env = process.env, log = console.log,
  errorLog = console.error, sessionExists = access, capture, save = saveRouteDetail, failure = writeLastFailure } = {}) {
  let station, routeName, headless = false, runtimeDir, step = 'config';
  try {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--station' && station === undefined) {
        station = args[++i]; if (station === undefined) throw new Error();
      }
      else if (args[i] === '--route' && routeName === undefined) routeName = args[++i];
      else if (args[i] === '--headless' && !headless) headless = true;
      else throw new Error();
    }
    station ??= 'SFO01';
    if (station !== 'SFO01' || !/^[A-Za-z0-9._-]{1,64}$/.test(routeName || '')) {
      errorLog('必须提供有效的 --route；第一版只支持 --station SFO01。'); return 1;
    }
    const options = { env, platform: process.platform, homedir: homedir(), repoRoot };
    const runtime = checkRuntimeDir(resolveRuntimeDir(options), repoRoot);
    runtimeDir = runtime.path;
    const state = checkStatePath(resolveStatePath(options), repoRoot);
    for (const warning of [...state.warnings, ...runtime.warnings]) log(warning);
    const url = parseBaseUrl(env.DMS_BASE_URL);
    const maxListRequests = parseMaxListRequests(env.MAX_PAGE_LOADS_PER_STATION);
    const maxDetailRequests = parseMaxRouteDetailRequests(env.MAX_ROUTE_DETAIL_REQUESTS);
    step = 'session';
    try { await sessionExists(state.path); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      errorLog('Session 文件不存在，请先运行 npm run dms:login。');
      await failure({ runtimeDir, station, step, errorType: 'NeedsLoginError', detail: null });
      return 1;
    }
    step = 'capture';
    if (!capture) ({ captureRouteDetail: capture } = await import('../src/dms/route-detail-page.js'));
    const result = await capture({ statePath: state.path, baseUrl: url.href, station, routeName, headless, maxListRequests, maxDetailRequests, log });
    step = 'transform';
    if (result.headerBody?.data?.roadAreaName !== routeName) throw new SchemaError('Route 名称不一致');
    const { route } = transformRouteDetail(result, { station, routeId: result.routeId, fetchedAt: new Date().toISOString() });
    step = 'store';
    const filename = await save({ runtimeDir, route });
    log(`station：${station}；route：${routeName}；route_id：${route.route_id}；ZIP 数：${route.zips.length}；list 请求数：${result.listRequestCount}；detail 请求数：${result.detailRequestCount}；locate_method：${result.locateMethod ?? '—'}；输出：${filename}`);
    if (result.restorationError) { step = 'capture'; throw result.restorationError; }
    return 0;
  } catch (error) {
    const allowed = ['NeedsLoginError', 'SelectorError', 'LoadLimitError', 'CircuitBreakerError', 'CaptureError', 'SchemaError', 'StoreError'];
    const errorType = allowed.includes(error.name) ? error.name : 'Error';
    const detail = errorType === 'Error' ? null : error.message;
    if (errorType === 'NeedsLoginError') errorLog('请重新运行 npm run dms:login。');
    else errorLog(`错误类型：${errorType}；阶段：${step}${detail ? `；原因：${detail}` : ''}`);
    if (runtimeDir) {
      try { await failure({ runtimeDir, station, step, errorType, detail }); }
      catch { errorLog('失败记录写入失败，请检查本地目录权限。'); }
    }
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = await runRouteDetailScrape();
}
