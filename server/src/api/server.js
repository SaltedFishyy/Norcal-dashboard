import http from 'node:http';
import { defaultStationOrder } from '../config.js';
import { getStationSnapshot, readRouteProfiles, StationNotFoundError } from '../store/route-profiles-file.js';
import { readBoundaries } from '../store/boundaries-file.js';
import { buildRouteMap, lookupZip } from '../route-map/route-map.js';
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
  basemapDir = runtimeDir ? path.join(runtimeDir, 'basemap') : undefined, log } = {}) {
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
      const stations = Object.keys((await readRouteProfiles({ runtimeDir })).stations);
      return [...defaultStationOrder.filter(code => stations.includes(code)),
        ...stations.filter(code => !defaultStationOrder.includes(code)).sort()];
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
