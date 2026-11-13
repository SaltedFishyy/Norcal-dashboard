import { pacificToday, requestDay } from './date-view.js';
import { sendJson, sendJsonCompressed, sendBody } from './http-utils.js';
import { isStaticPath } from './static-files.js';
import { basemapPaths, createBasemapHandler } from './basemap.js';

const profileErrors = new Map([
  ['DataSourceUnavailableError', [503, 'data_source_unavailable']],
  ['StationNotFoundError', [404, 'station_not_found']],
  ['SnapshotNotFoundError', [404, 'snapshot_not_found']],
  ['SnapshotInvalidError', [500, 'snapshot_invalid']],
]);
const detailErrors = new Map([
  ['DataSourceUnavailableError', [503, 'data_source_unavailable']],
  ['RouteDetailNotFoundError', [404, 'route_detail_not_found']],
  ['RouteDetailInvalidError', [500, 'route_detail_invalid']],
]);
const mapErrors = new Map([
  ...profileErrors,
  ['PostalCodesMissingError', [409, 'postal_codes_missing']],
  ['RouteZipConflictError', [500, 'route_zip_conflict']],
  ['BoundaryInvalidError', [500, 'boundary_invalid']],
  ['BoundaryNotFoundError', [500, 'boundary_not_found']],
  ['DistrictConfigInvalidError', [500, 'district_config_invalid']],
  ['DistrictNotFoundError', [404, 'district_not_found']],
]);
const csp = "default-src 'self'; frame-ancestors 'none'";
const basemapErrors = new Map([['BasemapNotFoundError', [404, 'basemap_not_found']],
  ['DataSourceUnavailableError', [503, 'data_source_unavailable']],
  ['BasemapInvalidError', [500, 'basemap_invalid']]]);
const errorMappings = new Map([
  ['/api/route-quotations', new Map([...profileErrors, ['RouteNotFoundError', [404, 'route_not_found']]])],
  ['/api/route-profiles', profileErrors], ['/api/route-details', detailErrors],
  ['/api/route-map', mapErrors], ['/api/route-map/zip', mapErrors], ['/api/route-map/stations', mapErrors],
  ['/api/snapshot-days', mapErrors], ['/api/districts', mapErrors], ['/api/route-map/district', mapErrors],
  ...[...basemapPaths.keys()].map(pathname => [pathname, basemapErrors]),
]);

