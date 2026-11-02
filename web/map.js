import { dspOptions } from './format.js';
import { createMapView } from './map-view.js';
import { createMapPanel } from './map-panel.js';
import { clearSelection, selectRoute, selectZip, classifyQuery, filteredRoutes, assignRouteColors } from './map-state.js';
import { mapText as t, warehouseText, localizeMap } from './map-text.js';
import { chooseSelection, readSelection, saveSelection, readMapScope, saveMapScope, populateDistricts, populateStations } from './station-preference.js';

const knownErrors = new Set(['district_config_invalid', 'district_not_found', 'invalid_district', 'invalid_station', 'snapshot_invalid', 'internal_error', 'postal_codes_missing',
  'route_zip_conflict', 'boundary_invalid', 'boundary_not_found', 'invalid_postal_code', 'snapshot_not_found', 'station_not_found']);

export function createMapPage({ leaflet = globalThis.L, protomaps = globalThis.protomapsL,
  document: doc = document, fetch: request = fetch, search = location.search, storage,
  loadWarehouseModules = () => Promise.all([import('./warehouse-layer.js'), import('./warehouse-panel.js')]) } = {}) {
  const element = id => doc.getElementById(`map-${id}`);
  localizeMap(doc);
  const districtSelect = element('district'), stationSelect = element('station'), message = element('message'), retry = element('retry');
  let selection = clearSelection(), sequence = 0, zipSequence = 0, stationsLoaded = false, stationData, colorMode = 'route';
  let districts = [], selected = {}, scope = readMapScope(storage), dsp = null;
  const dspSelect = element('dsp');
  dspSelect.disabled = true;
  const focus = () => scope === 'station' ? stationSelect.value || null : null;
  const currentDistrict = () => districts.find(item => item.id === districtSelect.value);
  const updateSelection = next => { selection = next; view.applySelection(selection); panel.applySelection(selection); };
  const deselect = () => { zipSequence++; panel.searchStatus('success'); updateSelection(clearSelection(focus())); };
  const view = createMapView({ leaflet, protomaps, document: doc, fetch: request,
    onColorMode: mode => { colorMode = mode; view.setColorMode(colorMode); panel.setColorMode(colorMode); },
    onZip: properties => {
      zipSequence++; panel.searchStatus('success');
      const route = stationData?.routes.find(row => row.route_id === properties.route_id);
      updateSelection(selectZip({ ...properties, route, fetched_at: stationData?.stations?.find(station => station.code === properties.station)?.fetched_at }, properties.station));
    }, onClear: deselect,
    onBasemapError: () => {
      element('basemap-message').hidden = false;
      element('basemap-message').textContent = t.basemapError;
    } });
  const chooseRoute = routeId => {
    zipSequence++; panel.searchStatus('success');
    updateSelection(selectRoute(stationData.routes.find(row => row.route_id === routeId)));
    view.fitRoute(routeId);
  };
  const panel = createMapPanel({ document: doc, onClear: deselect, onRoute: chooseRoute, onSearch: searchQuery });
  let warehouseDistrict, warehouseSequence = 0, warehouseLoading = Promise.resolve(false);
  const noopWarehouse = { load: () => Promise.resolve(false), clear() {}, focus() {}, isOpen: () => false };
  let warehouseLayer = noopWarehouse, warehousePanel = noopWarehouse;
  element('warehouses').hidden = true;
  element('warehouses').disabled = true;
  function loadWarehouses(district) {
    const current = ++warehouseSequence;
    warehouseLoading = Promise.resolve().then(() => warehouseLayer.load(district)).then(loaded => {
      if (current !== warehouseSequence || districtSelect.value !== district) return false;
      if (loaded) warehouseDistrict = district;
      return loaded;
    }).catch(() => {
      if (current === warehouseSequence && districtSelect.value === district)
        element('warehouse-message').textContent = warehouseText.loadError;
      return false;
    });
    return warehouseLoading;
  }
  async function initializeWarehouses() {
    let layer, initializationFailed = false;
    try {
      const [{ createWarehouseLayer }, { createWarehousePanel }] = await loadWarehouseModules();
      layer = createWarehouseLayer({ leaflet, map: view.map, document: doc, fetch: request,
        onError: value => { if (!initializationFailed) element('warehouse-message').textContent = value; } });
      warehouseLayer = layer;
      if (stationData) void loadWarehouses(districtSelect.value);
      let writable = false;
      try {
        const response = await request('/api/capabilities');
        writable = response.ok && (await response.json()).warehouse_write === true;
      } catch { /* Read-only is normal when capabilities are unavailable. */ }
      if (!writable) return;
      const management = createWarehousePanel({ document: doc, fetch: request,
        getDistricts: () => districts, getCurrentDistrict: () => districtSelect.value,
        onSaved: async ({ warehouse }) => {
          const district = districtSelect.value;
          await loadWarehouses(district);
          if (warehouse?.district_id === district && districtSelect.value === district) warehouseLayer.focus(warehouse.id);
        },
        onDeleted: () => loadWarehouses(districtSelect.value),
        onView: async warehouse => {
          if (!districts.some(d => d.id === warehouse.district_id)) return;
          districtSelect.value = warehouse.district_id;
          await changeDistrict();
          await warehouseLoading;
          if (districtSelect.value === warehouse.district_id) warehouseLayer.focus(warehouse.id);
        } });
      warehousePanel = management;
      element('warehouses').hidden = false;
      element('warehouses').disabled = false;
    } catch {
      initializationFailed = true;
      warehouseLayer = noopWarehouse;
      try { layer?.clear(); } catch { /* Optional cleanup must not affect the route map. */ }
      element('warehouses').hidden = true;
      element('warehouse-message').textContent = warehouseText.loadError;
    }
  }
  function clear() { dspSelect.disabled = true; zipSequence++; stationData = null; selection = clearSelection(focus()); view.clear(); panel.clear(); }
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
        const { exact, matches } = filteredRoutes(stationData?.routes || [], query, focus(), dsp);
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
      if (data.status !== 'multi_station' && data.station && !currentDistrict()?.stations.some(station => station.code === data.station)) {
        const owner = districts.find(district => district.stations.some(station => station.code === data.station));
        panel.searchStatus('success', '该 ZIP 属于 ' + (owner?.name_zh || '未分配站点') + '/' + data.station); return;
      }
      updateSelection(selectZip(data, data.station || focus()));
      if (data.geometry) view.fitZip(data.geometry);
      panel.searchStatus('success');
    } catch {
      if (current === zipSequence) panel.searchStatus('error', t.zipError('network_error'));
    }
  }
  async function loadStation() {
    const current = ++sequence, station = focus(), district = districtSelect.value;
    if (warehouseDistrict !== district) { warehouseSequence++; warehouseLayer.clear(); warehouseDistrict = undefined; }
    clear();
    status('loading', t.loadingStation(station || currentDistrict()?.name_zh));
    try {
      const response = await request(`/api/route-map/district?district=${encodeURIComponent(district)}`, { cache: 'no-store' });
      const data = await response.json();
      if (current !== sequence) return;
      if (response.status !== 200) { showError(data?.error, station); return; }
      const routeColors = assignRouteColors(data.features.features);
      stationData = data; panel.render(data, { focusStation: station, routeColors }); view.render(data, { fitToStation: true, focusStation: station, routeColors }); updateSelection(clearSelection(station));
      const options = dspOptions(data.routes, station);
      if (!options.includes(dsp)) dsp = null;
      dspSelect.replaceChildren();
      for (const name of ['', ...options]) {
        const option = doc.createElement('option'); option.value = name; option.textContent = name || t.allDsp;
        dspSelect.append(option);
      }
      dspSelect.value = dsp || ''; dspSelect.disabled = false;
      view.setDsp(dsp); panel.setDsp(dsp);
      retainedZipHint();
      const routes = station ? data.routes.filter(route => route.station === station) : data.routes;
      status('success', routes.length === 0 ? t.noRoutes
        : routes.reduce((sum, route) => sum + route.mapped_count, 0) === 0 ? t.noBoundaries : t.loaded(station || currentDistrict()?.name_zh));
      if (routes.some(route => route.mapped_count > 0)) message.className = 'sr-only';
      if (data.details_status === 'invalid') {
        message.textContent += ` ${t.invalidDetail}`; message.className = 'map-warning';
      }
      if (warehouseDistrict !== district) {
        void loadWarehouses(district);
      }
      return true;
    } catch {
      if (current === sequence) { clear(); status('error', t.networkError); }
    }
  }
  async function start() {
    const current = ++sequence;
    clear(); status('loading', t.loadingStations); stationSelect.disabled = true; districtSelect.disabled = true;
    try {
      const response = await request('/api/districts', { cache: 'no-store' });
      const data = await response.json();
      if (current !== sequence) return;
      if (response.status !== 200) { showError(data?.error); return; }
      districts = data.districts;
      const params = new URLSearchParams(search);
      selected = chooseSelection({ districts, urlDistrict: params.get('district'), urlStation: params.get('station'), saved: readSelection(storage, districts) });
      populateDistricts(doc, districtSelect, districts); districtSelect.value = selected.district;
      populateStations(doc, stationSelect, currentDistrict(), true);
      stationSelect.value = scope === 'district' ? '' : selected.station || '';
      if (!selected.station) scope = 'district';
      stationsLoaded = true;
      await loadStation();
    } catch { status('error', t.stationsError); }
  }
  function retainedZipHint() {
    const query = element('search').value || '';
    if (classifyQuery(query).kind === 'zip') panel.searchStatus('success', t.retainedZip(query.trim()));
  }
  dspSelect.addEventListener('change', () => {
    zipSequence++;
    dsp = dspSelect.value || null;
    const route = selection.route && stationData?.routes.find(row => row.route_id === selection.route.route_id);
    if (dsp !== null && selection.route && route?.dsp_name !== dsp) deselect();
    view.setDsp(dsp); panel.setDsp(dsp);
    retainedZipHint();
  });
  stationSelect.addEventListener('change', () => {
    scope = stationSelect.value ? 'station' : 'district';
    if (stationSelect.value) selected.station = stationSelect.value;
    saveSelection(storage, selected); saveMapScope(storage, scope);
    return loadStation();
  });
  async function changeDistrict() {
    element('warehouse-notice').replaceChildren();
    selected = chooseSelection({ districts, urlDistrict: districtSelect.value, saved: selected });
    populateStations(doc, stationSelect, currentDistrict(), true);
    if (!selected.station) scope = 'district';
    stationSelect.value = scope === 'district' ? '' : selected.station || '';
    saveSelection(storage, selected); saveMapScope(storage, scope);
    if (warehousePanel.isOpen()) void warehousePanel.load();
    return loadStation();
  }
  districtSelect.addEventListener('change', changeDistrict);
  retry.addEventListener('click', () => stationsLoaded ? loadStation() : start());
  doc.addEventListener('keydown', event => { if (event.key === 'Escape' && !warehousePanel.isOpen()) deselect(); });
  void initializeWarehouses();
  const basemapReady = view.loadBasemaps();
  return { start, loadStation, searchQuery, map: view.map, basemapReady };
}

if (typeof document !== 'undefined') void createMapPage().start();
