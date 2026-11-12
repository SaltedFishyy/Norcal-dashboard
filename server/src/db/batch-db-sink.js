import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { completeRouteDetail } from '../batch/station-integrity.js';

export class DbIntegrityError extends Error {
  constructor() { super('数据库 Detail 或运行状态不一致。'); this.name = 'DbIntegrityError'; }
}

export function createDbBatchSink({ connect, requestedStations, options = {}, trigger = 'cli', scope = null }) {
  const id = randomUUID();
  let client, started = false;
  const transaction = async action => {
    await client.query('BEGIN');
    try { const result = await action(); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  };
  const writeState = async state => {
    for (const [station, value] of Object.entries(state.stations)) {
      // Pending stations have not passed menu validation; runtime skips have no DB row.
      if (value.status === 'pending' || state.skipped?.some(entry => entry.code === station)) continue;
      await client.query(`INSERT INTO scrape_run_stations
        (run_id, station_code, status, success_count, cached_count, failed_count) VALUES ($1,$2,$3,0,0,0)
        ON CONFLICT (run_id,station_code) DO UPDATE SET status=EXCLUDED.status`, [id, station, value.status]);
    }
  };
  return {
    async startRun(state) {
      client = await connect();
      let version = null;
      try { version = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: new URL('../../../', import.meta.url), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}
      try {
        await client.query(`INSERT INTO scrape_runs
          (id,trigger,json_run_id,app_version,status,requested_stations,options,started_at,scope)
          VALUES ($1,$7,$2,$3,'running',$4,$5,$6,$8)`,
        [id, state.run_id, version, requestedStations, options, state.started_at || new Date().toISOString(), trigger, scope]);
        started = true;
      } catch (error) {
        if (error.code === '23505' && error.constraint === 'one_running_run') {
          const existing = await client.query("SELECT id, started_at FROM scrape_runs WHERE status='running'");
          const run = existing.rows[0];
          throw new Error(`已有 running run：${run?.id}；${run?.started_at?.toISOString()}。确认无抓取运行后使用 db:abandon-run。`);
        }
        throw error;
      }
    },
    writeState,
    async writeStationSummary({ station, record }) {
      await client.query(`INSERT INTO scrape_run_stations
        (run_id,station_code,status,route_total,success_count,cached_count,failed_count,request_count,started_at,ended_at,stop_reason,integrity)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (run_id,station_code) DO UPDATE SET
        status=EXCLUDED.status,route_total=EXCLUDED.route_total,success_count=EXCLUDED.success_count,
        cached_count=EXCLUDED.cached_count,failed_count=EXCLUDED.failed_count,request_count=EXCLUDED.request_count,
        started_at=EXCLUDED.started_at,ended_at=EXCLUDED.ended_at,stop_reason=EXCLUDED.stop_reason,integrity=EXCLUDED.integrity`,
      [id, station, record.status, record.route_total, record.success_count, record.skipped_cached_count,
        record.failed_count, record.request_count, record.start_time, record.end_time, record.stop_reason, record.integrity]);
    },
    async writeRouteDetail({ route, beforeCommit = async () => {} }) {
      await transaction(async () => {
        const { zips, ...detail } = route;
        const result = await client.query(`INSERT INTO route_detail_versions
          (route_id,station_code,run_id,origin,status,fetched_at,detail) VALUES ($1,$2,$3,'dms','pending',$4,$5) RETURNING id`,
        [route.route_id, route.station, id, route.fetched_at, detail]);
        for (const [ordinal, zip] of zips.entries()) await client.query(
          'INSERT INTO route_detail_zips (detail_version_id,ordinal,postal_code,zip) VALUES ($1,$2,$3,$4)',
          [result.rows[0].id, ordinal, zip.postal_code, zip]);
        await beforeCommit();
      });
    },
    async activateStationSnapshot({ station, stationSnapshot, beforeCommit = async () => {}, processedIds = new Set(), freshIds = new Set() }) {
      let snapshotId;
      try {
        const links = [];
        for (const row of stationSnapshot.rows) {
          const versions = await client.query(`SELECT id,detail FROM route_detail_versions
            WHERE route_id=$1 AND status IN ('pending','committed') ORDER BY id DESC`, [row.route_id]);
          let link = null;
          for (const version of versions.rows) {
            const zips = await client.query('SELECT zip FROM route_detail_zips WHERE detail_version_id=$1 ORDER BY ordinal', [version.id]);
            if (completeRouteDetail({ ...version.detail, zips: zips.rows.map(value => value.zip) }, row,
              { allowZipMismatch: freshIds.has(row.route_id) })) { link = version.id; break; }
          }
          if (link === null && processedIds.has(row.route_id)) throw new DbIntegrityError();
          links.push(link);
        }
        await transaction(async () => {
          await client.query('INSERT INTO stations (code) VALUES ($1) ON CONFLICT DO NOTHING', [station]);
          const result = await client.query(`INSERT INTO station_snapshots
            (station_code,run_id,status,origin,fetched_at,source_as_of,source,total)
            VALUES ($1,$2,'pending','dms',$3,$4,$5,$6) RETURNING id`,
          [station, id, stationSnapshot.fetched_at, stationSnapshot.source_as_of, stationSnapshot.source, stationSnapshot.total]);
          snapshotId = result.rows[0].id;
          for (const [ordinal, row] of stationSnapshot.rows.entries()) {
            await client.query(`INSERT INTO snapshot_routes (snapshot_id,route_id,ordinal,route_name,profile,detail_version_id)
              VALUES ($1,$2,$3,$4,$5,$6)`, [snapshotId, row.route_id, ordinal, row.route_name, row, links[ordinal]]);
            for (const [zipOrdinal, zip] of row.postal_codes.entries()) await client.query(
              'INSERT INTO snapshot_route_zips (snapshot_id,route_id,postal_code,ordinal) VALUES ($1,$2,$3,$4)',
              [snapshotId, row.route_id, zip, zipOrdinal]);
          }
        });
        await transaction(async () => {
          const run = await client.query('SELECT status FROM scrape_runs WHERE id=$1 FOR UPDATE', [id]);
          const stationRow = await client.query('SELECT active_snapshot_id FROM stations WHERE code=$1 FOR UPDATE', [station]);
          const snapshot = await client.query('SELECT status FROM station_snapshots WHERE id=$1 FOR UPDATE', [snapshotId]);
          if (run.rows[0]?.status !== 'running' || snapshot.rows[0]?.status !== 'pending') throw new DbIntegrityError();
          await client.query("UPDATE station_snapshots SET status='superseded',superseded_at=now() WHERE id=$1", [stationRow.rows[0].active_snapshot_id]);
          await client.query("UPDATE station_snapshots SET status='active',activated_at=now() WHERE id=$1", [snapshotId]);
          await client.query('UPDATE stations SET active_snapshot_id=$1 WHERE code=$2', [snapshotId, station]);
          await client.query(`UPDATE route_detail_versions SET status='committed',committed_at=now()
            WHERE id = ANY($1::bigint[]) AND status='pending'`, [links.filter(value => value !== null)]);
          await client.query(`INSERT INTO scrape_run_stations (run_id,station_code,status,success_count,cached_count,failed_count,snapshot_id)
            VALUES ($1,$2,'in_progress',0,0,0,$3) ON CONFLICT (run_id,station_code) DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id`, [id, station, snapshotId]);
          await beforeCommit();
        });
      } catch (error) {
        if (snapshotId) await client.query("UPDATE station_snapshots SET status='rejected',rejected_reason=$2 WHERE id=$1",
          [snapshotId, error instanceof DbIntegrityError ? 'DbIntegrityError' : 'Error']).catch(() => {});
        throw error;
      }
    },
    async finishRun({ record }) {
      try {
        if (started) await client.query(`UPDATE scrape_runs SET status=$2,finished_at=$3,prod_api_requests=$4,
          request_cap=$5,stop_reason=$6,original_station_restored=$7 WHERE id=$1`,
        [id, record.status, record.end_time, record.request_count, record.batch_request_cap, record.stop_reason, record.original_station_restored]);
      } finally {
        if (client) { const connection = client; client = null; if (started) await connection.end(); else await connection.end().catch(() => {}); }
      }
    },
  };
}
