import path from 'node:path';

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
