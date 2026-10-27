import http from 'node:http';
import { StationNotFoundError, SnapshotNotFoundError } from '../store/route-profiles-file.js';
import { createJsonDataSource } from '../store/data-source.js';
import { readDistricts, DistrictNotFoundError } from '../store/districts-file.js';
import { readBoundaries } from '../store/boundaries-file.js';
import { buildRouteMap, buildDistrictMap, lookupZip } from '../route-map/route-map.js';
import { createRequestHandler } from './app.js';
import { fileURLToPath } from 'node:url';
import { createStaticReader } from './static-files.js';
import path from 'node:path';
import { readBasemap } from '../store/basemap-file.js';
import { createFreshnessHandlers } from './freshness.js';
import { createWarehouseHandlers } from '../warehouses/warehouse-api.js';

const defaultWebDir = fileURLToPath(new URL('../../../web/', import.meta.url));
export const defaultGeoDir = fileURLToPath(new URL('../../../geo/', import.meta.url));
const defaultLeafletDir = fileURLToPath(new URL('../../../node_modules/leaflet/dist/', import.meta.url));
const defaultProtomapsDir = fileURLToPath(new URL('../../../node_modules/protomaps-leaflet/dist/', import.meta.url));

export function createApiServer({ runtimeDir, webDir = defaultWebDir, geoDir = defaultGeoDir,
  leafletDir = defaultLeafletDir, protomapsDir = defaultProtomapsDir,
  basemapDir = runtimeDir ? path.join(runtimeDir, 'basemap') : undefined, districtsPath, log,
  capabilities, extraHandlers = new Map(), warehouses = {}, dataSource = createJsonDataSource({ runtimeDir }) } = {}) {
  const districtProfiles = async () => {
    try { return await dataSource.readRouteProfiles(); }
    catch (error) { if (error instanceof SnapshotNotFoundError) return { stations: {} }; throw error; }
  };
  const getDistrictExtent = async district => {
    try {
      const profiles = await districtProfiles();
      const districts = await readDistricts({ districtsPath, profiles });
      if (!Object.keys(profiles.stations).length) return null;
      const map = buildDistrictMap({ profiles, districts, district, boundaries: await readBoundaries({ geoDir }),
        details: await dataSource.readRouteDetailsForMap() });
      let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity;
      const visit = coords => {
        if (typeof coords[0] === 'number') {
          west = Math.min(west, coords[0]); east = Math.max(east, coords[0]);
          south = Math.min(south, coords[1]); north = Math.max(north, coords[1]);
        } else coords.forEach(visit);
      };
      map.features.features.forEach(feature => visit(feature.geometry.coordinates));
      return Number.isFinite(south) ? [[south, west], [north, east]] : null;
    } catch (error) {
      // Unusable map data must not prevent warehouse saves; DB and unknown failures still propagate.
      if (['RouteZipConflictError', 'PostalCodesMissingError', 'BoundaryInvalidError',
        'BoundaryNotFoundError', 'DistrictConfigInvalidError', 'SnapshotInvalidError',
        'RouteDetailInvalidError', 'DistrictNotFoundError', 'StationNotFoundError',
        'SnapshotNotFoundError'].includes(error?.name)) return null;
      throw error;
    }
  };
  const warehouseHandlers = createWarehouseHandlers({ dataSource, districtsPath, getDistrictExtent, ...warehouses });
  for (const [pathname, handler] of extraHandlers) {
    if (warehouseHandlers.has(pathname)) throw new Error('Extension cannot replace warehouse route');
    warehouseHandlers.set(pathname, handler);
  }
  return http.createServer(createRequestHandler({
    capabilities: { refresh: false, ...capabilities, warehouse_write: Boolean(warehouses.writeEnabled) },
    extraHandlers: warehouseHandlers, readHandlers: createFreshnessHandlers({ dataSource, districtsPath }),
    getSnapshot: (station) => dataSource.getStationSnapshot(station), log,
    getRouteDetail: (routeId) => dataSource.getRouteDetail(routeId),
    getRouteMap: async station => {
      const profiles = await dataSource.readRouteProfiles();
      if (!Object.hasOwn(profiles.stations, station)) throw new StationNotFoundError();
      const boundaries = await readBoundaries({ geoDir });
      return buildRouteMap({ profiles, station, boundaries, details: await dataSource.readRouteDetailsForMap() });
    },
    getMapStations: async () => {
      const districts = await readDistricts({ districtsPath, profiles: await dataSource.readRouteProfiles() });
      return districts.flatMap(district => district.stations.filter(station => station.has_snapshot).map(station => station.code));
    },
    getDistricts: async () => readDistricts({ districtsPath, profiles: await districtProfiles() }),
    getDistrictMap: async district => {
      const profiles = await districtProfiles();
      const districts = await readDistricts({ districtsPath, profiles });
      if (!districts.some(item => item.id === district)) throw new DistrictNotFoundError();
      return buildDistrictMap({ profiles, districts, district, boundaries: await readBoundaries({ geoDir }),
        details: await dataSource.readRouteDetailsForMap() });
    },
    getZip: async postalCode => lookupZip({ profiles: await dataSource.readRouteProfiles(),
      boundaries: await readBoundaries({ geoDir }), postalCode, details: await dataSource.readRouteDetailsForMap() }),
    getStaticFile: createStaticReader(webDir, leafletDir, protomapsDir),
    getBasemap: name => readBasemap({ basemapDir, name }),
  }));
}

export async function startApiServer({ port = 3000, host = '127.0.0.1', ...options } = {}) {
  const server = createApiServer(options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return server;
}
