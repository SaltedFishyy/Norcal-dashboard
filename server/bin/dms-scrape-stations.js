import { homedir } from 'node:os';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseStationBatchArgs, parseStationBatchConfig, stationRequestCap, resolveRuntimeDir, checkRuntimeDir,
  resolveStatePath, checkStatePath, parseBaseUrl } from '../src/config.js';
import { withPortraitPage, CaptureError, InterruptedError, SelectorError } from '../src/dms/portrait-page.js';
import { readCurrentStation, assertCurrentStation, switchStation, StationMismatchError } from '../src/dms/station-switch.js';
import { captureRouteDetailOnPage, closeRouteDetailModals } from '../src/dms/route-detail-page.js';
import { transformRoutePortrait } from '../src/transform/route-profile.js';
import { transformRouteDetail } from '../src/transform/route-detail.js';
import { saveStationSnapshot, readRouteProfiles, SnapshotNotFoundError } from '../src/store/route-profiles-file.js';
import { readRouteDetailsForBatch, saveRouteDetail } from '../src/store/route-details-file.js';
import { readStationBatchState, prepareStationBatchState, writeStationBatchFile } from '../src/store/station-batch-file.js';
import { completeRouteDetail, checkStationIntegrity, IntegrityError } from '../src/batch/station-integrity.js';
import { createJsonBatchSink } from '../src/batch/batch-sink.js';
import { createDualBatchSink } from '../src/batch/dual-batch-sink.js';
import { createDbBatchSink } from '../src/db/batch-db-sink.js';
import { connectDb } from '../src/db/connection.js';
import { writePageFailureDiagnostic } from '../src/dms/batch-diagnostics.js';
import { readBoundaries } from '../src/store/boundaries-file.js';
import { selectBatchRoutes } from './dms-scrape-route-details.js';

import { defaultDistrictsPath, validateDistricts } from '../src/store/districts-file.js';
import { planRefresh } from '../src/batch/refresh-plan.js';
import { acquireScrapeLock } from '../src/batch/scrape-lock.js';
import { writeFileAtomic } from '../src/store/atomic-file.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
export function validateStationList(body, station, { pageNumber, total } = {}) {
  if (!(body?.success === true || body?.code === 200) || !Array.isArray(body?.data?.records)
    || !Number.isSafeInteger(body.data.total) || body.data.total < 0
    || total !== undefined && body.data.total !== total
    || body.data.current !== pageNumber || body.data.size !== 100) throw new CaptureError();
  if (body.data.records.some(record => record?.transitStationName !== station)) throw new StationMismatchError();
  const expected = Math.min(100, Math.max(0, body.data.total - (pageNumber - 1) * 100));
  if (body.data.records.length !== expected) throw new CaptureError();
  selectBatchRoutes(body, station);
}

