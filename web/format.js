import { difficultyLevel } from './difficulty.js';

// Preserve API order for ties and missing values without changing source rows.
export function sortRows(rows, sort) {
  if (!['pickup_volume', 'pph', 'price'].includes(sort.key)) return [...rows];
  const field = sort.key === 'price' ? 'current_first_0_1lb_price_min' : sort.key;
  const valid = value => typeof value === 'number' && Number.isFinite(value);
  return rows.map((row, index) => ({ row, index })).sort((a, b) => {
    const av = a.row[field], bv = b.row[field];
    if (valid(av) !== valid(bv)) return valid(av) ? -1 : 1;
    if (!valid(av) || av === bv) return a.index - b.index;
    return (av < bv ? -1 : 1) * (sort.dir === 'asc' ? 1 : -1);
  }).map(item => item.row);
}

// Lightweight user-facing text shared by the profile page and detail modal.
export const profileText = {
  loading: '加载中…', networkError: '无法连接本地服务器。',
  empty: '所选站点 暂无数据。请运行 npm run dms:scrape 创建快照。',
  loadError: code => `无法加载线路画像 (${code})。`,
  routeName: '线路名称', routeId: 'Route ID', station: '站点', dsp: 'DSP',
  volume: 'Pickup Volume', pph: 'PPH', firstMile: '首公里距离 (mi)',
  difficulty: '线路难度', manualDifficulty: '人工难度', zipCount: 'ZIP 数',
  profileUpdated: '线路数据更新时间', detailUpdated: 'ZIP 详情更新时间',
  zipDifficulty: 'ZIP 难度', experiencedPph: '熟手 PPH', pickupDaily: '领件量（日均）',
  zipTable: 'ZIP 画像表',
  zipCaption: '按 ZIP 升序显示的 ZIP 画像',
  firstMileNote: '首公里距离为线路级数值，在每个 ZIP 行重复显示。',
  noDetail: '该线路暂无详细数据',
  scrapeHint: station => `可运行 npm run dms:scrape-route-details -- --station ${station || 'SFO01'} 获取。`,
  detailError: code => `无法加载线路详情 (${code})。`,
  detailNetworkError: '无法连接本地服务器 (server_unreachable)。',
};

export function formatValue(value) {
  return value === null || value === undefined || value === '' ? '—' : String(value);
}

export function formatPrice(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `$${value.toFixed(2)}` : '—';
}

export function formatPriceRange(min, max) {
  const low = formatPrice(min), high = formatPrice(max);
  if (low === '—') return high;
  return high === '—' || min === max ? low : `${low}–${high}`;
}

export function formatPercent(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : '—';
}

export function difficultyTone(text) {
  return { D: 'easy', C: 'easy', B: 'medium', A: 'hard', S: 'hard' }[difficultyLevel(text)] ?? 'unknown';
}

export function formatNumber(value, maximumFractionDigits = 2, minimumFractionDigits = 0) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits, minimumFractionDigits }).format(value);
}

export function formatUpdated(value) {
  if (typeof value !== 'string' || value === '') return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23', timeZoneName: 'short',
  }).formatToParts(date);
  const fields = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${fields.year}-${fields.month}-${fields.day} ${fields.hour}:${fields.minute} ${fields.timeZoneName}`;
}

// Only stable API codes are shown; unexpected response text may contain private paths.
const errorCodes = new Set(['district_config_invalid', 'district_not_found', 'invalid_district', 'invalid_station', 'snapshot_invalid', 'internal_error', 'not_found', 'method_not_allowed']);
export function pageState({ loading = false, status, data, failed = false } = {}) {
  if (loading) return { state: 'loading', message: profileText.loading };
  if (failed) return { state: 'error', message: profileText.networkError };
  if ((status === 404 && ['snapshot_not_found', 'station_not_found'].includes(data?.error)) ||
      (status === 200 && Array.isArray(data?.rows) && data.rows.length === 0)) {
    return { state: 'empty', message: profileText.empty };
  }
  if (status === 200 && Array.isArray(data?.rows)) return { state: 'success', message: '' };
  const code = errorCodes.has(data?.error) ? data.error : 'internal_error';
  return { state: 'error', message: profileText.loadError(code) };
}

export function dspOptions(routes, focusStation = null) {
  return [...new Set(routes.filter(route => !focusStation || route.station === focusStation)
    .map(route => typeof route.dsp_name === 'string' ? route.dsp_name.trim() : '')
    .filter(Boolean))].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}
