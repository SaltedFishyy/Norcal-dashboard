import { difficultyColor, difficultyLevel } from './difficulty.js';
import { formatValue, formatNumber, formatUpdated, pageState, difficultyTone } from './format.js';
import { openRouteDetail } from './route-detail.js';

const updated = document.getElementById('updated');
const total = document.getElementById('total');
const rows = document.getElementById('rows');
const table = document.getElementById('table-container');
const message = document.getElementById('message');
const retry = document.getElementById('retry');
const profiles = document.getElementById('profiles');
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
  render(pageState({ loading: true }));
  try {
    const response = await fetch('/api/route-profiles?station=SFO01', { cache: 'no-store' });
    const data = await response.json();
    render(pageState({ status: response.status, data }), data);
  } catch {
    render(pageState({ failed: true }));
  }
}

retry.addEventListener('click', load);
void load();
