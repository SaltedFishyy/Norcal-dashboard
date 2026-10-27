import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';

export async function migrate(client, { schema = 'nc', scraperRole = 'nc_scraper', readerRole = 'nc_reader', warehouseRole = 'nc_warehouse', districtRole = 'nc_district',
  onResult = () => {} } = {}) {
  const directory = new URL('../../db/migrations/', import.meta.url);
  const files = (await readdir(directory)).filter(file => /^\d{3}_[a-z0-9_]+\.sql$/.test(file)).sort();
  const identifiers = { schema, scraper_role: scraperRole, reader_role: readerRole, warehouse_role: warehouseRole, district_role: districtRole };
  const name = pg.escapeIdentifier(schema);
  let firstResult;
  for (const file of files) {
    const version = file.slice(0, 3);
    const template = await readFile(new URL(file, directory), 'utf8');
    const sql = template.replace(/\{\{(schema|scraper_role|reader_role|warehouse_role|district_role)\}\}/g,
      (_, key) => pg.escapeIdentifier(identifiers[key]));
    let result;
    await client.query('BEGIN');
    try {
      // Serialize each version even before the schema or version table exists.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['nc:migrate:' + schema]);
      await client.query('CREATE SCHEMA IF NOT EXISTS ' + name);
      await client.query('CREATE TABLE IF NOT EXISTS ' + name + '.schema_migrations '
        + '(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      const existing = await client.query('SELECT version FROM ' + name + '.schema_migrations WHERE version = $1', [version]);
      if (existing.rowCount) result = { version, result: 'skipped' };
      else {
        await client.query(sql);
        await client.query('INSERT INTO ' + name + '.schema_migrations (version) VALUES ($1)', [version]);
        result = { version, result: 'applied' };
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    firstResult ||= result;
    await onResult(result);
  }
  // Preserve the P2 return contract; callers needing all versions use onResult.
  return firstResult;
}
