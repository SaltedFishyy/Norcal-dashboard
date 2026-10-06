import { homedir } from 'node:os';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolveStatePath, checkStatePath, parseBaseUrl, resolveRuntimeDir, checkRuntimeDir,
  parseMaxListRequests, parseMaxRouteDetailRequests, parseRouteDetailBatchDelay,
  parseMaxRouteDetailBatchRequests, parseMaxRouteDetailBatchProdApiRequests } from '../src/config.js';
import { withPortraitPage, CaptureError, InterruptedError } from '../src/dms/portrait-page.js';
import { captureRouteDetailOnPage, closeRouteDetailModals } from '../src/dms/route-detail-page.js';
import { transformRouteDetail } from '../src/transform/route-detail.js';
import { listCachedRouteIds, getRouteDetail, saveRouteDetail, writeRouteDetailsBatchRun } from '../src/store/route-details-file.js';
import { writeLastFailure } from '../src/store/route-profiles-file.js';
import { writeFileAtomic } from '../src/store/atomic-file.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
export function diagnosticMessage(error) {
  const seen = new Set();
  while (error?.cause && !seen.has(error.cause)) { seen.add(error); error = error.cause; }
  return String(error?.message || '').split(/[\r\n]/, 1)[0]
    .replace(/https?:\/\/\S+/g, '').split(/[?#]/, 1)[0].slice(0, 300);
}
export function parseBatchArgs(args) {
  const seen = new Set();
  const options = { refresh: false, headless: false, maxRoutes: null };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) throw new Error();
    seen.add(flag);
    if (flag === '--station') options.station = args[++i];
    else if (flag === '--refresh') options.refresh = true;
    else if (flag === '--headless') options.headless = true;
    else if (flag === '--max-routes') {
      const value = args[++i];
      if (!/^[1-9]\d*$/.test(value || '') || !Number.isSafeInteger(Number(value))) throw new Error();
      options.maxRoutes = Number(value);
    } else throw new Error();
  }
  if (options.station !== 'SFO01') throw new Error();
  return options;
}

export function selectBatchRoutes(body, station) {
  if (!Array.isArray(body?.data?.records)) throw new CaptureError();
  const names = new Set(), ids = new Set();
  return body.data.records.filter(row => row?.transitStationName === station).map(row => {
    const routeName = row.roadAreaName, rawId = row.roadAreaId;
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(typeof routeName === 'string' ? routeName : '')
      || !(typeof rawId === 'number' || typeof rawId === 'string' && /^\d+$/.test(rawId))) throw new CaptureError();
    const routeId = Number(rawId);
    if (!Number.isSafeInteger(routeId) || routeId < 1 || names.has(routeName) || ids.has(routeId)) throw new CaptureError();
    names.add(routeName); ids.add(routeId);
    return { route_id: routeId, route_name: routeName, result: 'not_run', zip_count: null, detail_requests: 0,
      locate_method: null, attempts: [] };
  });
}

