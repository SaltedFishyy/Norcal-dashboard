import http from 'node:http';
import { getStationSnapshot } from '../store/route-profiles-file.js';
import { getRouteDetail } from '../store/route-details-file.js';
import { createRequestHandler } from './app.js';
import { fileURLToPath } from 'node:url';
import { createStaticReader } from './static-files.js';

const defaultWebDir = fileURLToPath(new URL('../../../web/', import.meta.url));

export function createApiServer({ runtimeDir, webDir = defaultWebDir, log } = {}) {
  return http.createServer(createRequestHandler({
    getSnapshot: (station) => getStationSnapshot({ runtimeDir, station }), log,
    getRouteDetail: (routeId) => getRouteDetail({ runtimeDir, routeId }),
    getStaticFile: createStaticReader(webDir),
  }));
}

export async function startApiServer({ port = 3000, runtimeDir, webDir, log } = {}) {
  const server = createApiServer({ runtimeDir, webDir, log });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return server;
}
