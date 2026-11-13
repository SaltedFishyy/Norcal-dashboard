import { readViewDate, withViewDate, apiUrl, dateOptions, formatViewDate, syncNavLinks } from './date-view.js';
import { difficultyColor, difficultyLevel } from './difficulty.js';
import { formatValue, formatNumber, formatUpdated, formatPriceRange, pageState, profileText, sortRows, dspOptions } from './format.js';
import { routeColor } from './route-colors.js';
import { openRouteDetail, clearRouteDetail } from './route-detail.js';
import { chooseSelection, readSelection, saveSelection, populateDistricts, populateStations } from './station-preference.js';

const updated = document.getElementById('updated');
const total = document.getElementById('total');
const rows = document.getElementById('profile-routes');
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
  setViewDate(date); invalidateZip(); localFilter = ''; if (zipInput) zipInput.value = '';
  clearRouteDetail();
  if (dateSelect) dateSelect.value = date || '';
  return load();
}
dateSelect?.addEventListener('change', () => changeDate(dateSelect.value || null));
document.getElementById('profile-date-latest')?.addEventListener('click', () => changeDate(null));
updateDateView();
let dsp = null;
let districts = [], selected = {}, stationsLoaded = false, sequence = 0;
let renderedData, pendingLoad, renderedRows = new Map(), zipSequence = 0;
let selectedRoute = null, localFilter = '', highlightedRoute = null;
let detailZip = null, detailNeedsRefresh = false;
const zipForm = document.getElementById('profile-zip-form');
const zipInput = document.getElementById('profile-zip');
const zipResult = document.getElementById('profile-zip-result');
const zipButton = zipForm?.querySelector('button');
let sort = { key: null, dir: 'desc' };
const sortControls = [null, 'pickup_volume', 'pph', 'price', 'route_difficulty'].map(key => ({ key, button: document.getElementById('sort-' + (key || 'name')) }));
function updateSortHeaders() {
  for (const { key, button } of sortControls) {
    if (!button) continue;
    const active = sort.key === key;
    button.setAttribute('aria-pressed', String(active));
    button.className = active ? 'sort-button active' : 'sort-button';
    button.querySelector('span').textContent = active && key ? (sort.dir === 'desc' ? '↓' : '↑') : '';
  }
}
for (const { key, button } of sortControls) button?.addEventListener('click', () => {
  sort = sort.key !== key ? { key, dir: 'desc' } : sort.dir === 'desc' ? { key, dir: 'asc' } : { key: null, dir: 'desc' };
  updateSortHeaders();
  if (renderedData) {
    render(pageState({ status: 200, data: renderedData }), renderedData);
  }
});
updateSortHeaders();
function node(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}
function syncSelection() {
  for (const [id, { button }] of renderedRows) button.setAttribute('aria-pressed', String(id === selectedRoute));
}
function selectRoute(id, options = {}) {
  const target = renderedRows.get(String(id));
  if (!target) return;
  const changed = selectedRoute !== String(id);
  selectedRoute = String(id); syncSelection();
  if (globalThis.matchMedia?.('(max-width: 750px)').matches) {
    // Keep automatic selections inside the list without moving the page.
    const listRect = rows.getBoundingClientRect(), rowRect = target.button.getBoundingClientRect();
    if (rowRect.top < listRect.top) rows.scrollTop += rowRect.top - listRect.top;
    else if (rowRect.bottom > listRect.bottom) rows.scrollTop += rowRect.bottom - listRect.bottom;
  } else target.button.scrollIntoView({ block: 'nearest' });
  if (changed || detailNeedsRefresh || options.highlightZip) {
    detailNeedsRefresh = false; detailZip = options.highlightZip || null;
    return openRouteDetail(target.row, target.button, renderedData.fetched_at, { date: viewDate, ...options });
  }
}
zipInput?.addEventListener('input', () => {
  localFilter = zipInput.value.trim().toLowerCase();
  invalidateZip(); clearZipHighlight();
  if (renderedData) render(pageState({ status: 200, data: renderedData }), renderedData);
});

