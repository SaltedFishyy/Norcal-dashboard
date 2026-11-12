import { spawn as nodeSpawn } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { readDistrictConfig } from '../store/districts-file.js';
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

export function createRefreshLauncher({ runtimeDir, repoRoot, districtsPath,
  spawn = nodeSpawn, isAlive = processIsAlive, log = () => {} }) {
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
  const plan = async value => {
    const scope = parseRefreshScope(value);
    const config = await readDistrictConfig({ districtsPath });
    const result = planRefresh({ config, scope });
    const decorate = item => ({ ...item, district_name_zh: config.districts.find(d => d.id === item.district).name_zh });
    return { scope: result.scope, stations: result.stations.map(decorate), skipped: result.skipped.map(decorate) };
  };
  const isBusy = async () => Boolean(child || starting || (await lockState()).alive);
  const status = async () => {
    const busy = await isBusy();
    const raw = await readJson(progressFile);
    const progress = raw ? Object.fromEntries(progressKeys.filter(k => Object.hasOwn(raw, k)).map(k => [k, raw[k]])) : null;
    return { busy, progress };
  };
  const start = async ({ scope, trigger }) => {
    if (!['ui', 'schedule'].includes(trigger)) throw new Error('Invalid trigger');
    let result;
    try { result = await plan(scope); }
    catch (error) {
      if (error.name === 'DistrictConfigInvalidError') throw error;
      return { started: false, error: 'invalid_scope' };
    }
    if (!result.stations.length) { return { started: false, error: 'empty_scope' }; }
    if (child || starting) { return { started: false, error: 'refresh_in_progress' }; }
    // Reserve before awaiting the filesystem so concurrent POSTs cannot both spawn.
    starting = true;
    try {
      const { lock, alive } = await lockState();
      if (alive) { return { started: false, error: 'refresh_in_progress' }; }
      if (lock) await unlink(lockFile);
      // Persist a launch marker before spawning: an early crash must not show an older completed run.
      const startedAt = new Date().toISOString();
      await writeFileAtomic(progressFile, JSON.stringify({ run_id: null, scope: result.scope,
        started_at: startedAt, updated_at: startedAt, phase: 'config', station: null, district: null,
        station_index: 0, station_total: result.stations.length, route_index: 0, route_total: null,
        completed: [], skipped: result.skipped.map(item => item.code), failed: [], finished_at: null,
        status: 'running', stop_reason: null }));
      child = spawn(process.execPath, ['--env-file-if-exists=.env', 'server/bin/dms-scrape-stations.js',
        '--scope', scope, '--trigger', trigger, '--new-run', '--progress-file', progressFile],
      { cwd: repoRoot, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
      const current = child;
      const done = new Promise(resolve => {
        let settled = false;
        const finished = async exitCode => {
          if (settled) return;
          settled = true;
          if (child === current) child = null;
          let progress;
          try { progress = await readJson(progressFile); } catch { /* Treat unreadable progress as an exited process. */ }
          const final = progress?.status === 'completed' || progress?.status === 'stopped';
          resolve({ status: final ? progress.status : 'stopped',
            stop_reason: final ? progress.stop_reason ?? null : 'process:Exited',
            run_id: progress?.run_id ?? null, exit_code: exitCode });
        };
        child.once('exit', code => { void finished(code); });
        child.once('error', () => { void finished(null); });
      });
      forward(child.stdout, log); forward(child.stderr, log);
      return { started: true, done };
    } finally { starting = false; }
  };
  return { plan, isBusy, start, status };
}
