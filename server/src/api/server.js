import http from 'node:http';
import { getStationSnapshot } from '../store/route-profiles-file.js';
import { createRequestHandler } from './app.js';

export function createApiServer({ runtimeDir, log } = {}) {
  return http.createServer(createRequestHandler({
    getSnapshot: (station) => getStationSnapshot({ runtimeDir, station }), log,
  }));
}

export async function startApiServer({ port = 3000, runtimeDir, log } = {}) {
  const server = createApiServer({ runtimeDir, log });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return server;
}