export async function runStationsBatch({ args = process.argv.slice(2), env = process.env, log = console.log,
  errorLog = console.error, sessionExists = fs.access, session = withPortraitPage, capture = captureRouteDetailOnPage,
  closeModals = closeRouteDetailModals, readDetails = readRouteDetailsForBatch, readProfiles = readRouteProfiles,
  readState = readStationBatchState, writeBatch = writeStationBatchFile, saveDetail = saveRouteDetail,
  saveSnapshot = saveStationSnapshot, switchTo = switchStation, readStation = readCurrentStation,
  assertStation = assertCurrentStation, boundaryReader = readBoundaries, now = () => new Date(), signals = process, diagnosticFileOps = fs,
  districtsPath = defaultDistrictsPath, acquireLock = acquireScrapeLock, progressWriter = writeFileAtomic,
  dbSinkFactory = metadata => createDbBatchSink({ ...metadata, connect: () => connectDb('NC_DB_SCRAPER_URL', { env }) }) } = {}) {
  const controller = new AbortController(), started = now();
  const interrupt = () => controller.abort();
  const checkInterrupt = () => { if (controller.signal.aborted) throw new InterruptedError(); };
  let sink, jsonSink, options, config, runtimeDir, state, current, context, original = null, restored = false;
  let counts = { prodApiRequestCount: 0, listRequestCount: 0, detailRequestCount: 0 }, batchCap = 0;
  let exitCode = 0, stopReason = null, phase = 'config', currentRoute = null, snapshots = {}, details = {};
  let currentBaseline, routeWritten = false, boundaries = null, diagnosticDone = false;
  let loadedRoutes = [], completedRoutes = new Set();
  let releaseLock, plan = null, routeIndex = 0;
  const summaries = [], resumed = [];
  const progress = async (finished = false) => {
    if (!options?.progressFile || !releaseLock) return;
    const statuses = Object.entries(state?.stations || {});
    const value = { run_id: state?.run_id ?? null, scope: plan?.scope ?? null,
      started_at: started.toISOString(), updated_at: now().toISOString(), phase,
      station: current?.station ?? null, district: plan?.stations.find(s => s.code === current?.station)?.district ?? null,
      station_index: current ? options.stations.indexOf(current.station) + 1 : 0, station_total: options.stations.length,
      route_index: routeIndex, route_total: current?.route_total ?? null,
      completed: statuses.filter(([, s]) => s.status === 'completed').map(([code]) => code),
      skipped: plan?.skipped ?? [], failed: statuses.filter(([, s]) => s.status === 'stopped').map(([code]) => code),
      finished_at: finished ? now().toISOString() : null, status: finished ? (exitCode ? 'stopped' : 'completed') : 'running',
      stop_reason: stopReason };
    try { await progressWriter(options.progressFile, JSON.stringify(value)); }
    catch { errorLog('进度文件写入失败。'); }
  };
  signals.on('SIGINT', interrupt);
  const persistState = () => sink.writeState(state);
  const waitBetween = (type, ms) => context.guarded(() => {
    log(`等待：${type}；${ms} ms；开始 ${now().toISOString()}`);
    return context.page.waitForTimeout(ms);
  });
  const finishStation = async () => {
    if (!current || current.end_time) return;
    const end = now(), after = context?.counts() || counts;
    current.end_time = end.toISOString(); current.duration_ms = end - new Date(current.start_time);
    current.request_count = after.prodApiRequestCount - currentBaseline.prodApiRequestCount;
    current.list_request_count = after.listRequestCount - currentBaseline.listRequestCount;
    current.detail_request_count = after.detailRequestCount - currentBaseline.detailRequestCount;
    const filename = await sink.writeStationSummary({ state, station: current.station, record: current });
    state.stations[current.station] = { status: current.status, summary_file: filename,
      completed_at: current.status === 'completed' ? end.toISOString() : null };
    await persistState(); summaries.push(current);
    await progress();
    log(`Station ${current.station}: ${current.status}; routes ${current.route_total}; success ${current.success_count}; cached ${current.skipped_cached_count}; failed ${current.failed_count}; requests ${current.request_count}`);
  };
  const diagnose = async (page, error) => {
    if (!runtimeDir || diagnosticDone) return;
    diagnosticDone = true;
    const diagnosticError = error.name === 'DbStoreError' ? { name: error.name, message: error.message } : error;
    await writePageFailureDiagnostic({ runtimeDir, page, error: diagnosticError, currentRoute, phase, now,
      prefix: 'station-batch', fileOps: diagnosticFileOps, errorLog,
      fields: { station: current?.station ?? null, error_type: safeType(error),
        ...(error.click_retry !== undefined ? { click_retry: error.click_retry } : {}),
        ...(error.click_wait_reason !== undefined ? { click_wait_reason: error.click_wait_reason } : {}) } });
  };
  try {
    options = parseStationBatchArgs(args); config = parseStationBatchConfig(env);
    if (options.scope) {
      plan = planRefresh({ config: validateDistricts(JSON.parse(await fs.readFile(districtsPath, 'utf8'))), scope: options.scope });
      options.stations = plan.stations.map(station => station.code);
      if (!options.stations.length) { errorLog('本次范围没有可抓取的 Station。'); throw new Error(); }
    }
    const paths = { env, platform: process.platform, homedir: homedir(), repoRoot };
    const runtime = checkRuntimeDir(resolveRuntimeDir(paths), repoRoot); runtimeDir = runtime.path;
    jsonSink = sink = createJsonBatchSink({ runtimeDir, saveDetail, saveSnapshot, writeBatch });
    const auth = checkStatePath(resolveStatePath(paths), repoRoot);
    for (const warning of [...runtime.warnings, ...auth.warnings]) log(warning);
    const baseUrl = parseBaseUrl(env.DMS_BASE_URL).href;
    releaseLock = await acquireLock({ runtimeDir, trigger: options.trigger || 'cli', startedAt: started.toISOString() });
    await progress();
    phase = 'session';
    try { await sessionExists(auth.path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; throw Object.assign(new Error(), { name: 'NeedsLoginError' }); }
    phase = 'store';
    details = await readDetails({ runtimeDir });
    try { boundaries = await boundaryReader({ geoDir: path.join(repoRoot, 'geo') }); }
    catch { boundaries = null; }
    try { snapshots = (await readProfiles({ runtimeDir })).stations; }
    catch (error) { if (!(error instanceof SnapshotNotFoundError)) throw error; }
    state = prepareStationBatchState(await readState({ runtimeDir }), options.stations, { newRun: options.newRun, at: started.toISOString() });
    if (env.DB_DUAL_WRITE === '1') sink = createDualBatchSink(jsonSink, dbSinkFactory({ requestedStations: options.stations, trigger: options.trigger || 'cli',
      scope: plan ? { ...plan.scope, district: plan.scope.district ?? null, skipped: plan.skipped } : null,
      options: { refresh: options.refresh, max_routes_per_station: options.maxRoutesPerStation, new_run: options.newRun } }));
    await progress();
    await sink.startRun(state); checkInterrupt();
    log('请勿同时运行其他抓取命令。Station 与 Route 均串行处理。');
    phase = 'capture';
    await session({ statePath: auth.path, baseUrl, globalStationMode: true, batch: true, headless: options.headless,
      maxListRequests: config.maxListRequests, maxDetailRequests: config.maxDetailRequests, maxProdApiRequests: config.batchMax,
      listRequestPath: '/roadAreaPortrait/home/frontPage/', needsLoginOn401: true, signal: controller.signal, log,
      onCounts: value => { counts = value; }, onPageFailure: ({ page, error }) => diagnose(page, error) }, async shared => {
      context = shared;
      try {
        original = await readStation(context);
        const pending = options.stations.filter(station => state.stations[station].status !== 'completed');
        resumed.push(...options.stations.filter(station => state.stations[station].status === 'completed'));
        for (let index = 0; index < pending.length; index++) {
          const station = pending[index];
          currentRoute = null; routeIndex = 0;
          currentBaseline = context.counts();
          loadedRoutes = []; completedRoutes = new Set();
          current = { station, status: 'in_progress', route_total: null, success_count: 0, skipped_cached_count: 0, failed_count: 0,
            zero_routes: false, request_count: 0, list_request_count: 0, detail_request_count: 0, station_request_cap: config.stationBase,
            start_time: now().toISOString(), end_time: null, duration_ms: 0, locate_method: { L1: 0, L2: 0, L3: 0, L5: 0 },
            integrity: { passed: false, checks: {}, warnings: [] }, boundary_coverage: { with_polygon: 0, no_zcta: 0, not_checked: 0 },
            stop_reason: null, missing_routes: [] };
          state.stations[station].status = 'in_progress'; await persistState();
          context.beginStation(config.stationBase);
          phase = 'switch'; await progress(); await switchTo(context, station); await assertStation(context, station);
          current.automatic_list_seen = context.automaticListSeen === true;
          phase = 'list';
          const listContext = await context.queryStation();
          let body = listContext.body;
          validateStationList(body, station, { pageNumber: 1 }); await assertStation(context, station);
          const total = body.data.total, pages = Math.max(1, Math.ceil(total / 100));
          current.route_total = total; current.zero_routes = total === 0;
          current.station_request_cap = stationRequestCap(total, config);
          context.setStationCap(current.station_request_cap); batchCap = context.batchCap();
          const records = [], ids = new Set(), names = new Set(), processed = new Set(), fresh = new Set();
          let lastCapture = false;
          for (let pageNumber = 1; pageNumber <= pages; pageNumber++) {
            validateStationList(body, station, { pageNumber, total }); await assertStation(context, station);
            const rows = transformRoutePortrait({ ...body, data: { ...body.data, total: body.data.records.length } },
              { station, fetchedAt: now().toISOString() }).stationSnapshot.rows;
            for (const row of rows) {
              if (ids.has(row.route_id) || names.has(row.route_name)) throw new CaptureError();
              ids.add(row.route_id); names.add(row.route_name);
            }
            records.push(...body.data.records);
            loadedRoutes.push(...rows.map(row => row.route_id));
            listContext.body = body;
            listContext.forbidNameFilter = pageNumber > 1;
            const queryName = listContext.queryRouteName;
            listContext.queryRouteName = async (...params) => {
              if (pageNumber !== 1) throw new SelectorError('L5 不可用于第 2 页以后');
              const result = await queryName(...params);
              await assertStation(context, station);
              if (!params[1]) {
                validateStationList(result, station, { pageNumber: 1, total });
                if (JSON.stringify(result.data.records) !== JSON.stringify(body.data.records)) throw new CaptureError();
              } else if (!(result.success === true || result.code === 200)
                || result.data.records.some(row => row.transitStationName !== station)) throw new StationMismatchError();
              return result;
            };
            for (const row of rows) {
              currentRoute = row; routeIndex++; await progress();
              if (!options.refresh && completeRouteDetail(details[String(row.route_id)], row)) {
                processed.add(row.route_id); completedRoutes.add(row.route_id); current.skipped_cached_count++; continue;
              }
              if (options.maxRoutesPerStation !== null && current.success_count >= options.maxRoutesPerStation) {
                current.missing_routes.push(row.route_id); continue;
              }
              phase = 'delay';
              if (lastCapture) await waitBetween('route', config.routeDelay);
              listContext.beginRoute(); listContext.location = null;
              routeWritten = false;
              phase = 'capture';
              const result = await context.guarded(() => capture(listContext, { routeName: row.route_name, routeId: row.route_id }));
              if (result.locateMethod in current.locate_method) current.locate_method[result.locateMethod]++;
              phase = 'transform';
              const { route } = transformRouteDetail(result, { station, routeId: row.route_id, fetchedAt: now().toISOString() });
              if (!completeRouteDetail(route, row, { allowZipMismatch: true })) throw new IntegrityError();
              phase = 'store';
              await assertStation(context, station); checkInterrupt();
              await sink.writeRouteDetail({ route, beforeCommit: async () => {
                await assertStation(context, station); await context.guarded(async () => checkInterrupt());
              } });
              details[String(row.route_id)] = route; fresh.add(row.route_id); processed.add(row.route_id); current.success_count++;
              routeWritten = true; completedRoutes.add(row.route_id);
              lastCapture = true;
              if (result.restorationError) throw result.restorationError;
              phase = 'close_modals'; await context.guarded(() => closeModals(listContext));
              if (result.restoreList) await context.guarded(result.restoreList);
            }
            listContext.queryRouteName = queryName;
            if (pageNumber < pages) {
              phase = 'delay'; await waitBetween('route', config.routeDelay); lastCapture = false;
              phase = 'list'; body = await listContext.nextPage(pageNumber);
            }
          }
          phase = 'transform';
          const { stationSnapshot } = transformRoutePortrait({ success: true, data: { total, records } }, { station, fetchedAt: now().toISOString() });
          if (total === 0) {
            const visible = await context.guarded(() => context.page.locator('.vxe-table--main-wrapper .vxe-table--body-wrapper')
              .evaluateAll(elements => elements.filter(element => element.getClientRects().length > 0).length));
            if (visible !== 1) throw new CaptureError();
          }
          const limited = current.missing_routes.length > 0;
          phase = 'integrity';
          const integrity = checkStationIntegrity({ station, snapshot: stationSnapshot, details, successCount: current.success_count,
            skippedCount: current.skipped_cached_count, failedCount: current.failed_count, processedIds: processed,
            limited, freshlyFetchedIds: fresh, snapshots, boundaries });
          current.boundary_coverage = integrity.boundary_coverage;
          const { boundary_coverage, ...report } = integrity; current.integrity = report;
          if (!integrity.passed) throw new IntegrityError();
          phase = 'store'; await assertStation(context, station);
          await sink.activateStationSnapshot({ station, stationSnapshot, processedIds: processed, freshIds: fresh, beforeCommit: async () => {
            await assertStation(context, station); await context.guarded(async () => checkInterrupt());
          } }); snapshots[station] = stationSnapshot;
          current.status = limited ? 'limited' : 'completed'; await finishStation();
          if (index < pending.length - 1) {
            phase = 'station_delay'; await waitBetween('station', config.stationDelay);
          }
        }
      } catch (error) {
        if (current) {
          if (phase === 'switch') current.automatic_list_seen = context.automaticListSeen === true;
          if (current.end_time) { if (summaries.at(-1) === current) summaries.pop(); current.end_time = null; }
          current.status = 'stopped'; current.stop_reason = `${phase}:${safeType(error)}`;
          current.missing_routes = loadedRoutes.filter(id => !completedRoutes.has(id));
          current.unloaded_route_count = current.route_total === null ? null : Math.max(0, current.route_total - loadedRoutes.length);
          if (currentRoute && !routeWritten && ['capture', 'transform', 'store'].includes(phase)) current.failed_count++;
          try { await finishStation(); }
          catch { state.stations[current.station].status = 'stopped'; errorLog('Station 运行记录写入失败。'); }
        }
        await diagnose(context.page, error); throw error;
      } finally {
        try { if (original) { await switchTo(context, original); restored = await readStation(context) === original; } }
        catch { restored = false; errorLog('原 Station 恢复失败或浏览器已关闭。'); }
        counts = context.counts(); batchCap = context.batchCap();
      }
    });
    checkInterrupt();
  } catch (error) {
    exitCode = error.name === 'InterruptedError' || controller.signal.aborted ? 130 : 1;
    stopReason = `${phase}:${safeType(error)}`;
    errorLog(`批次停止：${stopReason}`);
    if (!context) await diagnose(null, error);
  } finally {
    try {
      if (runtimeDir && state) {
        if (!exitCode && Object.values(state.stations).every(item => item.status === 'completed')) state.finished_at = now().toISOString();
        const ended = now(), completed = options.stations.filter(code => state.stations[code].status === 'completed');
        const record = { station_total: options.stations.length, completed_count: completed.length, completed_stations: completed,
          limited_stations: options.stations.filter(code => state.stations[code].status === 'limited'), skipped_stations: resumed,
          unprocessed_stations: options.stations.filter(code => ['pending', 'in_progress', 'stopped'].includes(state.stations[code].status)),
          route_total: summaries.reduce((sum, item) => sum + (item.route_total || 0), 0)
            + resumed.reduce((sum, station) => sum + (snapshots[station]?.total || 0), 0),
          success_count: summaries.reduce((sum, item) => sum + item.success_count, 0),
          skipped_cached_count: summaries.reduce((sum, item) => sum + item.skipped_cached_count, 0), request_count: counts.prodApiRequestCount,
          batch_request_cap: batchCap, duration_ms: ended - started, start_time: started.toISOString(), end_time: ended.toISOString(),
          locate_method: Object.fromEntries(['L1', 'L2', 'L3', 'L5'].map(method => [method, summaries.reduce((sum, item) => sum + item.locate_method[method], 0)])),
          missing_stations: options.stations.filter(code => state.stations[code].status !== 'completed'),
          missing_routes: summaries.flatMap(item => item.missing_routes.map(route_id => ({ station: item.station, route_id }))),
          original_station: original, original_station_restored: restored, stop_reason: stopReason, status: exitCode ? 'stopped' : 'completed' };
        if (plan) record.skipped_by_config = plan.skipped;
        try { await sink.finishRun({ state, record }); }
        catch (error) {
          exitCode ||= 1;
          if (error.name === 'DbStoreError') {
            stopReason = `${phase}:DbStoreError`; record.status = 'stopped'; record.stop_reason = stopReason;
            try { await jsonSink.finishRun({ state, record }); } catch {}
          }
          errorLog('运行记录写入失败。');
        }
        log(`批次汇总：Station ${record.station_total}; completed ${record.completed_count}; routes ${record.route_total}; success ${record.success_count}; cached ${record.skipped_cached_count}; requests ${record.request_count}; restored ${restored}; stop ${stopReason || '无'}`);
      }
    } finally {
      await progress(true);
      if (releaseLock) { try { await releaseLock(); } catch { errorLog('锁文件释放失败。'); exitCode ||= 1; } }
      signals.off('SIGINT', interrupt);
    }
  }
  return exitCode;
}
function safeType(error) {
  return ['NeedsLoginError', 'CircuitBreakerError', 'LoadLimitError', 'InterruptedError', 'StationSwitchError', 'StationMismatchError',
    'CaptureError', 'SelectorError', 'SchemaError', 'StoreError', 'SnapshotInvalidError', 'RouteDetailInvalidError', 'IntegrityError', 'DbStoreError', 'LockedError'].includes(error?.name) ? error.name : 'Error';
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) process.exitCode = await runStationsBatch();
