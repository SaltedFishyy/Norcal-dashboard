import http from 'node:http';
import { getStationSnapshot, readRouteProfiles, StationNotFoundError, SnapshotNotFoundError } from '../store/route-profiles-file.js';
import { readDistricts, DistrictNotFoundError } from '../store/districts-file.js';
import { readBoundaries } from '../store/boundaries-file.js';
import { buildRouteMap, buildDistrictMap, lookupZip } from '../route-map/route-map.js';
import { getRouteDetail, readRouteDetailsForMap } from '../store/route-details-file.js';
import { createRequestHandler } from './app.js';
import { fileURLToPath } from 'node:url';
import { createStaticReader } from './static-files.js';
import path from 'node:path';
import { readBasemap } from '../store/basemap-file.js';

const defaultWebDir = fileURLToPath(new URL('../../../web/', import.meta.url));
const defaultGeoDir = fileURLToPath(new URL('../../../geo/', import.meta.url));
const defaultLeafletDir = fileURLToPath(new URL('../../../node_modules/leaflet/dist/', import.meta.url));
const defaultProtomapsDir = fileURLToPath(new URL('../../../node_modules/protomaps-leaflet/dist/', import.meta.url));

export function createApiServer({ runtimeDir, webDir = defaultWebDir, geoDir = defaultGeoDir,
  leafletDir = defaultLeafletDir, protomapsDir = defaultProtomapsDir,
  basemapDir = runtimeDir ? path.join(runtimeDir, 'basemap') : undefined, districtsPath, log } = {}) {
  const districtProfiles = async () => {
    try { return await readRouteProfiles({ runtimeDir }); }
    catch (error) { if (error instanceof SnapshotNotFoundError) return { stations: {} }; throw error; }
  };
  return http.createServer(createRequestHandler({
    getSnapshot: (station) => getStationSnapshot({ runtimeDir, station }), log,
    getRouteDetail: (routeId) => getRouteDetail({ runtimeDir, routeId }),
    getRouteMap: async station => {
      const profiles = await readRouteProfiles({ runtimeDir });
      if (!Object.hasOwn(profiles.stations, station)) throw new StationNotFoundError();
      const boundaries = await readBoundaries({ geoDir });
      return buildRouteMap({ profiles, station, boundaries, details: await readRouteDetailsForMap({ runtimeDir }) });
    },
    getMapStations: async () => {
      const districts = await readDistricts({ districtsPath, profiles: await readRouteProfiles({ runtimeDir }) });
      return districts.flatMap(district => district.stations.filter(station => station.has_snapshot).map(station => station.code));
    },
    getDistricts: async () => readDistricts({ districtsPath, profiles: await districtProfiles() }),
    getDistrictMap: async district => {
      const profiles = await districtProfiles();
      const districts = await readDistricts({ districtsPath, profiles });
      if (!districts.some(item => item.id === district)) throw new DistrictNotFoundError();
      return buildDistrictMap({ profiles, districts, district, boundaries: await readBoundaries({ geoDir }),
        details: await readRouteDetailsForMap({ runtimeDir }) });
    },
    getZip: async postalCode => lookupZip({ profiles: await readRouteProfiles({ runtimeDir }),
      boundaries: await readBoundaries({ geoDir }), postalCode, details: await readRouteDetailsForMap({ runtimeDir }) }),
    getStaticFile: createStaticReader(webDir, leafletDir, protomapsDir),
    getBasemap: name => readBasemap({ basemapDir, name }),
  }));
}

export async function startApiServer({ port = 3000, ...options } = {}) {
  const server = createApiServer(options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return server;
}