function render(result, data) {
  if (dspSelect) dspSelect.disabled = true;
  message.textContent = viewDate && data?.empty === true ? '该日无数据' : result.message;
  profiles.setAttribute('aria-busy', String(result.state === 'loading'));
  retry.hidden = result.state !== 'error' && result.state !== 'empty';
  rows.replaceChildren();
  renderedData = undefined; renderedRows = new Map();
  updated.textContent = '—';
  updated.removeAttribute('title');
  total.textContent = '—';
  if (result.state !== 'success') {
    selectedRoute = null; highlightedRoute = null;
    clearRouteDetail(message.textContent);
    if (!(result.state === 'empty' && data?.rows)) return;
  }
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
  const dspRows = data.rows.filter(row => dsp === null || (typeof row.dsp_name === 'string' && row.dsp_name.trim() === dsp));
  const visibleRows = dspRows.filter(row => !localFilter || String(row.route_name || '').toLowerCase().includes(localFilter)
    || row.postal_codes?.some(zip => String(zip).startsWith(localFilter)));
  total.textContent = (dsp === null ? formatNumber(data.total) : `${formatNumber(dspRows.length)} / ${formatNumber(data.total)}`) + ' 条';
  renderedData = data;
  if (result.state !== 'success') return;
  const fragment = document.createDocumentFragment();
  const maxVolume = Math.max(0, ...visibleRows.map(row => Number.isFinite(row.pickup_volume) ? row.pickup_volume : 0));
  for (const row of sortRows(visibleRows, sort)) {
    const id = String(row.route_id), color = routeColor(row.route_id);
    const button = node('button', undefined, 'profile-route'); button.type = 'button';
    button.setAttribute('data-route-id', id);
    const swatch = node('span', undefined, 'profile-route-swatch'); swatch.style.backgroundColor = color;
    const info = node('span', undefined, 'profile-route-info');
    const owner = [formatValue(row.dsp_name), `${formatNumber(Array.isArray(row.postal_codes) ? row.postal_codes.length : null)} ZIP`];
    if (row.quoted_zip_count > 0) owner.push(formatPriceRange(row.current_first_0_1lb_price_min, row.current_first_0_1lb_price_max));
    info.append(node('strong', formatValue(row.route_name), 'profile-route-title'), node('small', owner.join(' · '), 'profile-route-owner'));
    const values = node('span', undefined, 'profile-route-values');
    for (const [value, label, className] of [[formatNumber(row.pph, 2, 2), 'PPH', 'profile-route-pph'], [formatNumber(row.pickup_volume, 0, 0), '件', 'profile-route-pickup']]) {
      const metric = node('span', value, className); metric.append(node('small', label)); values.append(metric);
    }
    const level = difficultyLevel(row.route_difficulty), badge = node('span', level || '—', 'profile-route-difficulty');
    badge.style.backgroundColor = difficultyColor(level); badge.style.color = ['B', 'D', null].includes(level) ? '#0f172a' : '#ffffff';
    badge.title = formatValue(row.route_difficulty);
    const bar = node('span', undefined, 'profile-route-volume'); bar.setAttribute('aria-hidden', 'true');
    bar.style.width = `${maxVolume > 0 && Number.isFinite(row.pickup_volume) ? Math.max(0, row.pickup_volume) / maxVolume * 100 : 0}%`;
    bar.style.backgroundColor = color;
    button.append(swatch, info, values, badge, bar);
    if (id === highlightedRoute) button.className += ' zip-target-row';
    renderedRows.set(id, { row, button });
    button.addEventListener('click', () => {
      invalidateZip(); clearZipHighlight();
      const detail = selectRoute(id);
      if (globalThis.matchMedia?.('(max-width: 750px)').matches) {
        document.querySelector('.profile-detail-pane').scrollIntoView({
          block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
        });
      }
      return detail;
    });
    fragment.append(button);
  }
  rows.append(fragment);
  if (renderedRows.size) selectRoute(renderedRows.has(selectedRoute) ? selectedRoute : renderedRows.keys().next().value);
  else rows.append(node('p', profileText.noMatchingRoutes));

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
  localFilter = ''; if (zipInput) zipInput.value = '';
  selected = station === undefined
    ? chooseSelection({ districts, urlDistrict: district, saved: selected })
    : { district, station };
  districtSelect.value = selected.district;
  populateStations(document, stationSelect, districts.find(item => item.id === selected.district)); stationSelect.value = selected.station || '';
  saveSelection(undefined, selected);
  clearRouteDetail();
  return loadStation();
}
function invalidateZip() {
  zipSequence++;
  if (detailZip) { detailNeedsRefresh = true; detailZip = null; }
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
  if (renderedData) render(pageState({ status: 200, data: renderedData }), renderedData);
});

function zipFeedback(text, error = false) {
  zipResult.textContent = text;
  zipResult.className = error ? 'zip-error' : '';
}
function clearZipHighlight() {
  highlightedRoute = null;
  for (const { button } of renderedRows.values()) button.className = 'profile-route';
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
  localFilter = ''; zipInput.value = '';
  render(pageState({ status: 200, data: renderedData }), renderedData);
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
  highlightedRoute = String(routeId);
  target.button.className = 'profile-route zip-target-row';
  zipFeedback(parts.join(' · '));
  const detail = await selectRoute(routeId, {
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
