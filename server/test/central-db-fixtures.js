import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { rawBoundaries, details, snapshot, route } from './route-map-fixtures.js';

export async function centralFixture(t) {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'nc-cdt4-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const geoDir = path.join(dir, 'geo'); await fs.mkdir(geoDir);
  const row = (id, station, zips) => ({ ...route(id, `MOCK-${id}`, zips), station, raw: { mock: true }, parse_errors: [] });
  // Reverse station order exercises independence from JSON key / DB query order.
  const profiles = { schema_version: 1, stations: {
    ZZZ01: snapshot([row(3, 'ZZZ01', ['00002'])]),
    AAA01: snapshot([row(2, 'AAA01', ['00004', '00005']), row(1, 'AAA01', ['00002', '00123']),
      ...Array.from({ length: 100 }, (_, index) => row(10 + index, 'AAA01', []))]),
  } };
  const stored = details().routes['1'];
  const routes = { schema_version: 1, routes: {
    '1': { ...stored, station: 'AAA01', capacity_raw: [{ mock: true }] },
    '831': { ...stored, route_id: 831, station: 'ZZZ01', route_name: 'MOCK-HISTORY', zips: [] },
  } };
  const boundary = rawBoundaries();
  await fs.writeFile(path.join(geoDir, 'zcta2020_ca_nv_or.geojson'), JSON.stringify(boundary.geojson));
  await fs.writeFile(path.join(geoDir, 'mock.meta.json'), JSON.stringify(boundary.meta));
  const districtsPath = path.join(dir, 'districts.json');
  await fs.writeFile(districtsPath, JSON.stringify({ schema_version: 1, districts: [
    { id: 'mock', name_zh: '模拟', name_en: 'Mock', stations: ['AAA01'] },
  ] }));
  const write = async () => {
    await fs.writeFile(path.join(dir, 'route-profiles.json'), JSON.stringify(profiles));
    await fs.writeFile(path.join(dir, 'route-details.json'), JSON.stringify(routes));
  };
  await write();
  return { runtimeDir: dir, geoDir, districtsPath, profiles, routes, write };
}
