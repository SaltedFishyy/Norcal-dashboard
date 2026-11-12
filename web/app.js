import { readViewDate, withViewDate, apiUrl, dateOptions, formatViewDate, syncNavLinks } from './date-view.js';
import { difficultyColor, difficultyLevel } from './difficulty.js';
import { formatValue, formatNumber, formatUpdated, formatPriceRange, pageState, difficultyTone, sortRows, dspOptions } from './format.js';
import { openPriceDetail } from './price-detail.js';
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
const dspSelect = document.getElementById('profile-dsp');
const dateSelect = document.getElementById('profile-date');
const dateField = document.getElementById('profile-date-field');
let viewDate = readViewDate(globalThis.location?.search || '');
let daysSequence = 0;
function updateDateView() {
  syncNavLinks(document, viewDate);
  const notice = document.getElementById('profile-date-notice');
  if (notice) notice.hidden = !viewDate;
  const text = document.getElementById('profile-date-text');
  if (text) text.textContent = viewDate ? `正在查看 ${formatViewDate(viewDate)} 的数据` : '';
  const price = document.getElementById('sort-price');
  if (price) price.title = '首票价格 0–1(lb) / Quotation for the First Parcel 0–1(lb)' + (viewDate ? ' · 当前报价' : '');
}
function setViewDate(date) {
  viewDate = date;
  if (globalThis.location && globalThis.history) history.replaceState(null, '', withViewDate(location.href, date));
  updateDateView();
}
async function loadDays() {
  if (!dateSelect) return;
  const current = ++daysSequence;
  dateSelect.disabled = true; dateField.hidden = true;
  if (!selected.station) return;
  try {
    const response = await fetch(apiUrl('/api/snapshot-days', { station: selected.station }), { cache: 'no-store' });
    const data = await response.json();
    if (current !== daysSequence) return;
    if (response.status !== 200 || data.available === false || !Array.isArray(data.days)) throw Error('unavailable');
    const options = dateOptions(data.days);
    if (viewDate && !options.some(item => item.value === viewDate)) options.push(dateOptions([{ day: viewDate, has_data: false }])[1]);
    dateSelect.replaceChildren();
    for (const item of options) {
      const option = document.createElement('option'); option.value = item.value; option.textContent = item.label; dateSelect.append(option);
    }
    dateSelect.value = viewDate || ''; dateSelect.disabled = false; dateField.hidden = false;
  } catch {
    if (current === daysSequence && viewDate) setViewDate(null);
  }
}
async function changeDate(date) {
  setViewDate(date); invalidateZip();
  const dialog = document.getElementById('route-detail'); if (dialog?.open) dialog.close();
  if (dateSelect) dateSelect.value = date || '';
  return load();
}
dateSelect?.addEventListener('change', () => changeDate(dateSelect.value || null));
document.getElementById('profile-date-latest')?.addEventListener('click', () => changeDate(null));
updateDateView();
let dsp = null;
let districts = [], selected = {}, stationsLoaded = false, sequence = 0;
let renderedData, pendingLoad, renderedRows = new Map(), zipSequence = 0;
const zipForm = document.getElementById('profile-zip-form');
const zipInput = document.getElementById('profile-zip');
const zipResult = document.getElementById('profile-zip-result');
const zipButton = zipForm?.querySelector('button');
let sort = { key: null, dir: 'desc' };
const sortControls = ['pickup_volume', 'pph', 'price'].map(key => ({ key, button: document.getElementById('sort-' + key) }));
function updateSortHeaders() {
  for (const { key, button } of sortControls) {
    if (!button) continue;
    const active = sort.key === key;
    button.parentNode.setAttribute('aria-sort', active ? (sort.dir === 'desc' ? 'descending' : 'ascending') : 'none');
    button.className = active ? 'sort-button active' : 'sort-button';
    button.querySelector('span').textContent = active ? (sort.dir === 'desc' ? '↓' : '↑') : '↕';
  }
}
for (const { key, button } of sortControls) button?.addEventListener('click', () => {
  sort = sort.key !== key ? { key, dir: 'desc' } : sort.dir === 'desc' ? { key, dir: 'asc' } : { key: null, dir: 'desc' };
  updateSortHeaders();
  if (renderedData) {
    const highlighted = [...renderedRows].find(([, target]) => target.tr.className === 'zip-target-row')?.[0];
    render(pageState({ status: 200, data: renderedData }), renderedData);
    if (highlighted) renderedRows.get(highlighted).tr.className = 'zip-target-row';
  }
});
updateSortHeaders();
const columns = [
  ['route_name'], ['dsp_name'], ['pickup_volume', 'numeric', 0], ['pph', 'numeric', 2],
  ['price'], ['first_mile_distance', 'numeric', 2], ['route_difficulty', 'difficulty'],
];

