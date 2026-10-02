import { sendJson } from './http-utils.js';
import { isStaticPath } from './static-files.js';

const errors = new Map([
  ['StationNotFoundError', [404, 'station_not_found']],
  ['SnapshotNotFoundError', [404, 'snapshot_not_found']],
  ['SnapshotInvalidError', [500, 'snapshot_invalid']],
]);

export function createRequestHandler({ getSnapshot, getRouteDetail, getStaticFile, log = () => {} }) {
  return (req, res) => {
    // Never log caller-controlled URLs or exception details; they may contain secrets.
    const respond = (status, body) => {
      sendJson(res, status, body);
      try { log(`HTTP ${status}`); } catch { /* Logging must not affect responses. */ }
    };
    void (async () => {
      let url;
      try { url = new URL(req.url, 'http://127.0.0.1'); }
      catch { respond(404, { error: 'not_found' }); return; }
      // Match static assets against the raw path, before URL dot-segment normalization.
      const rawPath = req.url.split('?')[0];
      if (isStaticPath(rawPath)) {
        res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'");
        if (req.method !== 'GET') {
          res.setHeader('Allow', 'GET');
          respond(405, { error: 'method_not_allowed' }); return;
        }
        try {
          const { body, contentType } = await getStaticFile(rawPath);
          res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
          });
          res.end(body);
          try { log('HTTP 200'); } catch { /* Logging must not affect responses. */ }
        } catch { respond(500, { error: 'internal_error' }); }
        return;
      }
      if (!['/api/health', '/api/route-profiles', '/api/route-details'].includes(url.pathname)) {
        respond(404, { error: 'not_found' }); return;
      }
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        respond(405, { error: 'method_not_allowed' }); return;
      }
      if (url.pathname === '/api/health') { respond(200, { ok: true }); return; }
      if (url.pathname === '/api/route-details') {
        const ids = url.searchParams.getAll('route_id');
        if (ids.length !== 1 || !/^\d+$/.test(ids[0]) || !Number.isSafeInteger(Number(ids[0])) || Number(ids[0]) < 1) {
          respond(400, { error: 'invalid_route_id' }); return;
        }
        try { respond(200, await getRouteDetail(Number(ids[0]))); }
        catch (error) {
          const mappings = { RouteDetailNotFoundError: [404, 'route_detail_not_found'], RouteDetailInvalidError: [500, 'route_detail_invalid'] };
          const [status, code] = Object.hasOwn(mappings, error?.name) ? mappings[error.name] : [500, 'internal_error'];
          respond(status, { error: code });
        }
        return;
      }
      const stations = url.searchParams.getAll('station');
      if (stations.length !== 1 || !/^[A-Za-z0-9._-]{1,32}$/.test(stations[0])) {
        respond(400, { error: 'invalid_station' }); return;
      }
      const station = stations[0];
      try {
        const { fetched_at, source_as_of, total, rows } = await getSnapshot(station);
        respond(200, { station, fetched_at, source_as_of, total, rows });
      } catch (error) {
        const [status, code] = errors.get(error?.name) || [500, 'internal_error'];
        respond(status, { error: code });
      }
    })();
  };
}
