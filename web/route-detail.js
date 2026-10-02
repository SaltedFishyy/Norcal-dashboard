import { formatValue, formatNumber, formatPercent, formatUpdated, difficultyTone } from './format.js';

let sequence = 0;
let trigger;
let activeDialog;
const initialized = new WeakSet();
const codes = new Set(['invalid_route_id', 'route_detail_invalid', 'internal_error', 'not_found', 'method_not_allowed']);
const columns = [
  ['ZIP', 'postal_code'], ['ZIP Difficulty', 'postal_code_difficulty', 'difficulty'],
  ['First-mile Distance (mi)', 'first_mile_distance', 'number'], ['Experienced PPH', 'experienced_pph', 'number'],
  ['Delivery Exception Rate', 'delivery_fail_rate', 'percent'], ['DNR Rate', 'dnr_rate', 'percent'], ['Safety Level', 'safety_level'],
];
const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
function difficulty(value) {
  if (value === null || value === undefined || value === '') return element('span', '—');
  return element('span', formatValue(value), `difficulty tone-${difficultyTone(value)}`);
}
function renderDetail(content, data, row) {
  const metrics = element('dl', undefined, 'metrics detail-metrics');
  for (const [label, value, kind] of [
    ['Route Name', data.route_name], ['Route Difficulty', data.route_difficulty, 'difficulty'],
    ['ZIP Count', data.zip_count], ['DSP / Fleet', row.dsp_name], ['Last Updated', data.fetched_at, 'date'],
  ]) {
    const item = element('div'), dd = element('dd');
    if (kind === 'difficulty') dd.append(difficulty(value));
    else dd.textContent = kind === 'date' ? formatUpdated(value) : formatValue(value);
    if (kind === 'date' && dd.textContent !== '—') dd.title = value;
    item.append(element('dt', label), dd); metrics.append(item);
  }
  const scroll = element('div', undefined, 'detail-table-scroll');
  scroll.tabIndex = 0; scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', 'ZIP profile table');
  const table = element('table'), head = element('thead'), header = element('tr'), body = element('tbody');
  table.append(element('caption', 'ZIP profiles in ascending ZIP order', 'sr-only'));
  for (const [label, , kind] of columns) {
    const th = element('th', label, kind === 'number' || kind === 'percent' ? 'numeric' : undefined);
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
    for (const [, field, kind] of columns) {
      const td = element('td');
      if (kind === 'difficulty') {
        if (zip[field] === null || zip[field] === undefined || zip[field] === '') td.textContent = '—';
        else td.append(difficulty(zip[field]));
      } else {
        td.textContent = kind === 'percent' ? formatPercent(zip[field]) : kind === 'number' ? formatNumber(zip[field], 2, 2) : formatValue(zip[field]);
        if (kind === 'number' || kind === 'percent') td.className = 'numeric';
      }
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(head, body); scroll.append(table);
  content.replaceChildren(metrics, scroll, element('p', 'First-mile distance is the route-level value, repeated for each ZIP.', 'detail-note'));
}

export async function openRouteDetail(row, source = document.activeElement) {
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
  content.replaceChildren(element('p', 'Loading route detail…', 'detail-status'));
  content.setAttribute('aria-busy', 'true');
  if (!dialog.open) dialog.showModal();
  try {
    const response = await fetch(`/api/route-details?route_id=${encodeURIComponent(row.route_id)}`, { cache: 'no-store' });
    const data = await response.json();
    if (current !== sequence) return;
    if (response.status === 200 && Array.isArray(data?.zips)) renderDetail(content, data, row);
    else if (response.status === 404 && data?.error === 'route_detail_not_found') {
      content.replaceChildren(element('p', `No detail yet for ${formatValue(row.route_name)}. Run npm run dms:scrape-route-detail -- --route ${formatValue(row.route_name)} to fetch it.`, 'detail-status'));
    } else {
      const code = codes.has(data?.error) ? data.error : 'internal_error';
      content.replaceChildren(element('p', `Could not load route detail (${code}).`, 'detail-status'));
    }
  } catch {
    if (current === sequence) content.replaceChildren(element('p', 'Cannot reach the local server (server_unreachable).', 'detail-status'));
  } finally {
    if (current === sequence) content.setAttribute('aria-busy', 'false');
  }
}
