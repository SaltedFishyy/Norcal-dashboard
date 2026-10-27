import { difficultyColor, difficultyLevel } from './difficulty.js';
import { formatValue, formatNumber, formatUpdated, difficultyTone, profileText as t } from './format.js';

let sequence = 0;
let trigger;
let activeDialog;
const initialized = new WeakSet();
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
  document.getElementById('detail-title').textContent = formatValue(row.route_name);
  const showStatus = (...nodes) => content.replaceChildren(basicInfo(row, fetchedAt), ...nodes);
  showStatus(element('p', t.loading, 'detail-status'));
  content.setAttribute('aria-busy', 'true');
  if (!dialog.open) dialog.showModal();
  try {
    const response = await fetch(`/api/route-details?route_id=${encodeURIComponent(row.route_id)}`, { cache: 'no-store' });
    const data = await response.json();
    if (current !== sequence || options.isCurrent?.() === false) return;
    if (response.status === 200 && Array.isArray(data?.zips)) return renderDetail(content, data, row, fetchedAt, options.highlightZip);
    else if (response.status === 404 && data?.error === 'route_detail_not_found') {
      showStatus(element('p', t.noDetail, 'detail-status'), element('p', t.scrapeHint(row.station), 'detail-note'));
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
