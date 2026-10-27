import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readRouteProfiles } from '../store/route-profiles-file.js';
import { readRouteDetailsForBatch } from '../store/route-details-file.js';
import { validateProfiles } from '../route-map/route-map.js';

export class JsonImportError extends Error {
  constructor(message = 'JSON 导入失败，未写入任何数据。') { super(message); this.name = 'JsonImportError'; }
}

export async function importJson({ runtimeDir, client }) {
  // Read each file once: validation and digest refer to exactly the imported bytes.
  let profiles, routes, digest;
  try {
    const names = ['route-profiles.json', 'route-details.json'];
    const bytes = await Promise.all(names.map(name => readFile(path.join(runtimeDir, name))));
    const fileOps = { readFile: async filename => bytes[names.indexOf(path.basename(filename))].toString('utf8') };
    profiles = await readRouteProfiles({ runtimeDir, fileOps });
    routes = await readRouteDetailsForBatch({ runtimeDir, fileOps });
    validateProfiles(profiles, null, { allowMissingPostalCodes: true });
    digest = createHash('sha256').update(bytes[0]).update(bytes[1]).digest('hex');
  } catch { throw new JsonImportError('JSON 文件不存在或不合法，未写入任何数据。'); }
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try {
    // Serialize import commands without requesting privileges beyond the scraper role.
    await client.query("SELECT pg_advisory_xact_lock(hashtext(current_schema()), hashtext('json_import'))");
    if ((await client.query('SELECT id FROM scrape_runs WHERE import_digest=$1', [digest])).rowCount)
      throw new JsonImportError('已导入过，拒绝重复导入。');
    const existing = await client.query('SELECT EXISTS(SELECT 1 FROM station_snapshots) OR EXISTS(SELECT 1 FROM route_detail_versions) AS present');
    if (existing.rows[0].present) throw new JsonImportError('数据库已有 snapshot 或 detail 版本，拒绝导入。');
    const id = randomUUID(), at = new Date().toISOString();
    await client.query(`INSERT INTO scrape_runs
      (id,trigger,status,requested_stations,options,started_at,finished_at,import_digest)
      VALUES ($1,'json_import','completed',$2,'{}',$3,$3,$4)`, [id, Object.keys(profiles.stations), at, digest]);
    const versions = new Map();
    for (const route of Object.values(routes)) {
      const { zips, ...detail } = route;
      const result = await client.query(`INSERT INTO route_detail_versions
        (route_id,station_code,run_id,origin,status,fetched_at,detail,committed_at)
        VALUES ($1,$2,$3,'json_import','committed',$4,$5,$6) RETURNING id`,
      [route.route_id, route.station, id, route.fetched_at, detail, at]);
      const version = result.rows[0].id;
      versions.set(String(route.route_id), { id: version, station: route.station });
      for (const [ordinal, zip] of zips.entries()) await client.query(`INSERT INTO route_detail_zips
        (detail_version_id,ordinal,postal_code,zip) VALUES ($1,$2,$3,$4)`, [version, ordinal, zip.postal_code, zip]);
    }
    let routeCount = 0;
    for (const [station, snapshot] of Object.entries(profiles.stations)) {
      await client.query('INSERT INTO stations(code) VALUES ($1) ON CONFLICT DO NOTHING', [station]);
      const result = await client.query(`INSERT INTO station_snapshots
        (station_code,run_id,status,origin,fetched_at,source_as_of,source,total,activated_at)
        VALUES ($1,$2,'active','json_import',$3,$4,$5,$6,$7) RETURNING id`,
      [station, id, snapshot.fetched_at, snapshot.source_as_of, snapshot.source, snapshot.total, at]);
      const snapshotId = result.rows[0].id;
      for (const [ordinal, row] of snapshot.rows.entries()) {
        const version = versions.get(String(row.route_id));
        await client.query(`INSERT INTO snapshot_routes
          (snapshot_id,route_id,ordinal,route_name,profile,detail_version_id) VALUES ($1,$2,$3,$4,$5,$6)`,
        [snapshotId, row.route_id, ordinal, row.route_name, row, version?.station === station ? version.id : null]);
        for (const [zipOrdinal, zip] of (row.postal_codes ?? []).entries()) await client.query(`INSERT INTO snapshot_route_zips
          (snapshot_id,route_id,postal_code,ordinal) VALUES ($1,$2,$3,$4)`, [snapshotId, row.route_id, zip, zipOrdinal]);
        routeCount++;
      }
      await client.query('UPDATE stations SET active_snapshot_id=$1 WHERE code=$2', [snapshotId, station]);
    }
    await client.query('COMMIT');
    return { stations: Object.keys(profiles.stations).length, routes: routeCount, details: versions.size };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error instanceof JsonImportError ? error : new JsonImportError();
  }
}
