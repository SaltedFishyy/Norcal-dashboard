import { apiUrl, formatViewDate } from './date-view.js';
import { difficultyColor, difficultyLevel } from './difficulty.js';
import { formatValue, formatNumber, formatUpdated, difficultyTone, profileText as t } from './format.js';

let sequence = 0;
let trigger;
let activeDialog;
const initialized = new WeakSet();
const historyViews = new WeakMap();
const codes = new Set(['invalid_route_id', 'route_detail_invalid', 'internal_error', 'not_found', 'method_not_allowed']);
const columns = [
  ['ZIP', 'postal_code'], [t.pickupDaily, 'pickup_volume_daily', 'pickup'],
  [t.experiencedPph, 'experienced_pph', 'number'], [t.zipDifficulty, 'postal_code_difficulty', 'difficulty'],
  [t.firstMile, 'first_mile_distance', 'number'],
];
const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
function difficulty(value, manual = false) {
  if (value === null || value === undefined || value === '') return element('span', '—');
  if (manual) return element('span', formatValue(value), `difficulty tone-${difficultyTone(value)}`);
  const node = element('span', formatValue(value), 'difficulty system-difficulty');
  const level = difficultyLevel(value);
  node.style.backgroundColor = difficultyColor(level);
  node.style.color = ['B', 'D', null].includes(level) ? '#0f172a' : '#ffffff';
  return node;
}
function basicInfo(row, fetchedAt, data) {
  const metrics = element('dl', undefined, 'metrics detail-metrics');
  const zipCount = data ? data.zip_count : Array.isArray(row.postal_codes) ? row.postal_codes.length : null;
  for (const [label, value, kind] of [
    [t.routeName, row.route_name], [t.routeId, row.route_id], [t.station, row.station], [t.dsp, row.dsp_name],
    [t.volume, row.pickup_volume, 'integer'], [t.pph, row.pph, 'number'],
    [t.firstMile, row.first_mile_distance, 'number'], [t.difficulty, row.route_difficulty, 'difficulty'],
    [t.manualDifficulty, row.route_difficulty_manual, 'manual'], [t.zipCount, zipCount, 'integer'],
    [t.profileUpdated, fetchedAt, 'date'], [t.detailUpdated, data?.fetched_at, 'date'],
  ]) {
    const item = element('div'), dd = element('dd');
    if (kind === 'difficulty' || kind === 'manual') dd.append(difficulty(value, kind === 'manual'));
    else dd.textContent = kind === 'date' ? formatUpdated(value)
      : kind === 'integer' ? formatNumber(value, 0, 0)
      : kind === 'number' ? formatNumber(value, 2, 2) : formatValue(value);
    if (kind === 'date' && dd.textContent !== '—') dd.title = value;
    item.append(element('dt', label), dd); metrics.append(item);
  }
  return metrics;
}
function renderDetail(content, data, row, fetchedAt, highlightZip) {
  let target;
  const metrics = basicInfo(row, fetchedAt, data);
  const scroll = element('div', undefined, 'detail-table-scroll');
  scroll.tabIndex = 0; scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', t.zipTable);
  const table = element('table'), head = element('thead'), header = element('tr'), body = element('tbody');
  table.append(element('caption', t.zipCaption, 'sr-only'));
  for (const [label, , kind] of columns) {
    const th = element('th', label, kind === 'number' || kind === 'pickup' ? 'numeric' : undefined);
    th.setAttribute('scope', 'col'); header.append(th);
  }
  head.append(header);
  const sortedZips = [...data.zips].sort((a, b) => {
    const aValid = typeof a.postal_code === 'string' && a.postal_code !== '';
    const bValid = typeof b.postal_code === 'string' && b.postal_code !== '';
    if (!aValid || !bValid) return Number(bValid) - Number(aValid);
    return a.postal_code < b.postal_code ? -1 : a.postal_code > b.postal_code ? 1 : 0;
  });
  for (const zip of sortedZips) {
    const tr = element('tr');
    if (highlightZip !== undefined && zip.postal_code === highlightZip) {
      tr.className = 'zip-target'; target ??= tr;
    }
    for (const [, field, kind] of columns) {
      const td = element('td');
      if (kind === 'difficulty') {
        if (zip[field] === null || zip[field] === undefined || zip[field] === '') td.textContent = '—';
        else td.append(difficulty(zip[field]));
      } else {
        td.textContent = kind === 'pickup' ? formatNumber(zip[field], 2, 0) : kind === 'number' ? formatNumber(zip[field], 2, 2) : formatValue(zip[field]);
        if (kind === 'number' || kind === 'pickup') td.className = 'numeric';
      }
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(head, body); scroll.append(table);
  content.replaceChildren(metrics, scroll, element('p', t.firstMileNote, 'detail-note'));
  target?.scrollIntoView({ block: 'center' });
  return { highlightFound: Boolean(target) };
}

export async function openRouteDetail(row, source = document.activeElement, fetchedAt, options = {}) {
  const dialog = document.getElementById('route-detail');
  const content = document.getElementById('detail-content');
  trigger = source; activeDialog = dialog;
  if (!initialized.has(dialog)) {
    initialized.add(dialog);
    const close = () => { sequence++; dialog.close(); };
    document.getElementById('detail-close').addEventListener('click', close);
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
    });
    dialog.addEventListener('close', () => {
      sequence++;
      if (activeDialog === dialog) { trigger?.focus(); activeDialog = undefined; }
    });
  }
  const current = ++sequence;
  setupHistory(dialog, content, row, current, options);
  document.getElementById('detail-title').textContent = formatValue(row.route_name);
  const dateNote = () => element('p', `${formatViewDate(options.date)} 的数据`, 'detail-note');
  const showStatus = (...nodes) => content.replaceChildren(...(options.date ? [dateNote()] : []), basicInfo(row, fetchedAt), ...nodes);
  showStatus(element('p', t.loading, 'detail-status'));
  content.setAttribute('aria-busy', 'true');
  if (!dialog.open) dialog.showModal();
  try {
    const response = await fetch(apiUrl('/api/route-details', { route_id: row.route_id }, options.date), { cache: 'no-store' });
    const data = await response.json();
    if (current !== sequence || options.isCurrent?.() === false) return;
    if (response.status === 200 && Array.isArray(data?.zips)) {
      const result = renderDetail(content, data, row, fetchedAt, options.highlightZip);
      if (options.date) content.replaceChildren(dateNote(), ...Array.from(content.children));
      return result;
    }
    else if (response.status === 404 && data?.error === 'route_detail_not_found') {
      if (options.date) showStatus(element('p', '该日没有这条线路的详情', 'detail-status'));
      else showStatus(element('p', t.noDetail, 'detail-status'), element('p', t.scrapeHint(row.station), 'detail-note'));
    } else {
      const code = codes.has(data?.error) ? data.error : 'internal_error';
      showStatus(element('p', t.detailError(code), 'detail-status'));
    }
  } catch {
    if (current === sequence) showStatus(element('p', t.detailNetworkError, 'detail-status'));
  } finally {
    if (current === sequence) content.setAttribute('aria-busy', 'false');
  }
}

