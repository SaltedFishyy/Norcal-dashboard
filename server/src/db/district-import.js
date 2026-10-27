import { readFile } from 'node:fs/promises';
import { defaultDistrictsPath, validateDistricts } from '../store/districts-file.js';

export async function importDistricts({ client, districtsPath = defaultDistrictsPath }) {
  const config = validateDistricts(JSON.parse(await readFile(districtsPath, 'utf8')));
  await client.query('BEGIN');
  try {
    // Lock all targets before checking emptiness to serialize concurrent seed imports and writers.
    await client.query('LOCK TABLE districts, known_stations, district_stations, district_config_version IN EXCLUSIVE MODE');
    const existing = await client.query(`SELECT 1 FROM districts UNION ALL SELECT 1 FROM known_stations
      UNION ALL SELECT 1 FROM district_stations UNION ALL SELECT 1 FROM district_config_version LIMIT 1`);
    if (existing.rowCount) throw new Error('District seed targets must be empty.');
    let memberships = 0;
    for (const [ordinal, district] of config.districts.entries()) {
      await client.query('INSERT INTO districts (id,name_zh,name_en,ordinal) VALUES ($1,$2,$3,$4)',
        [district.id, district.name_zh, district.name_en, ordinal]);
      for (const [position, code] of district.stations.entries()) {
        await client.query('INSERT INTO known_stations (code,scrape_disabled_reason) VALUES ($1,$2)',
          [code, district.scrape_disabled?.[code] ?? null]);
        await client.query('INSERT INTO district_stations (station_code,district_id,ordinal) VALUES ($1,$2,$3)',
          [code, district.id, position]);
        memberships++;
      }
    }
    await client.query('INSERT INTO known_stations (code) SELECT code FROM stations ON CONFLICT (code) DO NOTHING');
    await client.query('INSERT INTO district_config_version (id,version,updated_at) VALUES (true,1,now())');
    const known = (await client.query('SELECT count(*)::int AS count FROM known_stations')).rows[0].count;
    await client.query('COMMIT');
    return { districts: config.districts.length, known_stations: known, district_stations: memberships, version: 1 };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

// rows contains the four view result arrays, keyed by their base names.
export function assembleDistrictConfig(rows) {
  const reasons = new Map(rows.known_stations.map(row => [row.code, row.scrape_disabled_reason]));
  const districts = [...rows.districts].sort((a, b) => a.ordinal - b.ordinal).map(row => {
    const stations = rows.district_stations.filter(member => member.district_id === row.id)
      .sort((a, b) => a.ordinal - b.ordinal || a.station_code.localeCompare(b.station_code)).map(member => member.station_code);
    const disabled = Object.fromEntries(stations.filter(code => reasons.get(code)).map(code => [code, reasons.get(code)]));
    return { id: row.id, name_zh: row.name_zh, name_en: row.name_en, stations,
      ...(Object.keys(disabled).length ? { scrape_disabled: disabled } : {}) };
  });
  if (rows.district_config_version.length !== 1) throw new Error('District configuration version is unavailable.');
  return validateDistricts({ schema_version: 1, districts });
}
