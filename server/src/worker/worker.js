import { spawn as nodeSpawn } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createApiServer } from '../api/server.js';
import { sendJson } from '../api/http-utils.js';
import { projectRun, needsLogin } from '../api/freshness.js';
import { readDistrictConfig, DistrictNotFoundError } from '../store/districts-file.js';
import { parseRefreshScope, planRefresh } from '../batch/refresh-plan.js';
import { processIsAlive } from '../batch/scrape-lock.js';
import { writeFileAtomic } from '../store/atomic-file.js';

const progressKeys = ['run_id', 'scope', 'started_at', 'updated_at', 'phase', 'station', 'district',
  'station_index', 'station_total', 'route_index', 'route_total', 'completed', 'skipped', 'failed',
  'finished_at', 'status', 'stop_reason'];
async function readJson(filename) {
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function forward(stream, log) {
  let buffer = '';
  stream?.on('data', chunk => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/); buffer = lines.pop();
    for (const line of lines) log(`[scrape] ${line}`);
  });
  stream?.on('end', () => { if (buffer) log(`[scrape] ${buffer}`); buffer = ''; });
}

export function createWorkerServer({ runtimeDir, repoRoot, dataSource, districtsPath,
  spawn = nodeSpawn, isAlive = processIsAlive, log = () => {}, ...options }) {
  const progressFile = path.join(runtimeDir, 'refresh-progress.json');
  const lockFile = path.join(runtimeDir, 'scrape.lock');
  let child = null, starting = false;
  const lockState = async () => {
    try {
      const lock = await readJson(lockFile);
      if (!lock) return { lock: null, alive: false };
      // Malformed or inaccessible locks fail closed; never probe pid 0 or negative pids.
      if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0) return { lock, alive: true };
      return { lock, alive: await isAlive(lock.pid) };
    } catch { return { lock: null, alive: true }; }
  };
  const status = async () => {
    const { alive } = await lockState();
    const raw = await readJson(progressFile);
    let progress = raw ? Object.fromEntries(progressKeys.filter(k => Object.hasOwn(raw, k)).map(k => [k, raw[k]])) : null;
    const last = await dataSource.readLastScrapeRun();
    if (!child && !starting && !alive && progress && last
      && Date.parse(last.started_at) > Date.parse(progress.started_at)) progress = null;
    let state;
    if (child || starting || alive) state = 'running';
    else if (progress) {
      state = progress.status === 'completed' ? 'completed' : 'stopped';
      if (progress.status === 'running') {
        progress.status = 'stopped'; progress.stop_reason = 'process:Exited';
      }
    } else state = !last ? 'idle' : last.status === 'completed' ? 'completed' : 'stopped';
    return { state, progress, last_run: projectRun(last),
      needs_login: needsLogin(progress?.stop_reason ?? last?.stop_reason) };
  };
  const plan = async value => {
    const scope = parseRefreshScope(value);
    const config = await readDistrictConfig({ districtsPath });
    const result = planRefresh({ config, scope });
    const decorate = item => ({ ...item, district_name_zh: config.districts.find(d => d.id === item.district).name_zh });
    return { scope: result.scope, stations: result.stations.map(decorate), skipped: result.skipped.map(decorate) };
  };
  const preview = async ({ url, respond }) => {
    const scopes = url.searchParams.getAll('scope');
    if (scopes.length !== 1) { respond(400, { error: 'invalid_scope' }); return; }
    try { respond(200, await plan(scopes[0])); }
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
    let result;
    try { result = await plan(body?.scope); }
    catch (error) {
      if (error.name === 'DistrictConfigInvalidError') throw error;
      respond(400, { error: 'invalid_scope' }); return;
    }
    if (!result.stations.length) { respond(400, { error: 'empty_scope' }); return; }
    if (child || starting) { respond(409, { error: 'refresh_in_progress' }); return; }
    // Reserve before awaiting the filesystem so concurrent POSTs cannot both spawn.
    starting = true;
    try {
      const { lock, alive } = await lockState();
      if (alive) { respond(409, { error: 'refresh_in_progress' }); return; }
      if (lock) await unlink(lockFile);
      // Persist a launch marker before spawning: an early crash must not show an older completed run.
      const startedAt = new Date().toISOString();
      await writeFileAtomic(progressFile, JSON.stringify({ run_id: null, scope: result.scope,
        started_at: startedAt, updated_at: startedAt, phase: 'config', station: null, district: null,
        station_index: 0, station_total: result.stations.length, route_index: 0, route_total: null,
        completed: [], skipped: result.skipped.map(item => item.code), failed: [], finished_at: null,
        status: 'running', stop_reason: null }));
      child = spawn(process.execPath, ['--env-file-if-exists=.env', 'server/bin/dms-scrape-stations.js',
        '--scope', body.scope, '--trigger', 'ui', '--new-run', '--progress-file', progressFile],
      { cwd: repoRoot, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
      const current = child;
      const finished = () => { if (child === current) child = null; };
      child.once('exit', finished); child.once('error', finished);
      forward(child.stdout, log); forward(child.stderr, log);
      respond(202, await status());
    } finally { starting = false; }
  };
  post.methods = ['POST'];
  server = createApiServer({ ...options, runtimeDir, districtsPath, dataSource, log,
    warehouses: { ...options.warehouses, allowedHosts: () => [`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`] },
    capabilities: { refresh: true }, extraHandlers: new Map([
      ['/api/refresh/preview', preview], ['/api/refresh', post],
      ['/api/refresh/status', async ({ respond }) => respond(200, await status())],
    ]) });
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