export function summarizeMetric(points, key) {
  const known = points.filter(point => typeof point[key] === 'number' && Number.isFinite(point[key]))
    .slice().sort((a, b) => a.day.localeCompare(b.day));
  if (!known.length) return { current: null, current_day: null, avg: null, max: null, min: null, trend: null };
  const values = known.map(point => point[key]), current = values.at(-1);
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  const pct = avg === 0 ? null : (current - avg) / avg;
  const trend = values.length < 3 ? 'insufficient' : avg === 0 ? (current === 0 ? 'flat' : 'insufficient')
    : Math.abs(pct) <= .05 + Number.EPSILON ? 'flat' : { direction: pct > 0 ? 'up' : 'down', pct };
  return { current, current_day: known.at(-1).day, avg, max: Math.max(...values), min: Math.min(...values), trend };
}
const shortDay = day => day ? `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}` : '—';
const dayNumber = day => Date.parse(`${day}T00:00:00Z`) / 86400000;
function pacificToday() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}
function sparkline(points, key, days, end, changes, label) {
  const svg = document.createElementNS('http:' + '//www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 300 88'); svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${label}，最近 ${days} 天；缺失日期断开`);
  svg.setAttribute('class', 'rh-chart');
  const start = dayNumber(end) - days + 1, known = points.filter(p => Number.isFinite(p[key]));
  const values = known.map(p => p[key]), min = Math.min(...values), max = Math.max(...values);
  const x = day => 8 + (dayNumber(day) - start) / (days - 1) * 284;
  const y = value => max === min ? 44 : 76 - (value - min) / (max - min) * 64;
  const shape = (tag, attributes) => {
    const node = document.createElementNS('http:' + '//www.w3.org/2000/svg', tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
    svg.append(node);
  };
  for (const day of new Set(changes.map(change => change.day))) {
    if (dayNumber(day) >= start && dayNumber(day) <= dayNumber(end))
      shape('line', { x1: x(day), x2: x(day), y1: 6, y2: 82, class: 'rh-change-marker' });
  }
  const byDay = new Map(points.map(p => [dayNumber(p.day), p[key]]));
  let segment = [];
  const flush = () => {
    if (segment.length > 1) shape('polyline', { points: segment.join(' '), fill: 'none', stroke: 'currentColor', 'stroke-width': 2 });
    segment = [];
  };
  for (let day = start; day < start + days; day++) {
    const value = byDay.get(day), px = 8 + (day - start) / (days - 1) * 284;
    if (!Number.isFinite(value)) { flush(); continue; }
    segment.push(`${px},${y(value)}`);
    shape('circle', { cx: px, cy: y(value), r: 3, fill: 'currentColor' });
  }
  flush(); return svg;
}
function renderHistory(target, data, days, end) {
  const points = data.points, changes = data.changes ?? [];
  target.replaceChildren(element('p', `最近 ${days} 天中有 ${new Set(points.map(point => point.day)).size} 天数据`, 'detail-note'));
  const start = dayNumber(end) - days + 1;
  if (data.first_seen && dayNumber(data.first_seen) >= start && dayNumber(data.first_seen) <= dayNumber(end))
    target.append(element('p', `已有 ${points.length} 天数据`, 'detail-note'));
  if (data.last_seen && data.latest_day && data.last_seen < data.latest_day)
    target.append(element('p', `最近一次出现：${shortDay(data.last_seen)}`, 'detail-note'));
  if (data.former_names?.length) target.append(element('p', `曾用名：${data.former_names.join('、')}`, 'detail-note'));
  if (!points.length) { target.append(element('p', '暂无历史数据', 'detail-status')); return; }
  const cards = element('div', undefined, 'rh-cards');
  for (const [key, label, digits] of [['pickup_volume', '领件量', 0], ['pph', 'PPH', 2], ['first_mile_distance', '首公里距离 (mile)', 2], ['zip_count', 'ZIP 数量', 0]]) {
    const stats = summarizeMetric(points, key), card = element('section', undefined, 'rh-card');
    card.append(element('h3', label), element('p', `${formatNumber(stats.current, digits)} · ${shortDay(stats.current_day)}`, 'rh-current'));
    const list = element('dl');
    for (const [name, value, places] of [['平均', stats.avg, 1], ['最高', stats.max, digits], ['最低', stats.min, digits]]) {
      const item = element('div'); item.append(element('dt', name), element('dd', formatNumber(value, places, places))); list.append(item);
    }
    const trend = stats.trend;
    card.append(list, element('p', trend === 'flat' ? '持平' : !trend || trend === 'insufficient' ? '数据不足'
      : `${trend.direction === 'up' ? '↑' : '↓'} ${formatNumber(Math.abs(trend.pct) * 100, 0)}%`, 'rh-trend'), sparkline(points, key, days, end, changes, label));
    cards.append(card);
  }
  target.append(cards);
  if (changes.length) {
    const section = element('section', undefined, 'rh-changes'), list = element('ul');
    section.append(element('h3', '变化记录'));
    for (const change of changes) list.append(element('li', `${shortDay(change.day)} ${change.field === 'zip_set'
      ? `ZIP +${change.added} / −${change.removed}` : `${change.field === 'dsp_name' ? 'DSP' : '难度'} ${formatValue(change.from)} → ${formatValue(change.to)}`}`));
    section.append(list); target.append(section);
  }
}
function setupHistory(dialog, overview, row, opening, options) {
  let view = historyViews.get(dialog);
  if (!view) {
    const tabs = element('div', undefined, 'rh-tabs'), history = element('div');
    tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '线路详情');
    const buttons = ['概况', '历史'].map((label, i) => {
      const button = element('button', label); button.type = 'button'; button.id = `detail-tab-${i}`;
      button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', i ? 'detail-history' : 'detail-content'); tabs.append(button); return button;
    });
    history.id = 'detail-history'; history.setAttribute('aria-live', 'polite');
    for (const [panel, i] of [[overview, 0], [history, 1]]) {
      panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', `detail-tab-${i}`);
    }
    // Keep the existing overview subtree intact, including its scroll and highlight state.
    if (dialog.insertBefore) dialog.insertBefore(tabs, overview); else dialog.append(tabs);
    dialog.append(history);
    view = { buttons, history }; historyViews.set(dialog, view);
  }
  let days = 7, loaded = false, request = 0;
  const end = pacificToday(), { buttons, history } = view;
  const controls = element('div', undefined, 'rh-period'), body = element('div');
  controls.setAttribute('role', 'group'); controls.setAttribute('aria-label', '历史时间窗口');
  const periods = [7, 30].map(value => {
    const button = element('button', `${value} 天`); button.type = 'button'; controls.append(button);
    button.addEventListener('click', () => { days = value; return load(); }); return button;
  });
  history.replaceChildren(controls, body);
  const valid = token => opening === sequence && token === request && options.isCurrent?.() !== false;
  async function read(value) {
    const response = await fetch(`/api/route-history?route_id=${encodeURIComponent(row.route_id)}&days=${value}`, { cache: 'no-store' });
    const data = await response.json();
    if (response.status !== 200 || (data.available !== false && !Array.isArray(data.points))) throw new Error('internal_error');
    return data;
  }
  async function load() {
    const token = ++request, selected = days;
    periods.forEach((button, i) => button.setAttribute('aria-pressed', String([7, 30][i] === days)));
    body.replaceChildren(element('p', t.loading, 'detail-status')); body.setAttribute('aria-busy', 'true');
    try {
      const data = await read(selected);
      if (!valid(token)) return;
      if (data.available === false) body.replaceChildren(element('p', '当前数据源不支持历史', 'detail-status'));
      else renderHistory(body, data, selected, end);
      loaded = true;
    } catch {
      if (valid(token)) body.replaceChildren(element('p', '无法加载线路历史 (server_unreachable)。', 'detail-status'));
    } finally { if (valid(token)) body.setAttribute('aria-busy', 'false'); }
  }
  function select(index) {
    overview.hidden = index !== 0; history.hidden = index !== 1;
    buttons.forEach((button, i) => { button.setAttribute('aria-selected', String(i === index)); button.tabIndex = i === index ? 0 : -1; });
    if (index === 1 && !loaded) return load();
  }
  buttons.forEach((button, index) => {
    button.onclick = () => select(index);
    button.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault(); const next = 1 - index; buttons[next].focus(); return select(next);
    };
  });
  select(0);
}
