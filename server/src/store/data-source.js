import * as profiles from './route-profiles-file.js';
import * as details from './route-details-file.js';

export class DataSourceUnavailableError extends Error {
  constructor() { super('数据源暂时不可用。'); this.name = 'DataSourceUnavailableError'; }
}

export function createJsonDataSource({ runtimeDir }) {
  return {
    source: 'json',
    readCurrentFirstPrices: async () => [],
    readRouteQuotation: async () => { throw new DataSourceUnavailableError(); },
    readWarehouses: async () => { throw new DataSourceUnavailableError(); },
    readRuns: async () => [],
    readLastScrapeRun: async () => null,
    readRouteProfiles: () => profiles.readRouteProfiles({ runtimeDir }),
    getStationSnapshot: station => profiles.getStationSnapshot({ runtimeDir, station }),
    getRouteDetail: routeId => details.getRouteDetail({ runtimeDir, routeId }),
    readRouteDetailsForMap: () => details.readRouteDetailsForMap({ runtimeDir }),
  };
}