function render(result, data) {
  if (dspSelect) dspSelect.disabled = true;
  message.textContent = viewDate && data?.empty === true ? '该日无数据' : result.message;
  profiles.setAttribute('aria-busy', String(result.state === 'loading'));
  retry.hidden = result.state !== 'error' && result.state !== 'empty';
  table.hidden = result.state !== 'success';
  rows.replaceChildren();
  renderedData = undefined; renderedRows = new Map();
  updated.textContent = '—';
  updated.removeAttribute('title');
  total.textContent = '—';
  if (result.state !== 'success' && !(result.state === 'empty' && data?.rows)) return;
  updated.textContent = formatUpdated(data.fetched_at);
  if (updated.textContent !== '—') updated.title = data.fetched_at;
  const options = dspOptions(data.rows);
  if (!options.includes(dsp)) dsp = null;
  if (dspSelect) {
    dspSelect.replaceChildren();
    for (const name of ['', ...options]) {
      const option = document.createElement('option');
      option.value = name; option.textContent = name || '全部 DSP';
      dspSelect.append(option);
    }
    dspSelect.value = dsp || ''; dspSelect.disabled = false;
  }
  const visibleRows = data.rows.filter(row => dsp === null || (typeof row.dsp_name === 'string' && row.dsp_name.trim() === dsp));
  total.textContent = dsp === null ? formatNumber(data.total) : `${formatNumber(visibleRows.length)} / ${formatNumber(data.total)}`;
  renderedData = data;
  if (result.state !== 'success') return;
  const fragment = document.createDocumentFragment();
  for (const row of sortRows(visibleRows, sort)) {
    const tr = document.createElement('tr');
    tr.setAttribute('data-route-id', String(row.route_id));
    renderedRows.set(String(row.route_id), { row, tr });
    for (const [field, style, digits] of columns) {
      if (field === 'price') {
        const price = document.createElement('td'); price.className = 'numeric price-column';
        price.textContent = '—';
        if (row.quoted_zip_count > 0) {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'route-link price-link';
          button.textContent = formatPriceRange(row.current_first_0_1lb_price_min, row.current_first_0_1lb_price_max);
          button.addEventListener('click', () => openPriceDetail(row, button));
          price.textContent = ''; price.append(button);
        }
        tr.append(price);
        continue;
      }
      const td = document.createElement('td');
      const value = row?.[field];
      if (style === 'numeric') td.className = 'numeric';
      const hasDifficulty = style === 'difficulty' && value !== null && value !== undefined && value !== '';
      const isRoute = field === 'route_name';
      const content = isRoute ? document.createElement('button') : hasDifficulty ? document.createElement('span') : td;
      if (isRoute) {
        content.type = 'button'; content.className = 'route-link';
        renderedRows.get(String(row.route_id)).button = content;
        content.addEventListener('click', () => openRouteDetail(row, content, data.fetched_at, { date: viewDate })); td.append(content);
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

function load() {
  pendingLoad = loadProfiles();
  return pendingLoad;
}
function loadStation() {
  const current = ++sequence;
  render(pageState({ loading: true }));
  pendingLoad = (async () => {
    await loadDays();
    if (current === sequence) return loadProfiles();
  })();
  return pendingLoad;
}
async function loadProfiles() {
  const current = ++sequence;
  render(pageState({ loading: true }));
  if (!selected.station) { render({ state: 'empty', message: '暂无数据：该片区没有站点快照。' }); return; }
  try {
    const response = await fetch(apiUrl('/api/route-profiles', { station: stationSelect.value }, viewDate), { cache: 'no-store' });
    const data = await response.json();
    if (current === sequence) {
      render(pageState({ status: response.status, data }), data);
      return renderedData;
    }
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
    await loadStation();
  } catch { if (current === sequence) render(pageState({ failed: true })); }
}
async function switchTo({ district, station }) {
  selected = station === undefined
    ? chooseSelection({ districts, urlDistrict: district, saved: selected })
    : { district, station };
  districtSelect.value = selected.district;
  populateStations(document, stationSelect, districts.find(item => item.id === selected.district)); stationSelect.value = selected.station || '';
  saveSelection(undefined, selected);
  const dialog = document.getElementById('route-detail'); if (dialog?.open) dialog.close();
  return loadStation();
}
function invalidateZip() {
  zipSequence++;
  if (zipButton) zipButton.disabled = false;
  if (zipResult) { zipResult.replaceChildren(); zipResult.className = ''; }
}
stationSelect.addEventListener('change', () => {
  invalidateZip();
  return switchTo({ district: selected.district, station: stationSelect.value });
});
districtSelect.addEventListener('change', () => {
  invalidateZip();
  return switchTo({ district: districtSelect.value });
});

dspSelect?.addEventListener('change', () => {
  dsp = dspSelect.value || null;
  invalidateZip();
  clearZipHighlight();
  const dialog = document.getElementById('route-detail'); if (dialog?.open) dialog.close();
  if (renderedData) render(pageState({ status: 200, data: renderedData }), renderedData);
});

function zipFeedback(text, error = false) {
  zipResult.textContent = text;
  zipResult.className = error ? 'zip-error' : '';
}
function clearZipHighlight() {
  for (const { tr } of renderedRows.values()) tr.className = '';
}
async function locateZip(owner, data, zip, current) {
  if (current !== zipSequence) return;
  const district = districts.find(item => item.stations.some(item => item.code === owner.station));
  if (!district) { zipFeedback(`该 ZIP 属于 ${owner.station}，但当前片区配置中没有这个站点`); return; }
  if (selected.district !== district.id || selected.station !== owner.station) {
    await switchTo({ district: district.id, station: owner.station });
  } else await pendingLoad;
  if (current !== zipSequence) return;
  const row = renderedData?.rows.find(row => String(row.route_id) === String(owner.route_id));
  if (!row) { zipFeedback(viewDate ? '该日数据中找不到该线路' : '当前快照中找不到该线路'); return; }
  const parts = [`ZIP ${zip}`];
  for (const [label, value] of [['站点', owner.station], ['线路', owner.route_name], ['DSP', data.route?.dsp_name || data.dsp_name]]) {
    if (value !== null && value !== undefined && value !== '') parts.push(`${label} ${value}`);
  }
  if (data.status === 'covered_no_boundary') parts.push('有线路归属，但无地图边界');
  if (dsp !== null && (typeof row.dsp_name !== 'string' || row.dsp_name.trim() !== dsp)) {
    zipFeedback(`${parts.join(' · ')} · 不在当前 DSP 筛选（${dsp}）中`);
    const button = document.createElement('button'); button.type = 'button'; button.textContent = '显示该线路';
    button.addEventListener('click', async () => {
      if (current !== zipSequence) return;
      dsp = null; if (dspSelect) dspSelect.value = '';
      render(pageState({ status: 200, data: renderedData }), renderedData);
      await highlightZipRoute(owner.route_id, parts, zip, current);
    });
    zipResult.append(button);
    return;
  }
  await highlightZipRoute(owner.route_id, parts, zip, current);
}
async function highlightZipRoute(routeId, parts, zip, current) {
  if (current !== zipSequence) return;
  const target = renderedRows.get(String(routeId));
  if (!target) { zipFeedback(viewDate ? '该日数据中找不到该线路' : '当前快照中找不到该线路'); return; }
  clearZipHighlight();
  target.tr.className = 'zip-target-row';
  target.tr.scrollIntoView({ block: 'center' });
  zipFeedback(parts.join(' · '));
  const detail = await openRouteDetail(target.row, target.button, renderedData.fetched_at, {
    date: viewDate, highlightZip: zip, isCurrent: () => current === zipSequence,
  });
  if (current === zipSequence && detail?.highlightFound === false) {
    zipFeedback(`${parts.join(' · ')} · 该线路的 ZIP 明细中没有这个 ZIP`);
  }
}
zipForm?.addEventListener('submit', async event => {
  event.preventDefault();
  const current = ++zipSequence, zip = zipInput.value.trim();
  clearZipHighlight();
  const dialog = document.getElementById('route-detail');
  if (dialog?.open) dialog.close();
  zipButton.disabled = false;
  if (!/^\d{5}$/.test(zip)) { zipFeedback('请输入 5 位 ZIP', true); return; }
  zipButton.disabled = true; zipFeedback('查询中…');
  try {
    const response = await fetch(apiUrl('/api/route-map/zip', { postal_code: zip }, viewDate), { cache: 'no-store' });
    if (current !== zipSequence) return;
    if (response.status !== 200) throw new Error('zip_query_failed');
    const data = await response.json();
    if (current !== zipSequence) return;
    if (data.status === 'covered' || data.status === 'covered_no_boundary') await locateZip(data, data, zip, current);
    else if (data.status === 'multi_station') {
      zipFeedback('请选择站点和线路：');
      for (const owner of data.owners) {
        const button = document.createElement('button'); button.type = 'button';
        button.textContent = [owner.station, owner.route_name].filter(value => value !== null && value !== undefined && value !== '').join(' · ');
        button.addEventListener('click', async () => {
          if (current !== zipSequence) return;
          // Selecting an owner is a new intent; older in-flight locations cannot win.
          const choice = ++zipSequence;
          try { await locateZip(owner, data, zip, choice); }
          catch { if (choice === zipSequence) zipFeedback('ZIP 查询失败，请稍后重试', true); }
        });
        zipResult.append(button);
      }
    } else {
      const notices = {
        uncovered: '当前数据中未找到该 ZIP 的线路归属',
        no_boundary: '当前数据中未找到该 ZIP 的线路归属（该 ZIP 也没有地图边界）',
        out_of_range: '该 ZIP 不在当前数据覆盖的州范围内，未找到线路归属',
      };
      if (!Object.hasOwn(notices, data.status)) throw new Error('zip_query_failed');
      zipFeedback(notices[data.status]);
    }
  } catch { if (current === zipSequence) zipFeedback('ZIP 查询失败，请稍后重试', true); }
  finally { if (current === zipSequence) zipButton.disabled = false; }
});
retry.addEventListener('click', () => stationsLoaded && selected.station ? load() : start());
void start();
