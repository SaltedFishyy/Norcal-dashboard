import { RouteDetailNotFoundError, projectRouteDetail } from '../store/route-details-file.js';

// Each operation runs in the data source's repeatable-read transaction.
export function dailyReaders(read, day) {
  const snapshots = async client => (await client.query(`SELECT station AS station_code,
    fetched_at, source_as_of, source, total FROM v_daily_snapshots WHERE day=$1`, [day])).rows;
  const routes = async client => (await client.query(`SELECT station, profile
    FROM v_daily_snapshot_routes WHERE day=$1 ORDER BY station, ordinal`, [day])).rows;
  const details = async (client, routeId) => {
    const args = routeId === undefined ? [day] : [day, routeId];
    const selected = `SELECT route_id, detail_version_id FROM v_daily_snapshot_routes
      WHERE day=$1${routeId === undefined ? '' : ' AND route_id=$2'}`;
    const versions = (await client.query(`SELECT d.route_id, d.detail FROM v_route_detail_versions d
      JOIN (${selected}) r ON r.detail_version_id=d.id`, args)).rows;
    const zips = (await client.query(`SELECT z.route_id, z.zip FROM v_route_detail_version_zips z
      JOIN (${selected}) r ON r.detail_version_id=z.detail_version_id ORDER BY z.route_id, z.ordinal`, args)).rows;
    const byRoute = new Map();
    for (const row of zips) {
      if (!byRoute.has(row.route_id)) byRoute.set(row.route_id, []);
      byRoute.get(row.route_id).push(row.zip);
    }
    return Object.fromEntries(versions.map(row => [String(row.route_id), {
      ...row.detail, zips: byRoute.get(row.route_id) ?? [],
    }]));
  };
  return {
    readRouteProfiles: () => read(async client => {
      const metadata = await snapshots(client), rows = await routes(client);
      return { schema_version: 1, stations: Object.fromEntries(metadata.map(({ station_code, ...snapshot }) =>
        [station_code, { ...snapshot, rows: rows.filter(row => row.station === station_code).map(row => row.profile) }])) };
    }),
    getStationSnapshot: station => read(async client => {
      const found = (await snapshots(client)).find(row => row.station_code === station);
      if (!found) return { fetched_at: null, source_as_of: null, total: 0, rows: [], empty: true };
      const { station_code, ...snapshot } = found;
      const rows = (await client.query(`SELECT profile FROM v_daily_snapshot_routes
        WHERE day=$1 AND station=$2 ORDER BY station, ordinal`, [day, station])).rows;
      return { ...snapshot, rows: rows.map(row => row.profile) };
    }),
    getRouteDetail: routeId => read(async client => {
      const found = (await details(client, routeId))[String(routeId)];
      if (!found) throw new RouteDetailNotFoundError();
      return projectRouteDetail(found);
    }),
    readRouteDetailsForMap: () => read(async client => {
      const routes = await details(client);
      return { status: Object.keys(routes).length ? 'ok' : 'none', routes };
    }),
  };
}

export async function readSnapshotDays(client, { stations }) {
  return (await client.query(`SELECT day::text AS day, array_agg(station ORDER BY station) AS stations
    FROM v_daily_snapshots WHERE station=ANY($1::text[]) GROUP BY day ORDER BY day`, [stations])).rows;
}
