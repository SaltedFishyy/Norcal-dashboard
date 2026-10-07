import { difficultyColor, difficultyLevel } from './difficulty.js';
import { formatValue, formatNumber, formatUpdated, pageState, difficultyTone } from './format.js';
import { openRouteDetail } from './route-detail.js';
import { chooseSelection, readSelection, saveSelection, populateDistricts, populateStations } from './station-preference.js';

const updated = document.getElementById('updated');
const total = document.getElementById('total');
const rows = document.getElementById('rows');
const table = document.getElementById('table-container');
const message = document.getElementById('message');
const retry = document.getElementById('retry');
const profiles = document.getElementById('profiles');
const stationSelect = document.getElementById('profile-station');
const districtSelect = document.getElementById('profile-district');
let districts = [], selected = {}, stationsLoaded = false, sequence = 0;
const columns = [
  ['route_name'], ['dsp_name'], ['pickup_volume', 'numeric', 0], ['pph', 'numeric', 2],
  ['first_mile_distance', 'numeric', 2], ['route_difficulty', 'difficulty'], ['route_difficulty_manual', 'difficulty'],
];

function render(result, data) {
  message.textContent = result.message;
  profiles.setAttribute('aria-busy', String(result.state === 'loading'));
  retry.hidden = result.state !== 'error' && result.state !== 'empty';
  table.hidden = result.state !== 'success';
  rows.replaceChildren();
  updated.textContent = '—';
  updated.removeAttribute('title');
  total.textContent = '—';
  if (result.state !== 'success' && !(result.state === 'empty' && data?.rows)) return;
  updated.textContent = formatUpdated(data.fetched_at);
  if (updated.textContent !== '—') updated.title = data.fetched_at;
  total.textContent = formatNumber(data.total);
  if (result.state !== 'success') return;
  const fragment = document.createDocumentFragment();
  for (const row of data.rows) {
    const tr = document.createElement('tr');
    for (const [field, style, digits] of columns) {
      const td = document.createElement('td');
      const value = row?.[field];
      if (style === 'numeric') td.className = 'numeric';
      const hasDifficulty = style === 'difficulty' && value !== null && value !== undefined && value !== '';
      const isRoute = field === 'route_name';
      const content = isRoute ? document.createElement('button') : hasDifficulty ? document.createElement('span') : td;
      if (isRoute) {
        content.type = 'button'; content.className = 'route-link';
        content.addEventListener('click', () => openRouteDetail(row, content, data.fetched_at)); td.append(content);
      }
      if (hasDifficulty) {
        content.className = field === 'route_difficulty_manual' ? `difficulty tone-${difficultyTone(value)}` : 'difficulty system-difficulty';
        if (field === 'route_difficulty') {
          const level = difficultyLevel(value);
          content.style.backgroundColor = difficultyColor(level);
          content.style.color = ['B', 'D', null].includes(level) ? '#0f172a' : '#ffffff';
        }
        td.append(content);
      }
      content.textContent = style === 'numeric' ? formatNumber(value, digits, digits) : formatValue(value);
      tr.append(td);
    }
    fragment.append(tr);
  }
  rows.append(fragment);
}

async function load() {
  const current = ++sequence;
  render(pageState({ loading: true }));
  if (!selected.station) { render({ state: 'empty', message: '暂无数据：该片区没有站点快照。' }); return; }
  try {
    const response = await fetch(`/api/route-profiles?station=${encodeURIComponent(stationSelect.value)}`, { cache: 'no-store' });
    const data = await response.json();
    if (current === sequence) render(pageState({ status: response.status, data }), data);
  } catch {
    if (current === sequence) render(pageState({ failed: true }));
  }
}

async function start() {
  const current = ++sequence;
  render(pageState({ loading: true })); stationSelect.disabled = true; districtSelect.disabled = true;
  try {
    const response = await fetch('/api/districts', { cache: 'no-store' });
    const data = await response.json();
    if (current !== sequence) return;
    if (response.status !== 200) { render(pageState({ status: response.status, data })); return; }
    districts = data.districts;
    const params = new URLSearchParams(globalThis.location?.search || '');
    selected = chooseSelection({ districts, urlDistrict: params.get('district'), urlStation: params.get('station'), saved: readSelection(undefined, districts) });
    populateDistricts(document, districtSelect, districts); districtSelect.value = selected.district;
    populateStations(document, stationSelect, districts.find(item => item.id === selected.district)); stationSelect.value = selected.station || '';
    stationsLoaded = true;
    await load();
  } catch { if (current === sequence) render(pageState({ failed: true })); }
}
stationSelect.addEventListener('change', () => {
  selected.station = stationSelect.value;
  saveSelection(undefined, selected);
  const dialog = document.getElementById('route-detail');
  if (dialog?.open) dialog.close();
  return load();
});
districtSelect.addEventListener('change', () => {
  selected = chooseSelection({ districts, urlDistrict: districtSelect.value, saved: selected });
  populateStations(document, stationSelect, districts.find(item => item.id === selected.district)); stationSelect.value = selected.station || '';
  saveSelection(undefined, selected);
  const dialog = document.getElementById('route-detail'); if (dialog?.open) dialog.close();
  return load();
});
retry.addEventListener('click', () => stationsLoaded && selected.station ? load() : start());
void start();