export async function runRouteDetailsBatch({ args = process.argv.slice(2), env = process.env, log = console.log,
  errorLog = console.error, sessionExists = fs.access, session = withPortraitPage,
  capture = captureRouteDetailOnPage, closeModals = closeRouteDetailModals,
  cachedIds = listCachedRouteIds, cachedDetail = getRouteDetail, save = saveRouteDetail,
  writeRun = writeRouteDetailsBatchRun, failure = writeLastFailure, signals = process,
  now = () => new Date(), diagnosticFileOps = fs } = {}) {
  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  const startedAt = now();
  let options = {}, runtimeDir, step = 'config', current, phase, stopReason = null, exitCode = 0;
  let counts = { prodApiRequestCount: 0, listRequestCount: 0, detailRequestCount: 0, maxRouteDetailRequestCount: 0 };
  let routes = [], missing = [], caught, diagnostic = null, total = null, pagesLoaded = 0;
  signals.on('SIGINT', onInterrupt);
  const checkInterrupted = () => { if (controller.signal.aborted) throw new InterruptedError(); };
  try {
    options = parseBatchArgs(args);
    log('请勿同时运行其他抓取命令。');
    const config = { env, platform: process.platform, homedir: homedir(), repoRoot };
    const runtime = checkRuntimeDir(resolveRuntimeDir(config), repoRoot);
    runtimeDir = runtime.path;
    const state = checkStatePath(resolveStatePath(config), repoRoot);
    for (const warning of [...state.warnings, ...runtime.warnings]) log(warning);
    const baseUrl = parseBaseUrl(env.DMS_BASE_URL).href;
    const maxListRequests = parseMaxListRequests(env.MAX_PAGE_LOADS_PER_STATION);
    const maxDetailRequests = parseMaxRouteDetailRequests(env.MAX_ROUTE_DETAIL_REQUESTS);
    const delayMs = parseRouteDetailBatchDelay(env.ROUTE_DETAIL_BATCH_DELAY_MS);
    const maxBatchDetailRequests = parseMaxRouteDetailBatchRequests(env.MAX_ROUTE_DETAIL_BATCH_REQUESTS);
    const maxProdApiRequests = parseMaxRouteDetailBatchProdApiRequests(env.MAX_ROUTE_DETAIL_BATCH_PROD_API_REQUESTS);
    step = 'session';
    try { await sessionExists(state.path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; throw Object.assign(new Error(), { name: 'NeedsLoginError' }); }
    checkInterrupted();
    step = 'store';
    const cached = await cachedIds({ runtimeDir });
    checkInterrupted();
    // The current target list is only known after the single live query; do not invent its size.
    log(`计划（打开浏览器前）：目标数待列表确认；缓存 ${cached.size} 条；跳过数待确认；本次抓取${options.maxRoutes === null ? '数待确认' : `至多 ${options.maxRoutes} 条`}；预计请求${options.maxRoutes === null ? '量待确认（20 + 17 × 条数）' : `至多约 ${20 + 17 * options.maxRoutes} 个`}。`);
    step = 'capture';
    await session({ statePath: state.path, baseUrl, station: options.station, headless: options.headless,
      maxListRequests, maxDetailRequests, maxBatchDetailRequests, maxProdApiRequests, batch: true,
      listRequestPath: '/roadAreaPortrait/home/frontPage/', needsLoginOn401: true,
      signal: controller.signal, log, onCounts: value => { counts = value; },
      onPageFailure: async ({ page, error }) => {
        if (!['capture', 'close_modals', 'delay'].includes(phase)) return;
        const json = 'route-details-batch-failure.json', png = 'route-details-batch-failure.png';
        let screenshot = null, warned = false;
        const warn = () => { if (!warned) { warned = true; errorLog('诊断保存失败，请检查本地目录或页面状态。'); } };
        let timer, expired = false;
        const work = async () => {
          try {
            await diagnosticFileOps.mkdir(runtimeDir, { recursive: true });
            if (expired) return;
            await page.screenshot({ path: path.join(runtimeDir, png), fullPage: false, timeout: 4000 });
            screenshot = png;
          } catch { warn(); }
          if (expired) return;
          try {
            const record = { at: now().toISOString(), route_name: current?.route_name ?? null,
              route_id: current?.route_id ?? null, phase, error_type: error.name,
              step: error.name === 'SelectorError' ? error.message.replace(/^页面控件不可用：/, '') : null,
              message_first_line: diagnosticMessage(error) };
            await writeFileAtomic(path.join(runtimeDir, json), JSON.stringify(record, null, 2) + '\n', { fileOps: diagnosticFileOps });
            if (!expired) diagnostic = { json, screenshot };
          } catch { warn(); }
        };
        try {
          await Promise.race([work(), new Promise(resolve => {
            timer = setTimeout(() => { expired = true; warn(); resolve(); }, 4500);
          })]);
        } finally { clearTimeout(timer); }
      } }, async context => {
      total = context.body.data.total;
      const pages = Math.max(1, Math.ceil(total / 100));
      let body = context.body, attempted = 0;
      const targetIds = new Set(), names = new Set();
      for (let pageNumber = 1; pageNumber <= pages; pageNumber++) {
        const pageRoutes = selectBatchRoutes(body, options.station);
        if (pageNumber > 1 && !pageRoutes.length) throw new CaptureError();
        for (const route of pageRoutes) {
          if (targetIds.has(route.route_id) || names.has(route.route_name)) throw new CaptureError();
        }
        pagesLoaded++;
        for (const route of pageRoutes) { targetIds.add(route.route_id); names.add(route.route_name); }
        routes.push(...pageRoutes);
        // Unvisited pages cannot establish that a cached ID is absent from the list.
        missing = pagesLoaded === pages ? [...cached].filter(id => !targetIds.has(id)).sort((a, b) => a - b) : [];
        for (const route of pageRoutes) {
          if (!options.refresh && cached.has(route.route_id) && !cached.missingPickup?.has(route.route_id)) route.result = 'skipped';
        }
        const skipped = pageRoutes.filter(route => route.result === 'skipped');
        const pending = pageRoutes.filter(route => route.result !== 'skipped').slice(0, options.maxRoutes === null ? pageRoutes.length : options.maxRoutes - attempted);
        log(`计划（列表加载后）：目标 ${total} 条；已加载 ${pagesLoaded} 页；已缓存跳过 ${routes.filter(route => route.result === 'skipped').length} 条；缺领件量重抓 ${pending.filter(route => cached.missingPickup?.has(route.route_id)).length} 条；本页抓取 ${pending.length} 条；预计请求约 ${20 + 17 * pending.length} 个。`);
        for (const route of skipped) {
          const detail = await context.guarded(() => cachedDetail({ runtimeDir, routeId: route.route_id }));
          log(`[—] ${route.route_name} route_id=${route.route_id} 已缓存（${detail.fetched_at}），跳过`);
        }
        for (let i = 0; i < pending.length; i++) {
          current = pending[i];
          attempted++;
          context.beginRoute();
          phase = 'capture'; step = 'capture';
          context.location = null;
          try {
            const result = await context.guarded(() => capture(context, { routeName: current.route_name, routeId: current.route_id }));
            current.locate_method = result.locateMethod ?? null;
            current.attempts = result.attempts ?? [];
            checkInterrupted();
            phase = 'transform'; step = 'transform';
            const { route } = transformRouteDetail(result, { station: options.station, routeId: current.route_id, fetchedAt: now().toISOString() });
            phase = 'store'; step = 'store';
            await context.guarded(async () => { checkInterrupted(); });
            // Await the atomic write itself: never race it and report not_run while a write is still in flight.
            await save({ runtimeDir, route, fileOps: { ...fs,
              rename: async (...args) => {
                // Cancellation before the atomic commit leaves the old cache untouched.
                await context.guarded(async () => { checkInterrupted(); });
                return fs.rename(...args);
              },
            } });
            current.result = 'written'; current.zip_count = route.zips.length;
            current.detail_requests = context.counts().routeDetailRequestCount;
            log(`[${attempted}/${options.maxRoutes === null ? total : Math.min(total, options.maxRoutes)}] ${current.route_name} route_id=${current.route_id} ZIP ${current.zip_count} 详情请求 ${current.detail_requests} locate_method=${current.locate_method ?? '—'} attempts=${JSON.stringify(current.attempts)} ✓ 已写入`);
            phase = 'close_modals'; step = 'capture';
            if (result.restorationError) throw result.restorationError;
            await context.guarded(() => closeModals(context));
            if (result.restoreList) await context.guarded(result.restoreList);
            if (i < pending.length - 1) {
              phase = 'delay';
              await context.guarded(() => context.page.waitForTimeout(delayMs));
            }
          } catch (error) {
            current.locate_method ??= context.location?.locateMethod ?? null;
            current.attempts = context.location?.attempts ?? current.attempts;
            current.attempts = error.attempts ?? current.attempts;
            current.detail_requests = context.counts().routeDetailRequestCount;
            if (current.result !== 'written') {
              current.result = 'failed';
              log(`[${attempted}/${options.maxRoutes === null ? total : Math.min(total, options.maxRoutes)}] ${current.route_name} route_id=${current.route_id} locate_method=${current.locate_method ?? '—'} attempts=${JSON.stringify(current.attempts)} 失败`);
            }
            throw error;
          }
        }
        if (options.maxRoutes !== null && attempted >= options.maxRoutes || pageNumber === pages) break;
        phase = 'delay';
        await context.guarded(() => context.page.waitForTimeout(delayMs));
        phase = 'capture'; step = 'capture';
        body = await context.nextPage(pageNumber);
        context.body = body;
      }
    });
    checkInterrupted();
  } catch (error) {
    caught = error;
    const safeTypes = new Set(['NeedsLoginError', 'SelectorError', 'LoadLimitError', 'CircuitBreakerError', 'CaptureError', 'SchemaError', 'StoreError', 'RouteDetailInvalidError', 'InterruptedError']);
    const type = safeTypes.has(error.name) ? error.name : 'Error';
    stopReason = `${phase || step}:${type}`;
    exitCode = controller.signal.aborted || type === 'InterruptedError' ? 130 : 1;
    errorLog(`批次停止：${stopReason}${type === 'NeedsLoginError' ? '；请运行 npm run dms:login。' : ''}`);
  } finally {
    const finishedAt = now();
    const record = { started_at: startedAt.toISOString(), finished_at: finishedAt.toISOString(),
      station: options.station ?? null, refresh: options.refresh ?? false, max_routes: options.maxRoutes ?? null,
      status: exitCode ? 'stopped' : 'completed', stop_reason: stopReason,
      stopped_at_route: exitCode && current ? current.route_name : null,
      total, pages_loaded: pagesLoaded, target_count: total ?? routes.length, written_count: routes.filter(route => route.result === 'written').length,
      skipped_count: routes.filter(route => route.result === 'skipped').length,
      failed_count: routes.filter(route => route.result === 'failed').length,
      not_run_count: routes.filter(route => route.result === 'not_run').length,
      prod_api_requests: counts.prodApiRequestCount, list_requests: counts.listRequestCount,
      detail_requests: counts.detailRequestCount, max_route_detail_requests: counts.maxRouteDetailRequestCount,
      locate_method_counts: Object.fromEntries(['L1', 'L2', 'L3', 'L5'].map(method => [method, routes.filter(route => route.locate_method === method).length])),
      duration_ms: finishedAt - startedAt, cached_not_in_list: missing, routes, diagnostic };
    if (runtimeDir) {
      try { await writeRun({ runtimeDir, record }); }
      catch {
        exitCode ||= 1; record.status = 'stopped'; record.stop_reason ||= 'run_record:StoreError';
        errorLog('运行记录写入失败，请检查本地目录权限。');
      }
      if (exitCode) {
        try { await failure({ runtimeDir, station: options.station, step,
          errorType: caught?.name || 'StoreError', detail: null }); }
        catch { errorLog('失败记录写入失败，请检查本地目录权限。'); }
      }
    }
    log(`汇总：目标 ${record.target_count}；成功 ${record.written_count}；跳过 ${record.skipped_count}；失败 ${record.failed_count}；未处理 ${record.not_run_count}；/prod-api/ ${record.prod_api_requests}；列表 ${record.list_requests}；详情 ${record.detail_requests}；每条最大 ${record.max_route_detail_requests}；用时 ${record.duration_ms} ms；停止原因 ${record.stop_reason || '无'}；停止线路 ${record.stopped_at_route || '无'}；缓存中不在列表的 route_id：${missing.join(', ') || '无'}`);
    signals.off('SIGINT', onInterrupt);
    log(`定位方法：${JSON.stringify(record.locate_method_counts)}`);
    log(`诊断：${diagnostic ? [diagnostic.json, diagnostic.screenshot].filter(Boolean).join('、') : '无'}`);
  }
  return exitCode;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = await runRouteDetailsBatch();
}
