import { pacificToday, snapshotCalendar } from './date-view.js';
import http from 'node:http';
import { StationNotFoundError, SnapshotNotFoundError } from '../store/route-profiles-file.js';
import { buildPriceIndex, routePriceSummary, buildRouteQuotation, RouteNotFoundError } from '../quotations/quotations.js';
import { DataSourceUnavailableError } from '../store/data-source.js';
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
import { buildRouteHistory } from './route-history.js';

const defaultWebDir = fileURLToPath(new URL('../../../web/', import.meta.url));
export const defaultGeoDir = fileURLToPath(new URL('../../../geo/', import.meta.url));
const defaultLeafletDir = fileURLToPath(new URL('../../../node_modules/leaflet/dist/', import.meta.url));
const defaultProtomapsDir = fileURLToPath(new URL('../../../node_modules/protomaps-leaflet/dist/', import.meta.url));

export function createApiServer({ runtimeDir, webDir = defaultWebDir, geoDir = defaultGeoDir,
  leafletDir = defaultLeafletDir, protomapsDir = defaultProtomapsDir,
  basemapDir = runtimeDir ? path.join(runtimeDir, 'basemap') : undefined, districtsPath, log,
  capabilities, extraHandlers = new Map(), warehouses = {}, now = () => new Date(), dataSource = createJsonDataSource({ runtimeDir }) } = {}) {
  const readPriceIndex = async () => {
    if (dataSource.source !== 'db') return null;
    try { return buildPriceIndex(await dataSource.readCurrentFirstPrices()); }
    catch { return null; } // Isolate quotation failures from DMS reads; never expose driver errors.
  };
  const sourceFor = day => {
    if (day === undefined) return dataSource;
    const source = dataSource.atDay?.(day);
    if (!source) { const error = new Error(); error.name = 'HistoryUnavailableError'; throw error; }
    return source;
  };
  const districtProfiles = async (source = dataSource) => {
    try { return await source.readRouteProfiles(); }
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
    capabilities: { refresh: false, ...capabilities, warehouse_write: Boolean(warehouses.writeEnabled), route_quotation: dataSource.source === 'db' },
    extraHandlers: warehouseHandlers, readHandlers: createFreshnessHandlers({ dataSource, districtsPath }),
    today: () => pacificToday(now),
    getSnapshotDays: async ({ station, district }) => {
      if (dataSource.source !== 'db') return { available: false };
      let stations = [station];
      if (district !== undefined) {
        const districts = await readDistricts({ districtsPath, profiles: await districtProfiles() });
        const found = districts.find(item => item.id === district);
        if (!found) throw new DistrictNotFoundError();
        stations = found.stations.map(item => item.code);
      }
      const rows = await dataSource.readSnapshotDays({ stations });
      return rows === null ? { available: false } : snapshotCalendar(rows, pacificToday(now));
    },
    getSnapshot: async (station, day) => {
      const snapshot = await sourceFor(day).getStationSnapshot(station);
      const priceIndex = await readPriceIndex();
      return { ...snapshot, rows: snapshot.rows.map(row => ({ ...row, ...routePriceSummary(priceIndex, row) })) };
    }, log,
    getRouteHistory: async (routeId, days) => {
      const today = pacificToday(now);
      const history = await dataSource.readRouteHistory({ routeId, days, today });
      return history === null ? { available: false } : buildRouteHistory(history.rows, { routeId, days, ...history });
    },
    getRouteQuotation: async routeId => {
      let profiles;
      try { profiles = await dataSource.readRouteProfiles(); }
      catch (error) { if (error instanceof SnapshotNotFoundError) throw new RouteNotFoundError(); throw error; }
      const owner = Object.entries(profiles.stations).flatMap(([station, snapshot]) =>
        snapshot.rows.filter(route => route.route_id === routeId).map(route => ({ route, station })))[0];
      if (!owner) throw new RouteNotFoundError();
      let quotation;
      try { quotation = await dataSource.readRouteQuotation(routeId); }
      catch { throw new DataSourceUnavailableError(); }
      return buildRouteQuotation({ ...owner, ...quotation });
    },
    getRouteDetail: (routeId, day) => sourceFor(day).getRouteDetail(routeId),
    getRouteMap: async (station, day) => {
      const source = sourceFor(day);
      const profiles = await source.readRouteProfiles();
      if (!Object.hasOwn(profiles.stations, station)) throw new StationNotFoundError();
      const boundaries = await readBoundaries({ geoDir });
      return buildRouteMap({ profiles, station, boundaries, priceIndex: await readPriceIndex(), details: await source.readRouteDetailsForMap() });
    },
    getMapStations: async day => {
      const districts = await readDistricts({ districtsPath, profiles: await sourceFor(day).readRouteProfiles() });
      return districts.flatMap(district => district.stations.filter(station => station.has_snapshot).map(station => station.code));
    },
    getDistricts: async day => readDistricts({ districtsPath, profiles: await districtProfiles(sourceFor(day)) }),
    getDistrictMap: async (district, day) => {
      const source = sourceFor(day);
      const profiles = await districtProfiles(source);
      const districts = await readDistricts({ districtsPath, profiles });
      if (!districts.some(item => item.id === district)) throw new DistrictNotFoundError();
      return buildDistrictMap({ profiles, districts, district, boundaries: await readBoundaries({ geoDir }),
        priceIndex: await readPriceIndex(), details: await source.readRouteDetailsForMap() });
    },
    getZip: async (postalCode, day) => {
      const source = sourceFor(day);
      return lookupZip({ profiles: await source.readRouteProfiles(),
        boundaries: await readBoundaries({ geoDir }), postalCode, priceIndex: await readPriceIndex(), details: await source.readRouteDetailsForMap() });
    },
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
