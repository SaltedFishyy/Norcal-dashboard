import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestDb, dbSkip } from './db-helpers.js';
import { migrate } from '../src/db/migrate.js';

test('DB-T1: schedule constraint, history selection, safe projection and reader privileges', { skip: dbSkip }, async t => {
  const db = await createTestDb(t), run = randomUUID();
  await db.scraper.query(`INSERT INTO scrape_runs (id, trigger, status, requested_stations, options, started_at)
    VALUES ($1, 'schedule', 'completed', ARRAY['TST01','TST02'], '{}', now())`, [run]);
  await assert.rejects(db.scraper.query(`INSERT INTO scrape_runs (id, trigger, status, requested_stations, options, started_at)
    VALUES ($1, 'invalid', 'completed', '{}', '{}', now())`, [randomUUID()]), { code: '23514' });
  await db.scraper.query("INSERT INTO stations(code) VALUES ('TST01'), ('TST02')");
  const valid = { dsp_name: 'Synthetic DSP', pickup_volume: 120, pph: 12.5, first_mile_distance: 3.25,
    route_difficulty: 'A级 难', postal_codes: ['00123', '94005'], raw: { private: 'synthetic' } };
  async function snapshot(station, status, activated, created, profiles = [valid]) {
    const id = (await db.owner.query(`INSERT INTO station_snapshots
      (station_code, run_id, status, origin, fetched_at, source, total, activated_at, created_at)
      VALUES ($1,$2,$3,'dms','deliberately-not-a-date','dms-playwright',$4,$5,$6) RETURNING id`,
    [station, run, status, profiles.length, activated, created])).rows[0].id;
    for (const [index, profile] of profiles.entries()) {
      await db.scraper.query(`INSERT INTO snapshot_routes (snapshot_id,route_id,ordinal,route_name,profile)
        VALUES ($1,$2,$3,$4,$5)`, [id, index + 1, index, `Synthetic ${index + 1}`, profile]);
    }
    return id;
  }
  const created = '2026-11-01T00:00:00Z';
  const previous = await snapshot('TST01', 'superseded', '2026-11-10T07:30:00Z', created);
  await snapshot('TST01', 'superseded', '2026-11-10T08:30:00Z', created);
  await snapshot('TST01', 'superseded', '2026-11-10T20:00:00Z', created);
  const latest = await snapshot('TST01', 'active', '2026-11-10T20:00:00Z', created, [valid,
    { pickup_volume: '120', pph: 'bad', first_mile_distance: false, postal_codes: '00123' },
    {}, { pickup_volume: null, pph: {}, first_mile_distance: [], postal_codes: [] }]);
  await snapshot('TST01', 'pending', '2026-11-10T22:00:00Z', created);
  await snapshot('TST01', 'rejected', '2026-11-11T22:00:00Z', created);
  const fallback = await snapshot('TST02', 'superseded', null, '2026-11-10T08:30:00Z');
  const result = await db.reader.query(`SELECT *, day::text AS day_text FROM v_route_history_daily ORDER BY station, day, route_id`);
  assert.equal(result.rowCount, 6);
  const [old, current, dirty, missing, empty, other] = result.rows;
  assert.equal(old.day_text, '2026-11-09');
  assert.equal(old.snapshot_id, previous);
  assert.equal(current.day_text, '2026-11-10');
  assert.equal(current.snapshot_id, latest);
  assert.equal(current.snapshot_at.toISOString(), '2026-11-10T20:00:00.000Z');
  assert.equal(current.route_id, '1');
  assert.equal(current.route_name, 'Synthetic 1');
  assert.equal(current.dsp_name, valid.dsp_name);
  assert.equal(current.route_difficulty, valid.route_difficulty);
  assert.equal(current.pickup_volume, '120');
  assert.equal(current.pph, '12.5');
  assert.equal(current.first_mile_distance, '3.25');
  assert.deepEqual(current.postal_codes, valid.postal_codes);
  assert.equal(current.zip_count, 2);
  for (const row of [dirty, missing, empty]) {
    for (const field of ['pickup_volume', 'pph', 'first_mile_distance']) assert.equal(row[field], null);
  }
  for (const row of [dirty, missing]) {
    assert.equal(row.postal_codes, null);
    assert.equal(row.zip_count, null);
  }
  assert.deepEqual(empty.postal_codes, []);
  assert.equal(empty.zip_count, 0);
  assert.equal(other.station, 'TST02');
  assert.equal(other.day_text, '2026-11-10');
  assert.equal(other.snapshot_id, fallback);
  assert.equal(other.snapshot_at.toISOString(), '2026-11-10T08:30:00.000Z');
  assert.ok(result.rows.every(row => !Object.hasOwn(row, 'raw') && !Object.hasOwn(row, 'profile')));
  assert.equal((await db.scraper.query('SELECT * FROM v_route_history_daily')).rowCount, 6);
  await assert.rejects(db.reader.query('SELECT * FROM snapshot_routes'), { code: '42501' });
  const index = await db.owner.query(`SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname='snapshot_routes_route_id_idx'`, [db.schema]);
  assert.match(index.rows[0].indexdef, /\(route_id\)/);
  const versions = [];
  await migrate(db.owner, { ...db.options, onResult: value => versions.push(value) });
  assert.deepEqual(versions.at(-1), { version: '009', result: 'skipped' });
  assert.ok(versions.every(value => value.result === 'skipped'));
});
