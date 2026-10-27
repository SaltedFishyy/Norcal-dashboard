import path from 'node:path';
import { parseRefreshScope } from './batch/refresh-plan.js';

const pathApi = (platform) => platform === 'win32' ? path.win32 : path.posix;

export function resolveRuntimeDir({ env, platform, homedir, repoRoot }) {
  const p = pathApi(platform);
  const override = env.RUNTIME_DATA_DIR?.trim();
  const base = platform === 'win32' && env.LOCALAPPDATA?.trim()
    ? p.join(env.LOCALAPPDATA, 'nc-ops-console')
    : p.join(homedir, '.nc-ops-console');
  return p.resolve(repoRoot, override || p.join(base, 'runtime-data'));
}

export function checkRuntimeDir(runtimeDir, repoRoot, platform = process.platform) {
  const p = pathApi(platform);
  const absolutePath = p.resolve(repoRoot, runtimeDir);
  const normalize = (s) => platform === 'win32' ? s.toLowerCase() : s;
  const relative = p.relative(normalize(p.resolve(repoRoot)), normalize(absolutePath));
  const warnings = [];
  if (!relative || (relative !== '..' && !relative.startsWith(`..${p.sep}`) && !p.isAbsolute(relative))) {
    warnings.push('warning: Runtime 目录位于仓库内，建议使用仓库外的默认路径。');
  }
  if (/onedrive|dropbox|google drive|icloud/i.test(absolutePath)) {
    warnings.push('warning: Runtime 目录包含同步目录名称，建议使用 LOCALAPPDATA 下的默认路径。');
  }
  return { path: absolutePath, warnings };
}

export function parseMaxListRequests(value) {
  const count = value?.trim() ? Number(value) : 3;
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('MAX_PAGE_LOADS_PER_STATION 必须是正整数。');
  return count;
}

export function parseMaxRouteDetailRequests(value) {
  const count = value?.trim() ? Number(value) : 30;
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('MAX_ROUTE_DETAIL_REQUESTS 必须是正整数。');
  return count;
}

const batchInteger = (value, fallback, minimum, name) => {
  const count = value === undefined ? fallback : /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(count) || count < minimum) throw new Error(`${name} 配置无效。`);
  return count;
};
export const parseRouteDetailBatchDelay = value => batchInteger(value, 4000, 2000, 'ROUTE_DETAIL_BATCH_DELAY_MS');
export const parseMaxRouteDetailBatchRequests = value => batchInteger(value, 800, 1, 'MAX_ROUTE_DETAIL_BATCH_REQUESTS');
export const parseMaxRouteDetailBatchProdApiRequests = value => batchInteger(value, 1000, 1, 'MAX_ROUTE_DETAIL_BATCH_PROD_API_REQUESTS');

