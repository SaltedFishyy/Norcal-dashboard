import { createMapView } from './map-view.js';
import { createMapPanel } from './map-panel.js';
import { clearSelection, selectRoute, selectZip, classifyQuery, searchRoutes } from './map-state.js';
import { mapText as t, localizeMap } from './map-text.js';
import { chooseStation, readSavedStation, saveStation } from './station-preference.js';

const knownErrors = new Set(['invalid_station', 'snapshot_invalid', 'internal_error', 'postal_codes_missing',
  'route_zip_conflict', 'boundary_invalid', 'boundary_not_found', 'invalid_postal_code', 'snapshot_not_found', 'station_not_found']);

export function createMapPage({ leaflet = globalThis.L, protomaps = globalThis.protomapsL,
  document: doc = document, fetch: request = fetch, search = location.search, storage } = {}) {
  const element = id => doc.getElementById(`map-${id}`);
  localizeMap(doc);
  const stationSelect = element('station'), message = element('message'), retry = element('retry');
  let selection = clearSelection(), sequence = 0, zipSequence = 0, stationsLoaded = false, stationData, colorMode = 'route';
  const updateSelection = next => { selection = next; view.applySelection(selection); panel.applySelection(selection); };
  const deselect = () => { zipSequence++; panel.searchStatus('success'); updateSelection(clearSelection(stationSelect.value)); };
  const view = createMapView({ leaflet, protomaps, document: doc, fetch: request,
    onColorMode: mode => { colorMode = mode; view.setColorMode(colorMode); panel.setColorMode(colorMode); },
    onZip: properties => {
      zipSequence++; panel.searchStatus('success');
      const route = stationData?.routes.find(row => row.route_id === properties.route_id);
      updateSelection(selectZip({ ...properties, route, fetched_at: stationData?.fetched_at }, stationSelect.value));
    }, onClear: deselect,
    onBasemapError: () => {
      element('basemap-message').hidden = false;
      element('basemap-message').textContent = t.basemapError;
    } });
  const chooseRoute = routeId => {
    zipSequence++; panel.searchStatus('success');
    updateSelection(selectRoute(stationData.routes.find(row => row.route_id === routeId), stationSelect.value));
    view.fitRoute(routeId);
  };
  const panel = createMapPanel({ document: doc, onClear: deselect, onRoute: chooseRoute, onSearch: searchQuery });
  function clear() { zipSequence++; stationData = null; selection = clearSelection(stationSelect.value); view.clear(); panel.clear(); }
  function status(state, value) {
    message.textContent = value;
    message.className = state === 'error' ? 'map-error' : '';
    element('content').setAttribute('aria-busy', String(state === 'loading'));
    retry.hidden = state === 'loading' || state === 'success';
  }
  function showError(code, station) {
    if (['snapshot_not_found', 'station_not_found'].includes(code)) {
      status('empty', t.noData(station, code)); return;
    }
    const safeCode = knownErrors.has(code) ? code : 'internal_error';
    status('error', t.loadError(safeCode, station));
  }
  async function searchQuery(query, enter) {
    const current = ++zipSequence, classified = classifyQuery(query);
    panel.searchStatus('success');
    if (classified.kind !== 'zip') {
      if (enter) {
        const { exact, matches } = searchRoutes(stationData?.routes || [], query);
        const route = exact || (matches.length === 1 ? matches[0] : undefined);
        if (route) chooseRoute(route.route_id);
      }
      return;
    }
    panel.searchStatus('loading', t.zipLoading(query.trim()));
    try {
      const response = await request(`/api/route-map/zip?postal_code=${encodeURIComponent(query.trim())}`, { cache: 'no-store' });
      const data = await response.json();
      if (current !== zipSequence) return;
      if (response.status !== 200) {
        panel.searchStatus('error', t.zipError(knownErrors.has(data?.error) ? data.error : 'internal_error')); return;
      }
      // A ZIP can belong to another Station. Load that Station before applying its result.
      if (data.status !== 'multi_station' && data.station && data.station !== stationSelect.value) {
        stationSelect.value = data.station;
        const loaded = await loadStation({ preserveSearch: true });
        if (!loaded || current !== zipSequence) return;
      }
      updateSelection(selectZip(data, stationSelect.value));
      if (data.geometry) view.fitZip(data.geometry);
      panel.searchStatus('success');
    } catch {
      if (current === zipSequence) panel.searchStatus('error', t.zipError('network_error'));
    }
  }
  async function loadStation({ preserveSearch = false } = {}) {
    const current = ++sequence, station = stationSelect.value;
    const savedQuery = element('search').value, savedZipSequence = zipSequence;
    clear();
    if (preserveSearch) { zipSequence = savedZipSequence; element('search').value = savedQuery; }
    status('loading', t.loadingStation(station));
    try {
      const response = await request(`/api/route-map?station=${encodeURIComponent(station)}`, { cache: 'no-store' });
      const data = await response.json();
      if (current !== sequence) return;
      if (response.status !== 200) { showError(data?.error, station); return; }
      stationData = data; panel.render(data); view.render(data, { fitToStation: !preserveSearch }); updateSelection(clearSelection(station));
      status('success', data.coverage.total === 0 ? t.noRoutes
        : data.coverage.mapped === 0 ? t.noBoundaries : t.loaded(data.station));
      if (data.details_status === 'invalid') {
        message.textContent += ` ${t.invalidDetail}`; message.className = 'map-warning';
      }
      return true;
    } catch {
      if (current === sequence) { clear(); status('error', t.networkError); }
    }
  }
  async function start() {
    const current = ++sequence;
    clear(); status('loading', t.loadingStations); stationSelect.disabled = true;
    try {
      const response = await request('/api/route-map/stations', { cache: 'no-store' });
      const data = await response.json();
      if (current !== sequence) return;
      if (response.status !== 200) { showError(data?.error); return; }
      stationSelect.replaceChildren();
      for (const station of data.stations) {
        const option = doc.createElement('option'); option.textContent = station; option.value = station; stationSelect.append(option);
      }
      if (!data.stations.length) { status('empty', t.noStations); return; }
      const desired = new URLSearchParams(search).get('station');
      stationSelect.value = chooseStation({ urlStation: desired, savedStation: readSavedStation(storage), stations: data.stations });
      stationsLoaded = true; stationSelect.disabled = false;
      await loadStation();
    } catch { status('error', t.stationsError); }
  }
  stationSelect.addEventListener('change', () => {
    saveStation(storage, stationSelect.value);
    return loadStation();
  });
  retry.addEventListener('click', () => stationsLoaded ? loadStation() : start());
  doc.addEventListener('keydown', event => { if (event.key === 'Escape') deselect(); });
  const basemapReady = view.loadBasemaps();
  return { start, loadStation, searchQuery, map: view.map, basemapReady };
}

if (typeof document !== 'undefined') void createMapPage().start();
