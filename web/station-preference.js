export const STATION_STORAGE_KEY = 'nc-ops-console.station';
export const SELECTION_STORAGE_KEY = 'nc-ops-console.selection';
export const MAP_SCOPE_STORAGE_KEY = 'nc-ops-console.map-scope';
const read = (storage, key) => { try { return (storage === undefined ? globalThis.localStorage : storage)?.getItem(key) ?? null; } catch { return null; } };
const write = (storage, key, value) => { try { (storage === undefined ? globalThis.localStorage : storage)?.setItem(key, value); } catch { /* Selection works without storage. */ } };
export function readSelection(storage, districts) {
  const raw = read(storage, SELECTION_STORAGE_KEY);
  try { if (raw !== null) { const value = JSON.parse(raw); if (value && typeof value === 'object') return value; } } catch { /* Invalid saved JSON is ignored. */ }
  const station = read(storage, STATION_STORAGE_KEY);
  const district = districts.find(item => item.stations.some(item => item.code === station));
  // Migration is read-only until the user next changes a selector.
  return district ? { district: district.id, station } : {};
}
export function saveSelection(storage, selection) {
  // An empty district has no valid concrete Station; keep the last usable shared selection.
  if (selection.station) write(storage, SELECTION_STORAGE_KEY, JSON.stringify(selection));
}
export const readMapScope = storage => read(storage, MAP_SCOPE_STORAGE_KEY) === 'district' ? 'district' : 'station';
export const saveMapScope = (storage, scope) => write(storage, MAP_SCOPE_STORAGE_KEY, scope);
export function chooseSelection({ districts, urlDistrict, urlStation, saved = {} }) {
  const inferred = !urlDistrict && districts.find(item => item.stations.some(station => station.code === urlStation));
  const district = inferred || [urlDistrict, saved.district].map(id => districts.find(item => item.id === id)).find(Boolean) || districts[0];
  const available = district?.stations.filter(item => item.has_snapshot).map(item => item.code) || [];
  const station = [urlStation, saved.station].find(code => available.includes(code)) ?? available[0] ?? null;
  return { district: district?.id ?? null, station };
}
export function populateDistricts(doc, select, districts) {
  select.replaceChildren();
  for (const district of districts) { const option = doc.createElement('option'); option.value = district.id; option.textContent = district.name_zh; option.title = district.name_en; select.append(option); }
  select.disabled = !districts.length;
}
export function populateStations(doc, select, district, overview = false) {
  select.replaceChildren();
  if (overview) { const option = doc.createElement('option'); option.value = ''; option.textContent = '全部站点（片区总览）'; select.append(option); }
  for (const station of district?.stations || []) { const option = doc.createElement('option'); option.value = station.code; option.disabled = !station.has_snapshot; option.textContent = station.code + (station.has_snapshot ? '' : '（暂无数据）'); select.append(option); }
  select.disabled = !overview && !district?.stations.some(station => station.has_snapshot);
}
