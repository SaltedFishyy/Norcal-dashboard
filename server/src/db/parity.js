import assert from 'node:assert/strict';
import { startApiServer } from '../api/server.js';
import { readDistricts } from '../store/districts-file.js';
import { readBoundaries } from '../store/boundaries-file.js';

export async function compareDataSources({ jsonSource, dbSource, runtimeDir, geoDir, districtsPath, log = () => {} }) {
  const servers = [];
  try {
    const sources = [jsonSource, dbSource];
    const profiles = await Promise.all(sources.map(source => source.readRouteProfiles()));
    const details = await Promise.all(sources.map(source => source.readRouteDetailsForMap()));
    const districts = await Promise.all(profiles.map(profile => readDistricts({ districtsPath, profiles: profile })));
    const boundaries = await readBoundaries({ geoDir });
    const stations = new Set(profiles.flatMap(profile => Object.keys(profile.stations)));
    const routeIds = new Set(details.flatMap(detail => Object.keys(detail.routes)));
    const zipCodes = new Set(profiles.flatMap(profile => Object.values(profile.stations)
      .flatMap(snapshot => snapshot.rows.flatMap(row => row.postal_codes ?? []))));
    const uncovered = [...boundaries.byZip.keys()].find(zip => !zipCodes.has(zip));
    const zips = new Set([...zipCodes, '00000', '99999', ...(uncovered ? [uncovered] : [])]);
    let absentStation = 'PARITY_MISSING', absentRoute = 1;
    while (stations.has(absentStation)) absentStation += '_';
    while (routeIds.has(String(absentRoute))) absentRoute++;
    const groups = {
      districts: ['/api/districts'], stations: ['/api/route-map/stations'],
      profiles: [...stations].map(station => `/api/route-profiles?station=${encodeURIComponent(station)}`),
      maps: [...stations].map(station => `/api/route-map?station=${encodeURIComponent(station)}`),
      district_maps: [...new Set(districts.flatMap(items => items.map(item => item.id)))]
        .map(district => `/api/route-map/district?district=${encodeURIComponent(district)}`),
      details: [...routeIds].map(id => `/api/route-details?route_id=${encodeURIComponent(id)}`),
      zips: [...zips].map(zip => `/api/route-map/zip?postal_code=${encodeURIComponent(zip)}`),
      errors: [`/api/route-profiles?station=${absentStation}`, `/api/route-map?station=${absentStation}`,
        `/api/route-details?route_id=${absentRoute}`, '/api/route-profiles', '/api/route-details?route_id=bad',
        '/api/route-map', '/api/route-map/zip?postal_code=bad', '/api/route-map/district?district=BAD'],
    };
    for (const dataSource of sources) servers.push(await startApiServer({ port: 0, runtimeDir, geoDir, districtsPath, dataSource }));
    const mismatches = [], counts = {};
    const request = async (server, pathname) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`);
      return { status: response.status, body: await response.json() };
    };
    for (const [group, paths] of Object.entries(groups)) {
      let equal = 0;
      for (const pathname of paths) {
        const responses = await Promise.all(servers.map(server => request(server, pathname)));
        try { assert.deepStrictEqual(responses[0], responses[1]); equal++; }
        catch { mismatches.push(pathname); log(`不一致: ${pathname}`); }
      }
      counts[group] = { total: paths.length, equal };
      log(`${group}: ${equal}/${paths.length}`);
    }
    return { exitCode: mismatches.length ? 1 : 0, counts, mismatches };
  } finally {
    await Promise.all(servers.map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
  }
}
