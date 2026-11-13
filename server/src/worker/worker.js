import { createApiServer } from '../api/server.js';
import { sendJson } from '../api/http-utils.js';
import { projectRun, needsLogin } from '../api/freshness.js';
import { DistrictNotFoundError } from '../store/districts-file.js';
import { createRefreshLauncher } from './refresh-launcher.js';
import { readQuotationSyncStatus } from '../quotations/quotation-sync-status.js';

export function createWorkerServer({ runtimeDir, repoRoot, dataSource, districtsPath,
  spawn, isAlive, log = () => {}, quotationSyncIntervalMinutes = 0, ...options }) {
  const launcher = createRefreshLauncher({ runtimeDir, repoRoot, districtsPath, spawn, isAlive, log });
  const status = async () => {
    let { busy, progress } = await launcher.status();
    const last = await dataSource.readLastScrapeRun();
    if (!busy && progress && last
      && Date.parse(last.started_at) > Date.parse(progress.started_at)) progress = null;
    let state;
    if (busy) state = 'running';
    else if (progress) {
      state = progress.status === 'completed' ? 'completed' : 'stopped';
      if (progress.status === 'running') {
        progress.status = 'stopped'; progress.stop_reason = 'process:Exited';
      }
    } else state = !last ? 'idle' : last.status === 'completed' ? 'completed' : 'stopped';
    return { state, progress, last_run: projectRun(last),
      needs_login: needsLogin(progress?.stop_reason ?? last?.stop_reason) };
  };
  const preview = async ({ url, respond }) => {
    const scopes = url.searchParams.getAll('scope');
    if (scopes.length !== 1) { respond(400, { error: 'invalid_scope' }); return; }
    try { respond(200, await launcher.plan(scopes[0])); }
    catch (error) {
      if (error.name === 'DistrictConfigInvalidError') throw error;
      respond(error instanceof DistrictNotFoundError ? 404 : 400, { error: error instanceof DistrictNotFoundError ? 'district_not_found' : 'invalid_scope' });
    }
  };
  let server;
  const post = async ({ req, respond }) => {
    const port = server.address().port;
    if (![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin)) {
      respond(403, { error: 'forbidden_origin' }); return;
    }
    if (req.headers['x-nc-refresh'] !== '1') { respond(403, { error: 'forbidden_header' }); return; }
    if (req.headers['content-type'] !== 'application/json') { respond(400, { error: 'invalid_content_type' }); return; }
    let body;
    try {
      let size = 0; const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024) { respond(400, { error: 'invalid_body' }); return; }
        chunks.push(chunk);
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { respond(400, { error: 'invalid_body' }); return; }
    const result = await launcher.start({ scope: body?.scope, trigger: 'ui' });
    if (!result.started) {
      respond(result.error === 'refresh_in_progress' ? 409 : 400, { error: result.error }); return;
    }
    respond(202, await status());
  };
  post.methods = ['POST'];
  server = createApiServer({ ...options, runtimeDir, districtsPath, dataSource, log,
    // Worker shares the API handler but retains its original response encoding.
    compressResponses: false,
    warehouses: { ...options.warehouses, allowedHosts: () => [`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`] },
    capabilities: { refresh: true, quotation_sync: true, auto_refresh: true }, extraHandlers: new Map([
      ['/api/auto-refresh/status', async ({ respond }) => respond(200,
        server.autoRefreshScheduler?.status() ?? { enabled: false })],
      ['/api/quotation-sync/status', async ({ respond }) => respond(200, {
        enabled: quotationSyncIntervalMinutes > 0, interval_minutes: quotationSyncIntervalMinutes,
        status: await readQuotationSyncStatus(runtimeDir),
      })],
      ['/api/refresh/preview', preview], ['/api/refresh', post],
      ['/api/refresh/status', async ({ respond }) => respond(200, await status())],
    ]) });
  server.refreshLauncher = launcher;
  const handler = server.listeners('request')[0];
  server.removeListener('request', handler);
  server.on('request', (req, res) => {
    const port = server.address().port;
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host)) {
      sendJson(res, 403, { error: 'forbidden_host' }); return;
    }
    handler(req, res);
  });
  return server;
}

export async function startWorkerServer({ port = 3100, ...options }) {
  const server = createWorkerServer(options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  return server;
}
