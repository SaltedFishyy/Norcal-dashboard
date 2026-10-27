import { readDistrictConfig } from '../store/districts-file.js';
import { SnapshotNotFoundError } from '../store/route-profiles-file.js';

export const needsLogin = reason => typeof reason === 'string' && reason.endsWith(':NeedsLoginError');
export const safeStopReason = reason => typeof reason === 'string' && /^[a-z_]+:[A-Za-z][A-Za-z0-9]*$/.test(reason) ? reason : null;
// Explicit projections keep view metadata and nested scope fields out of public responses.
export function projectRun(run) {
  if (!run) return null;
  const scope = run.scope ? { type: run.scope.type,
    ...(run.scope.type === 'district' ? { district: run.scope.district } : {}),
    skipped: (run.scope.skipped ?? []).map(({ code, district, reason }) => ({ code, district, reason })) } : null;
  return { id: run.id, trigger: run.trigger, status: run.status, started_at: run.started_at,
    finished_at: run.finished_at, scope,
    counts: Object.fromEntries(['completed', 'limited', 'stopped', 'skipped', 'pending'].map(key => [key, run.counts?.[key] ?? 0])),
    stop_reason: safeStopReason(run.stop_reason), prod_api_requests: run.prod_api_requests };
}
function times(stations) {
  const values = stations.map(s => s.fetched_at).filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b));
  return { newest_fetched_at: values.at(-1) ?? null, oldest_fetched_at: values[0] ?? null };
}
export function createFreshnessHandlers({ dataSource, districtsPath }) {
  return new Map([
    ['/api/runs', async ({ url, respond }) => {
      const values = url.searchParams.getAll('limit');
      const value = values[0] ?? '20';
      if (values.length > 1 || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 50) {
        respond(400, { error: 'invalid_limit' }); return;
      }
      respond(200, { runs: (await dataSource.readRuns({ limit: Number(value) })).map(projectRun), source: dataSource.source });
    }],
    ['/api/freshness', async ({ respond }) => {
      const config = await readDistrictConfig({ districtsPath });
      let profiles;
      try { profiles = await dataSource.readRouteProfiles(); }
      catch (error) { if (!(error instanceof SnapshotNotFoundError)) throw error; profiles = { stations: {} }; }
      const stations = config.districts.flatMap(d => d.stations.map(code => ({ code, district: d.id,
        fetched_at: profiles.stations[code]?.fetched_at ?? null, scrape_disabled: d.scrape_disabled?.[code] ?? null })));
      const configured = new Set(stations.map(s => s.code));
      for (const code of Object.keys(profiles.stations).filter(code => !configured.has(code)).sort())
        stations.push({ code, district: 'unassigned', fetched_at: profiles.stations[code].fetched_at, scrape_disabled: null });
      const ids = config.districts.map(d => d.id);
      if (stations.some(s => s.district === 'unassigned')) ids.push('unassigned');
      const districts = ids.map(id => {
        const group = stations.filter(s => s.district === id);
        return { id, ...times(group), stations_with_data: group.filter(s => s.fetched_at !== null).length, station_count: group.length };
      });
      const last = dataSource.source === 'db' ? await dataSource.readLastScrapeRun() : null;
      const run = dataSource.source === 'db' ? { running: last?.status === 'running', last: last ? {
        status: last.status, trigger: last.trigger, started_at: last.started_at, finished_at: last.finished_at,
        stop_reason: safeStopReason(last.stop_reason), needs_login: needsLogin(safeStopReason(last.stop_reason)) } : null } : null;
      respond(200, { source: dataSource.source, notice: '数据来自 DMS 抓取，非实时', global: times(stations), districts, stations, run });
    }],
  ]);
}