export const defaultStationOrder = ['SFO01', 'SMF01', 'RNO01', 'SCK01', 'MOD01', 'MFR01', 'OAR01', 'RDG01', 'RDG02'];
export function parseStationBatchArgs(args) {
  const options = { stations: [...defaultStationOrder], maxRoutesPerStation: null, refresh: false, newRun: false, headless: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) throw new Error('Invalid batch arguments');
    seen.add(flag);
    if (flag === '--stations') {
      options.stations = (args[++i] || '').split(',');
      if (!options.stations.every(code => /^[A-Z]{3}\d{2}$/.test(code))
        || new Set(options.stations).size !== options.stations.length) throw new Error('Invalid stations');
    } else if (flag === '--scope') options.scope = parseRefreshScope(args[++i]);
    else if (flag === '--trigger') {
      options.trigger = args[++i];
      if (!['ui', 'cli'].includes(options.trigger)) throw new Error('Invalid trigger');
    } else if (flag === '--progress-file') {
      options.progressFile = args[++i];
      if (!options.progressFile || options.progressFile.startsWith('--')) throw new Error('Invalid progress file');
    } else if (flag === '--max-routes-per-station') {
      const value = args[++i];
      if (!/^[1-9]\d*$/.test(value || '') || !Number.isSafeInteger(Number(value))) throw new Error('Invalid route limit');
      options.maxRoutesPerStation = Number(value);
    } else if (flag === '--refresh') options.refresh = true;
    else if (flag === '--new-run') options.newRun = true;
    else if (flag === '--headless') options.headless = true;
    else throw new Error('Invalid batch arguments');
  }
  if (seen.has('--scope') && seen.has('--stations')) throw new Error('Scope and stations are mutually exclusive');
  return options;
}
export function parseStationBatchConfig(env) {
  return {
    routeDelay: batchInteger(env.ROUTE_DETAIL_BATCH_DELAY_MS, 2000, 2000, 'ROUTE_DETAIL_BATCH_DELAY_MS'),
    stationDelay: batchInteger(env.STATION_BATCH_DELAY_MS, 15000, 10000, 'STATION_BATCH_DELAY_MS'),
    stationBase: batchInteger(env.STATION_REQUEST_BASE, 80, 1, 'STATION_REQUEST_BASE'),
    perRoute: batchInteger(env.STATION_REQUEST_PER_ROUTE, 22, 1, 'STATION_REQUEST_PER_ROUTE'),
    batchMax: batchInteger(env.MAX_MULTI_STATION_BATCH_REQUESTS, 12000, 1, 'MAX_MULTI_STATION_BATCH_REQUESTS'),
    maxDetailRequests: parseMaxRouteDetailRequests(env.MAX_ROUTE_DETAIL_REQUESTS),
    maxListRequests: parseMaxListRequests(env.MAX_PAGE_LOADS_PER_STATION),
  };
}
export function stationRequestCap(total, { stationBase, perRoute }) {
  const cap = stationBase + perRoute * total + (Math.max(1, Math.ceil(total / 100)) - 1) * 5;
  if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(cap)) throw new Error('Invalid station cap');
  return cap;
}

export function resolveStatePath({ env, platform, homedir, repoRoot }) {
  const p = pathApi(platform);
  const override = env.DMS_STATE_PATH?.trim();
  if (override) return p.resolve(repoRoot, override);
  const base = platform === 'win32' && env.LOCALAPPDATA?.trim()
    ? p.join(env.LOCALAPPDATA, 'nc-ops-console')
    : p.join(homedir, '.nc-ops-console');
  return p.resolve(base, 'playwright', '.auth', 'dms-state.json');
}

export function checkStatePath(statePath, repoRoot, platform = process.platform) {
  const p = pathApi(platform);
  const absolutePath = p.resolve(repoRoot, statePath);
  const normalize = (value) => platform === 'win32' ? value.toLowerCase() : value;
  const relative = p.relative(normalize(p.resolve(repoRoot)), normalize(absolutePath));
  if (!relative || (relative !== '..' && !relative.startsWith(`..${p.sep}`) && !p.isAbsolute(relative))) {
    throw new Error('Session 路径位于仓库内，拒绝运行。请将 DMS_STATE_PATH 配置到仓库外。');
  }
  const warnings = /onedrive|dropbox|google drive|icloud/i.test(absolutePath)
    ? ['warning: Session 路径包含同步目录名称，登录态可能被同步；建议使用 LOCALAPPDATA 下的默认路径。']
    : [];
  return { path: absolutePath, warnings };
}

export function parseBaseUrl(value) {
  if (!value?.trim()) throw new Error('请在本地 .env 中配置 DMS_BASE_URL，然后重新运行 npm run dms:login。');
  let url;
  try { url = new URL(value.trim()); } catch {
    throw new Error('DMS_BASE_URL 必须是有效的 HTTP(S) URL。');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('DMS_BASE_URL 必须是 HTTP(S) URL，且不能包含账号或密码。');
  }
  return { href: url.href, display: url.origin + url.pathname };
}
