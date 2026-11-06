import pg from 'pg';
import { dbConfig } from './connection.js';
import { SnapshotNotFoundError, StationNotFoundError } from '../store/route-profiles-file.js';
import { RouteDetailNotFoundError, projectRouteDetail } from '../store/route-details-file.js';
import { DataSourceUnavailableError } from '../store/data-source.js';
import { checkReaderWarehouseIsolation } from '../warehouses/warehouse-privileges.js';
import { readActiveRouteProfiles } from './active-route-profiles.js';

export function createDbDataSource({ env = process.env, schema = 'nc' } = {}) {
  const { schema: ignored, ...config } = dbConfig('NC_DB_READER_URL', { env, schema });
  const pool = new pg.Pool(config);
  pool.on('error', () => {}); // Idle connection errors must never expose driver details.
  const initialized = new WeakSet();
  const read = async action => {
    let client;
    try {
      client = await pool.connect();
      if (!initialized.has(client)) {
        await client.query(`SET search_path TO ${pg.escapeIdentifier(schema)}`);
        initialized.add(client);
      }
      // Multiple view queries must see one consistent snapshot during activation.
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      if (error instanceof SnapshotNotFoundError || error instanceof StationNotFoundError
        || error instanceof RouteDetailNotFoundError) throw error;
      throw new DataSourceUnavailableError();
    } finally { client?.release(); }
  };
  const profiles = client => client.query('SELECT * FROM v_active_snapshots');
  const routeDetails = async (client, routeId) => {
    const filter = routeId === undefined ? '' : ' WHERE route_id=$1';
    const args = routeId === undefined ? [] : [routeId];
    const versions = await client.query(`SELECT route_id,detail FROM v_route_details${filter}`, args);
    const zips = await client.query(`SELECT route_id,zip FROM v_route_detail_zips${filter} ORDER BY route_id,ordinal`, args);
    return Object.fromEntries(versions.rows.map(row => [String(row.route_id), { ...row.detail,
      zips: zips.rows.filter(zip => zip.route_id === row.route_id).map(zip => zip.zip) }]));
  };
  return {
    source: 'db',
    readCurrentFirstPrices: () => read(async client => (await client.query(
      'SELECT route_id,postal_code,price FROM v_route_quotation_first_0_1lb')).rows.map(row => ({
      route_id: Number(row.route_id), postal_code: row.postal_code, price: row.price == null ? null : Number(row.price) }))),
    readRouteQuotation: routeId => read(async client => {
      // Cast dates in SQL to avoid pg's local-time Date parser and UTC date shifts.
      const current = (await client.query(`SELECT *, effective_from::text AS effective_from,
        end_date::text AS end_date, quotation_date::text AS quotation_date
        FROM v_route_quotation_current WHERE route_id=$1`, [routeId])).rows.map(row => ({ ...row,
        route_id: Number(row.route_id), line_id: Number(row.line_id),
        imported_at: row.imported_at == null ? null : new Date(row.imported_at).toISOString(),
        first_prices: Object.fromEntries(Object.entries(row.first_prices).map(([k, v]) => [k, Number(v)])),
        additional_prices: Object.fromEntries(Object.entries(row.additional_prices).map(([k, v]) => [k, Number(v)])) }));
      const upcoming = (await client.query(`SELECT *, effective_from::text AS effective_from
        FROM v_route_quotation_upcoming WHERE route_id=$1`, [routeId])).rows
        .map(row => ({ ...row, route_id: Number(row.route_id) }));
      const weightBands = (await client.query('SELECT * FROM v_quotation_weight_bands ORDER BY ordinal')).rows;
      return { current, upcoming, weightBands };
    }),
    checkReaderWarehouseIsolation: () => read(client => checkReaderWarehouseIsolation(client)),
    readWarehouses: ({ districtId } = {}) => read(async client => (await client.query(
      'SELECT * FROM v_warehouses WHERE ($1::text IS NULL OR district_id=$1) ORDER BY warehouse_name', [districtId ?? null])).rows),
    readRuns: ({ limit }) => read(async client =>
      (await client.query('SELECT * FROM v_runs ORDER BY started_at DESC,id DESC LIMIT $1', [limit])).rows),
    readLastScrapeRun: () => read(async client =>
      (await client.query("SELECT * FROM v_runs WHERE trigger IN ('cli','ui') ORDER BY started_at DESC,id DESC LIMIT 1")).rows[0] ?? null),
    canWriteRuns: () => read(async client =>
      (await client.query("SELECT has_table_privilege('scrape_runs','INSERT') AS can_write")).rows[0].can_write),
    readRouteProfiles: () => read(async client => {
      const snapshots = await profiles(client);
      if (!snapshots.rowCount) throw new SnapshotNotFoundError();
      const routes = await readActiveRouteProfiles(client);
      return { schema_version: 1, stations: Object.fromEntries(snapshots.rows.map(({ station_code, ...snapshot }) =>
        [station_code, { ...snapshot, rows: routes.filter(row => row.station_code === station_code).map(row => row.profile) }])) };
    }),
    getStationSnapshot: station => read(async client => {
      const snapshots = await profiles(client);
      if (!snapshots.rowCount) throw new SnapshotNotFoundError();
      const found = snapshots.rows.find(row => row.station_code === station);
      if (!found) throw new StationNotFoundError();
      const { station_code, ...snapshot } = found;
      const routes = await readActiveRouteProfiles(client, station);
      return { ...snapshot, rows: routes.map(row => row.profile) };
    }),
    getRouteDetail: routeId => read(async client => {
      const routes = await routeDetails(client, routeId);
      if (!Object.hasOwn(routes, String(routeId))) throw new RouteDetailNotFoundError();
      return projectRouteDetail(routes[String(routeId)]);
    }),
    readRouteDetailsForMap: () => read(async client => {
      const routes = await routeDetails(client);
      return { status: Object.keys(routes).length ? 'ok' : 'none', routes };
    }),
    close: () => pool.end(),
  };
}