export function createRequestHandler({ getSnapshotDays, today = () => pacificToday(() => new Date()), getSnapshot, getRouteDetail, getRouteQuotation, getRouteHistory, getRouteMap, getDistrictMap, getDistricts, getZip, getMapStations, getStaticFile, getBasemap,
  compressResponses = true, capabilities = { refresh: false }, extraHandlers = new Map(), readHandlers = new Map(), log = () => {} }) {
  // Never log caller-controlled URLs or exception details; they may contain secrets.
  const record = status => { try { log(`HTTP ${status}`); } catch { /* Logging must not affect responses. */ } };
  const stationEndpoint = read => async ({ url, respond, day }) => {
    const stations = url.searchParams.getAll('station');
    if (stations.length !== 1 || !/^[A-Za-z0-9._-]{1,32}$/.test(stations[0])) {
      respond(400, { error: 'invalid_station' }); return;
    }
    respond(200, await read(stations[0], day));
  };
  const profiles = stationEndpoint(async (station, day) => {
    const { fetched_at, source_as_of, total, rows, empty } = await getSnapshot(station, day);
    return { station, fetched_at, source_as_of, total, rows: rows.map(({ raw, ...row }) => row),
      ...(day !== undefined && empty === true ? { empty: true } : {}) };
  });
  const routeMap = stationEndpoint((station, day) => getRouteMap(station, day));
  const zipLookup = async ({ url, respond, day }) => {
    const codes = url.searchParams.getAll('postal_code');
    if (codes.length !== 1 || !/^\d{5}$/.test(codes[0])) {
      respond(400, { error: 'invalid_postal_code' }); return;
    }
    respond(200, await getZip(codes[0], day));
  };
  const mapStations = async ({ respond, day }) => respond(200, { stations: await getMapStations(day) });
  const districts = async ({ respond, day }) => respond(200, { districts: await getDistricts(day) });
  const districtMap = async ({ url, respond, day }) => {
    const ids = url.searchParams.getAll('district');
    if (ids.length !== 1 || !/^[a-z0-9-]{1,32}$/.test(ids[0])) {
      respond(400, { error: 'invalid_district' }); return;
    }
    respond(200, await getDistrictMap(ids[0], day));
  };
  const snapshotDays = async ({ url, respond }) => {
    const stations = url.searchParams.getAll('station'), districts = url.searchParams.getAll('district');
    if (stations.length) {
      if (stations.length !== 1 || districts.length || !/^[A-Za-z0-9._-]{1,32}$/.test(stations[0])) {
        respond(400, { error: 'invalid_station' }); return;
      }
    } else if (districts.length !== 1 || !/^[a-z0-9-]{1,32}$/.test(districts[0])) {
      respond(400, { error: 'invalid_district' }); return;
    }
    respond(200, await getSnapshotDays(stations.length ? { station: stations[0] } : { district: districts[0] }));
  };
  const health = ({ respond }) => respond(200, { ok: true });
  const routeEndpoint = read => async ({ url, respond, day }) => {
    const ids = url.searchParams.getAll('route_id');
    if (ids.length !== 1 || !/^\d+$/.test(ids[0]) || !Number.isSafeInteger(Number(ids[0])) || Number(ids[0]) < 1) {
      respond(400, { error: 'invalid_route_id' }); return;
    }
    respond(200, await read(Number(ids[0]), day));
  };
  const routeHistory = async context => {
    const { url, respond } = context;
    const values = url.searchParams.getAll('days');
    if (values.length > 1 || (values.length === 1 && !['7', '30'].includes(values[0]))) {
      respond(400, { error: 'invalid_days' }); return;
    }
    return routeEndpoint(routeId => getRouteHistory(routeId, Number(values[0] ?? 7)))(context);
  };
  const staticFile = async ({ rawPath, req, res }) => {
    const { body, contentType } = await getStaticFile(rawPath);
    const headers = { 'Content-Type': contentType, 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': csp };
    if (compressResponses) await sendBody(req, res, 200, body, headers);
    else { res.writeHead(200, headers); res.end(body); }
    record(200);
  };
  const handlers = new Map([
    ['/api/snapshot-days', snapshotDays], ['/api/health', health], ['/api/route-profiles', profiles], ['/api/route-details', routeEndpoint(getRouteDetail)],
    ['/api/route-quotations', routeEndpoint(getRouteQuotation)],
    ['/api/route-history', routeHistory],
    ['/api/route-map', routeMap], ['/api/route-map/zip', zipLookup], ['/api/route-map/stations', mapStations],
    ['/api/districts', districts], ['/api/route-map/district', districtMap],
  ]);
  for (const pathname of ['/api/route-profiles', '/api/route-details', '/api/route-map',
    '/api/route-map/zip', '/api/route-map/stations', '/api/districts', '/api/route-map/district']) {
    const handler = handlers.get(pathname);
    handlers.set(pathname, context => handler({ ...context,
      day: context.url.searchParams.has('date') ? requestDay(context.url, today()) : undefined }));
  }
  for (const pathname of basemapPaths.keys()) {
    handlers.set(pathname, createBasemapHandler(getBasemap, csp, record));
  }
  handlers.set('/api/capabilities', ({ respond }) => respond(200, capabilities));
  for (const [pathname, handler] of readHandlers) handlers.set(pathname, handler);
  for (const [pathname, handler] of extraHandlers) {
    if (handlers.has(pathname)) throw new Error('Extension cannot replace a read-only route');
    handlers.set(pathname, handler);
  }
  return (req, res) => {
    // Existing route handlers may call respond without returning its promise.
    let pendingResponse;
    const respond = (status, body) => {
      pendingResponse = (async () => {
        if (compressResponses) await sendJsonCompressed(req, res, status, body);
        else sendJson(res, status, body);
        record(status);
      })();
      return pendingResponse;
    };
    void (async () => {
      let url;
      try { url = new URL(req.url, 'http://127.0.0.1'); }
      catch { respond(404, { error: 'not_found' }); return; }
      // Match static assets before URL dot-segment normalization.
      const rawPath = req.url.split('?')[0];
      const isStatic = isStaticPath(rawPath);
      const handler = isStatic ? staticFile : basemapPaths.has(rawPath) ? handlers.get(rawPath)
        : basemapPaths.has(url.pathname) ? undefined : handlers.get(url.pathname);
      if (!handler) { respond(404, { error: 'not_found' }); return; }
      if (isStatic || basemapPaths.has(rawPath)) res.setHeader('Content-Security-Policy', csp);
      const methods = extraHandlers.get(url.pathname) === handler ? handler.methods ?? ['GET'] : ['GET'];
      if (!methods.includes(req.method)) {
        res.setHeader('Allow', methods.join(', ')); respond(405, { error: 'method_not_allowed' }); return;
      }
      try { await handler({ url, rawPath, req, res, respond }); await pendingResponse; }
      catch (error) {
        if (res.headersSent) { res.destroy(); return; }
        const [status, code] = isStatic ? [500, 'internal_error']
          : (error?.name === 'InvalidDateError' ? [400, 'invalid_date']
            : error?.name === 'HistoryUnavailableError' ? [400, 'history_unavailable']
              : errorMappings.get(url.pathname)?.get(error?.name))
            || (error?.name === 'DataSourceUnavailableError' ? [503, 'data_source_unavailable']
              : error?.name === 'DistrictConfigInvalidError' ? [500, 'district_config_invalid'] : [500, 'internal_error']);
        respond(status, { error: code });
      }
    })();
  };
}
