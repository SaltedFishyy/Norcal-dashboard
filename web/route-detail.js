import { apiUrl, formatViewDate } from './date-view.js';
import { routeColor } from './route-colors.js';
import { openPriceDetail } from './price-detail.js';
import { difficultyColor, difficultyLevel } from './difficulty.js';
import { formatValue, formatNumber, formatUpdated, formatPriceRange, difficultyTone, profileText as t } from './format.js';

let sequence = 0;
const historyViews = new WeakMap();
const visibleCharts = new Set();
const hideChartTips = () => { for (const hide of visibleCharts) hide(); };
const codes = new Set(['invalid_route_id', 'route_detail_invalid', 'internal_error', 'not_found', 'method_not_allowed']);
const columns = [
  ['ZIP', 'postal_code'], [t.pickupDaily, 'pickup_volume_daily', 'pickup'],
  [t.experiencedPph, 'experienced_pph', 'number'], [t.zipDifficulty, 'postal_code_difficulty', 'difficulty'],
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
function renderHeading(row, data, options) {
  document.getElementById('detail-title').textContent = formatValue(row.route_name);
  document.getElementById('detail-swatch').style.backgroundColor = routeColor(row.route_id);
  document.getElementById('detail-difficulty').replaceChildren(difficulty(row.route_difficulty));
  const zipCount = data ? data.zip_count : Array.isArray(row.postal_codes) ? row.postal_codes.length : null;
  document.getElementById('detail-summary').textContent = `${formatValue(row.station)} · ${formatValue(row.dsp_name)} · Route ID ${formatValue(row.route_id)} · ${formatNumber(zipCount, 0)} 个 ZIP${options.date ? ` · ${formatViewDate(options.date)} 的数据` : ''}`;
}
function metricCards(row, options) {
  const cards = element('dl', undefined, 'pl-metrics');
  const trends = new Map();
  for (const [key, label, digits] of [
    ['pickup_volume', t.volume, 0], ['pph', t.pph, 2], ['first_mile_distance', t.firstMile, 2],
    ['price', t.firstPrice], ['manual', t.manualDifficulty],
  ]) {
    const card = element('div', undefined, 'pl-metric'), value = element('dd');
    card.append(element('dt', label), value);
    if (key === 'price') {
      if (row.quoted_zip_count > 0) {
        const button = element('button', formatPriceRange(row.current_first_0_1lb_price_min, row.current_first_0_1lb_price_max), 'price-link');
        button.type = 'button'; button.addEventListener('click', () => openPriceDetail(row, button)); value.append(button);
      } else value.textContent = '—';
      if (options.date) card.append(element('small', t.currentQuote, 'detail-note'));
    } else if (key === 'manual') value.append(difficulty(row.route_difficulty_manual, true));
    else value.textContent = formatNumber(row[key], digits, digits);
    if (key === 'pickup_volume' || key === 'pph') {
      card.className += ' pl-metric-key';
      const trend = element('small', '', 'rh-trend'); trend.hidden = true; card.append(trend); trends.set(key, trend);
    }
    cards.append(card);
  }
  return { cards, trends };
}
function updatedFooter(fetchedAt, data) {
  const footer = element('footer', undefined, 'pl-updated');
  for (const [label, time] of [[t.profileUpdated, fetchedAt], [t.detailUpdated, data?.fetched_at]]) {
    const node = element('span', `${label}：${formatUpdated(time)}`);
    if (formatUpdated(time) !== '—') node.title = time;
    footer.append(node);
  }
  return footer;
}
function renderDetail(content, data, highlightZip) {
  let target;
  const scroll = element('div', undefined, 'detail-table-scroll');
  scroll.tabIndex = 0; scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', t.zipTable);
  const table = element('table'), head = element('thead'), header = element('tr'), body = element('tbody');
  table.append(element('caption', t.zipCaption, 'sr-only'));
  for (const [label, , kind] of columns) {
    const th = element('th', label, kind === 'number' || kind === 'pickup' ? 'numeric' : undefined);
    th.setAttribute('scope', 'col'); header.append(th);
  }
  head.append(header);
  const maximum = Math.max(0, ...data.zips.map(zip => Number.isFinite(zip.pickup_volume_daily) ? zip.pickup_volume_daily : 0));
  const sortedZips = [...data.zips].sort((a, b) => {
    const av = a.pickup_volume_daily, bv = b.pickup_volume_daily;
    if (Number.isFinite(av) !== Number.isFinite(bv)) return Number.isFinite(av) ? -1 : 1;
    if (Number.isFinite(av) && av !== bv) return bv - av;
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
        if (kind === 'pickup' && Number.isFinite(zip[field])) {
          const track = element('span', undefined, 'pl-zip-bar-track'), bar = element('span', undefined, 'pl-zip-bar');
          bar.style.width = `${maximum > 0 ? zip[field] / maximum * 100 : 0}%`;
          track.setAttribute('aria-hidden', 'true'); track.append(bar);
          td.replaceChildren(track, element('span', td.textContent));
        }
      }
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(head, body); scroll.append(table);
  content.replaceChildren(scroll);
  target?.scrollIntoView({ block: 'center' });
  return { highlightFound: Boolean(target) };
}

// Invalidate both overview and history requests before clearing the persistent panel.
export function clearRouteDetail(message = t.empty) {
  hideChartTips();
  sequence++;
  const panel = document.getElementById('route-detail');
  const view = historyViews.get(panel);
  if (view) {
    view.buttons.forEach(button => { button.onclick = null; button.onkeydown = null; });
    view.history.hidden = true;
    view.buttons[0].parentNode?.setAttribute('hidden', '');
  }
  document.getElementById('detail-title').textContent = '线路详情';
  document.getElementById('detail-summary').textContent = '';
  document.getElementById('detail-difficulty').replaceChildren();
  document.getElementById('detail-swatch').style.backgroundColor = 'transparent';
  const content = document.getElementById('detail-content');
  content.hidden = false;
  content.setAttribute('aria-busy', 'false');
  content.replaceChildren(element('p', message, 'detail-status'));
}

export async function openRouteDetail(row, source = document.activeElement, fetchedAt, options = {}) {
  hideChartTips();
  const panel = document.getElementById('route-detail');
  const content = document.getElementById('detail-content');
  const current = ++sequence;
  renderHeading(row, undefined, options);
  const { cards, trends } = metricCards(row, options);
  const trendSection = element('section', undefined, 'pl-card pl-overview-trend');
  const trendBody = element('div');
  trendBody.replaceChildren(element('p', t.loading, 'detail-status'));
  trendSection.append(element('h3', t.recentTrend), trendBody);
  const zipSection = element('section', undefined, 'pl-card pl-zips'), zipBody = element('div');
  zipSection.append(element('h3', t.zipTable), zipBody);
  const grid = element('div', undefined, 'pl-overview-grid'); grid.append(trendSection, zipSection);
  const footer = updatedFooter(fetchedAt);
  content.replaceChildren(cards, grid, footer);
  setupHistory(panel, content, row, current, options, trendBody, trends);
  const showStatus = (...nodes) => zipBody.replaceChildren(...nodes);
  showStatus(element('p', t.loading, 'detail-status'));
  content.setAttribute('aria-busy', 'true');
  try {
    const response = await fetch(apiUrl('/api/route-details', { route_id: row.route_id }, options.date), { cache: 'no-store' });
    const data = await response.json();
    if (current !== sequence || options.isCurrent?.() === false) return;
    if (response.status === 200 && Array.isArray(data?.zips)) {
      renderHeading(row, data, options);
      footer.replaceChildren(...Array.from(updatedFooter(fetchedAt, data).children));
      const result = renderDetail(zipBody, data, options.highlightZip);
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
    if (current === sequence && options.isCurrent?.() !== false) showStatus(element('p', t.detailNetworkError, 'detail-status'));
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
  const container = element('div', undefined, 'pl-chart-container');
  const tooltip = element('div', '', 'pl-chart-tooltip');
  tooltip.hidden = true;
  tooltip.setAttribute('aria-live', 'polite');
  tooltip.setAttribute('aria-atomic', 'true');
  const svg = document.createElementNS('http:' + '//www.w3.org/2000/svg', 'svg');
  svg.setAttribute('tabindex', '0');
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
    return node;
  };
  for (const day of new Set(changes.map(change => change.day))) {
    if (dayNumber(day) >= start && dayNumber(day) <= dayNumber(end))
      shape('line', { x1: x(day), x2: x(day), y1: 6, y2: 82, class: 'rh-change-marker' });
  }
  const byDay = new Map(points.map(p => [dayNumber(p.day), p[key]]));
  let segment = [];
  const circles = new Map();
  const flush = () => {
    if (segment.length > 1) shape('polyline', { points: segment.join(' '), fill: 'none', stroke: 'currentColor', 'stroke-width': 2 });
    segment = [];
  };
  for (let day = start; day < start + days; day++) {
    const value = byDay.get(day), px = 8 + (day - start) / (days - 1) * 284;
    if (!Number.isFinite(value)) { flush(); continue; }
    segment.push(`${px},${y(value)}`);
    circles.set(day, shape('circle', { cx: px, cy: y(value), r: 3, fill: 'currentColor' }));
  }
  flush();
  const guide = shape('line', { y1: 6, y2: 82, class: 'pl-chart-guide', visibility: 'hidden' });
  // Reuse the plotted circles: missing-day segments and their coordinates stay intact.
  const validDays = [...byDay.keys()].filter(day => day >= start && day < start + days && Number.isFinite(byDay.get(day))).sort((a, b) => a - b);
  let selected = null, highlighted;
  const hide = () => {
    tooltip.hidden = true; tooltip.textContent = '';
    guide.setAttribute('visibility', 'hidden'); highlighted?.setAttribute('r', '3');
    highlighted = undefined; selected = null;
    document.removeEventListener('pointerdown', outside, true);
    visibleCharts.delete(hide);
  };
  const outside = event => { if (!container.contains(event.target)) hide(); };
  const geometry = () => {
    const rect = svg.getBoundingClientRect(), scale = Math.min(rect.width / 300, rect.height / 88);
    return { rect, scale, left: (rect.width - 300 * scale) / 2, top: (rect.height - 88 * scale) / 2 };
  };
  const show = day => {
    if (!Number.isFinite(byDay.get(day))) { hide(); return; }
    const date = new Date(day * 86400000).toISOString().slice(0, 10), px = x(date);
    highlighted?.setAttribute('r', '3');
    highlighted = circles.get(day); highlighted?.setAttribute('r', '5');
    selected = day;
    guide.setAttribute('x1', px); guide.setAttribute('x2', px); guide.setAttribute('visibility', 'visible');
    const metric = chartMetrics[key];
    tooltip.replaceChildren(element('div', shortDay(date)), element('div', `${metric.prefix}${formatNumber(byDay.get(day), metric.digits)}${metric.suffix}`));
    const dailyChanges = changes.filter(change => change.day === date);
    if (dailyChanges.length) tooltip.append(element('div', dailyChanges.map(formatHistoryChange).join('；')));
    tooltip.hidden = false;
    const { scale, left, top } = geometry();
    const width = container.getBoundingClientRect().width, height = container.getBoundingClientRect().height;
    const pointX = left + px * scale, pointY = top + y(byDay.get(day)) * scale;
    tooltip.style.left = `${Math.max(0, Math.min(pointX + 10, width - tooltip.offsetWidth))}px`;
    tooltip.style.top = `${Math.max(0, Math.min(pointY + 10, height - tooltip.offsetHeight))}px`;
    visibleCharts.add(hide);
    document.addEventListener('pointerdown', outside, true);
  };
  const atPointer = event => {
    const { rect, scale, left } = geometry();
    if (scale <= 0) return;
    const px = (event.clientX - rect.left - left) / scale;
    show(start + Math.max(0, Math.min(days - 1, Math.round((px - 8) / 284 * (days - 1)))));
  };
  svg.addEventListener('pointermove', atPointer);
  svg.addEventListener('pointerdown', event => { if (['touch', 'pen'].includes(event.pointerType)) atPointer(event); });
  svg.addEventListener('pointerleave', event => { if (!['touch', 'pen'].includes(event.pointerType)) hide(); });
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', event => {
    if (event.key === 'Escape') { hide(); return; }
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || !validDays.length) return;
    event.preventDefault();
    const index = selected === null ? (event.key === 'ArrowRight' ? 0 : validDays.length - 1)
      : Math.max(0, Math.min(validDays.length - 1, validDays.indexOf(selected) + (event.key === 'ArrowRight' ? 1 : -1)));
    show(validDays[index]);
  });
  container.append(svg, tooltip);
  return container;
}
const chartMetrics = {
  pickup_volume: { digits: 0, prefix: '', suffix: ' 件' },
  pph: { digits: 2, prefix: 'PPH ', suffix: '' },
  first_mile_distance: { digits: 2, prefix: '', suffix: ' mi' },
  zip_count: { digits: 0, prefix: '', suffix: ' 个 ZIP' },
};
function formatHistoryChange(change) {
  return change.field === 'zip_set' ? `ZIP +${change.added} / −${change.removed}`
    : `${change.field === 'dsp_name' ? 'DSP' : '难度'} ${formatValue(change.from)} → ${formatValue(change.to)}`;
}
function trendText(trend) {
  return trend === 'flat' ? '持平' : !trend || trend === 'insufficient' ? '数据不足'
    : `${trend.direction === 'up' ? '↑' : '↓'} ${formatNumber(Math.abs(trend.pct) * 100, 0)}%`;
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
    card.append(list, element('p', trendText(trend), 'rh-trend'), sparkline(points, key, days, end, changes, label));
    cards.append(card);
  }
  target.append(cards);
  if (changes.length) {
    const section = element('section', undefined, 'rh-changes'), list = element('ul');
    section.append(element('h3', '变化记录'));
    for (const change of changes) list.append(element('li', `${shortDay(change.day)} ${formatHistoryChange(change)}`));
    section.append(list); target.append(section);
  }
}
function setupHistory(panel, overview, row, opening, options, trendBody, trends) {
  let view = historyViews.get(panel);
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
    if (panel.insertBefore) panel.insertBefore(tabs, overview); else panel.append(tabs);
    panel.append(history);
    view = { buttons, history }; historyViews.set(panel, view);
  }
  view.buttons[0].parentNode?.removeAttribute('hidden');
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
  // A per-selection promise shares even an in-flight 30-day request. Errors are
  // retained for this selection too, so switching tabs cannot duplicate it.
  const thirtyDays = read(30).then(data => ({ data }), () => ({ failed: true }));
  void thirtyDays.then(({ data, failed }) => {
    if (opening !== sequence || options.isCurrent?.() === false) return;
    if (failed || data.available === false) {
      trendBody.replaceChildren(element('p', failed ? '无法加载线路历史 (server_unreachable)。' : '当前数据源不支持历史', 'detail-status'));
      return;
    }
    const charts = element('div', undefined, 'pl-trend-charts');
    for (const [key, label] of [['pickup_volume', t.volume], ['pph', t.pph]]) {
      const chart = element('section');
      chart.append(element('h4', label), sparkline(data.points, key, 30, end, data.changes ?? [], label)); charts.append(chart);
      const trend = trends.get(key); trend.textContent = trendText(summarizeMetric(data.points, key).trend); trend.hidden = false;
    }
    trendBody.replaceChildren(charts);
  });
  async function load() {
    hideChartTips();
    const token = ++request, selected = days;
    periods.forEach((button, i) => button.setAttribute('aria-pressed', String([7, 30][i] === days)));
    body.replaceChildren(element('p', t.loading, 'detail-status')); body.setAttribute('aria-busy', 'true');
    try {
      const result = selected === 30 ? await thirtyDays : { data: await read(selected) };
      if (result.failed) throw new Error('server_unreachable');
      const data = result.data;
      if (!valid(token)) return;
      if (data.available === false) body.replaceChildren(element('p', '当前数据源不支持历史', 'detail-status'));
      else renderHistory(body, data, selected, end);
      loaded = true;
    } catch {
      if (valid(token)) body.replaceChildren(element('p', '无法加载线路历史 (server_unreachable)。', 'detail-status'));
    } finally { if (valid(token)) body.setAttribute('aria-busy', 'false'); }
  }
  function select(index) {
    hideChartTips();
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
