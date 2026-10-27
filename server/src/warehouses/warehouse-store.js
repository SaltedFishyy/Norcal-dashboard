import pg from 'pg';
import { dbConfig } from '../db/connection.js';
import { DataSourceUnavailableError } from '../store/data-source.js';
import { checkWarehousePrivileges } from './warehouse-privileges.js';

const columns = ['warehouse_name', 'address', 'address_key', 'district_id', 'station_id', 'latitude', 'longitude'];
export function createWarehouseStore({ connectionString, env = process.env, schema = 'nc' } = {}) {
  const { schema: ignored, ...config } = dbConfig('NC_DB_WAREHOUSE_URL', {
    env: connectionString ? { NC_DB_WAREHOUSE_URL: connectionString } : env, schema });
  const pool = new pg.Pool(config), initialized = new WeakSet();
  pool.on('error', () => {});
  const run = async action => {
    let client;
    try {
      client = await pool.connect();
      if (!initialized.has(client)) {
        await client.query(`SET search_path TO ${pg.escapeIdentifier(schema)}`);
        initialized.add(client);
      }
      return await action(client);
    } catch { throw new DataSourceUnavailableError(); }
    finally { client?.release(); }
  };
  const find = (column, value, excludeId) => run(async client => (await client.query(
    `SELECT * FROM warehouses WHERE ${column}=$1 AND ($2::uuid IS NULL OR id<>$2) ORDER BY warehouse_name`, [value, excludeId ?? null])).rows);
  return {
    list: ({ districtId } = {}) => run(async c => (await c.query('SELECT * FROM warehouses WHERE ($1::text IS NULL OR district_id=$1) ORDER BY warehouse_name', [districtId ?? null])).rows),
    get: id => run(async c => (await c.query('SELECT * FROM warehouses WHERE id=$1', [id])).rows[0] ?? null),
    findByAddressKey: (key, { excludeId } = {}) => find('address_key', key, excludeId),
    findByName: (name, { excludeId } = {}) => run(async client => (await client.query(
      'SELECT * FROM warehouses WHERE lower(btrim(warehouse_name))=lower(btrim($1::text)) AND ($2::uuid IS NULL OR id<>$2) ORDER BY warehouse_name',
      [name, excludeId ?? null])).rows),
    insert: values => run(async c => (await c.query(`INSERT INTO warehouses (${columns.join(',')}, updated_at)
      VALUES (${columns.map((_, i) => `$${i + 1}`).join(',')}, date_trunc('milliseconds',now())) RETURNING *`, columns.map(k => values[k]))).rows[0]),
    update: (id, values, expectedUpdatedAt) => run(async c => {
      // Compare at the precision exposed by pg's Date parser, including pre-existing microsecond rows.
      const result = await c.query(`UPDATE warehouses SET ${columns.map((key, i) => `${key}=$${i + 2}`).join(',')},
        updated_at=date_trunc('milliseconds',now()) WHERE id=$1
        AND date_trunc('milliseconds',updated_at)=date_trunc('milliseconds',$9::timestamptz) RETURNING *`,
      [id, ...columns.map(k => values[k]), expectedUpdatedAt]);
      if (result.rowCount) return { row: result.rows[0] };
      const existing = await c.query('SELECT id FROM warehouses WHERE id=$1', [id]);
      return { error: existing.rowCount ? 'warehouse_changed' : 'warehouse_not_found' };
    }),
    remove: id => run(async c => (await c.query('DELETE FROM warehouses WHERE id=$1', [id])).rowCount > 0),
    checkPrivileges: () => run(c => checkWarehousePrivileges(c, { schema })),
    close: () => pool.end(),
  };
}
