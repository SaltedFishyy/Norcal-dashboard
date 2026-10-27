import { warehouseText as defaults } from './map-text.js';

export function createWarehousePanel({ document: doc, fetch: request, text = defaults,
  getDistricts, getCurrentDistrict, confirm = message => globalThis.confirm(message),
  onSaved = () => {}, onDeleted = () => {}, onView = () => {} }) {
  const entry = doc.getElementById('map-warehouses');
  const pageNotice = doc.getElementById('map-warehouse-notice');
  entry.textContent = text.manage;
  const make = (tag, content, className) => {
    const node = doc.createElement(tag); if (content != null) node.textContent = content;
    if (className) node.className = className; return node;
  };
  const button = (label, action) => { const node = make('button', label); node.type = 'button'; node.addEventListener('click', action); return node; };
  const dialog = make('dialog', null, 'warehouse-panel'); dialog.setAttribute('aria-label', text.manage);
  const closeButton = button(text.close, close);
  const heading = make('h2', text.manage), tabs = make('div', null, 'warehouse-actions');
  const currentTab = button(text.current, () => setTab(false)), allTab = button(text.all, () => setTab(true));
  tabs.append(currentTab, allTab);
  const readonly = make('p', text.readonly), notice = make('div', null, 'warehouse-notice'); notice.setAttribute('role', 'status');
  const listStatus = make('p'); listStatus.setAttribute('role', 'status');
  const list = make('table', null, 'warehouse-list'), head = make('thead'), headRow = make('tr'), body = make('tbody');
  for (const label of [text.name, text.district, text.station, text.address, text.edit, text.delete]) headRow.append(make('th', label));
  head.append(headRow); list.append(head, body);
  const add = button(text.add, () => edit()); add.hidden = true;
  const form = make('form', null, 'warehouse-form'); form.hidden = true;
  const fields = {};
  function field(key, label, tag = 'input', parent = form) {
    const wrapper = make('label', label), node = make(tag); node.name = key;
    wrapper.append(node); parent.append(wrapper); fields[key] = node; return node;
  }
  field('warehouse_name', text.name).maxLength = 120;
  field('address', text.address).maxLength = 300;
  field('district_id', text.district, 'select'); field('station_id', text.station, 'select');
  for (const key of ['warehouse_name', 'address', 'district_id']) fields[key].required = true;
  const manual = make('details'); manual.hidden = true; manual.append(make('summary', text.manual));
  for (const [key, label, min, max] of [['latitude', text.latitude, -90, 90], ['longitude', text.longitude, -180, 180]]) {
    const node = field(key, label, 'input', manual); node.type = 'number'; node.step = 'any'; node.min = min; node.max = max;
  }
  form.append(manual);
  const error = make('p', null, 'warehouse-error'); error.setAttribute('role', 'alert');
  const confirmation = make('section', null, 'warehouse-confirmation'); confirmation.hidden = true;
  const save = make('button', text.save); save.type = 'submit';
  form.append(error, confirmation, save, button(text.cancel, () => { form.hidden = true; add.focus(); }));
  dialog.append(closeButton, heading, tabs, readonly, add, listStatus, list, notice, form);
  doc.body.append(dialog);
  let opened = false, all = false, writable = false, sequence = 0, capabilitySequence = 0, editing, busy = false, pending;
  function option(select, value, label) { const node = make('option', label); node.value = value; select.append(node); }
  function stations(value = '') {
    fields.station_id.replaceChildren(); option(fields.station_id, '', text.unspecified);
    for (const station of getDistricts().find(d => d.id === fields.district_id.value)?.stations || []) option(fields.station_id, station.code, station.code);
    fields.station_id.value = value;
  }
  fields.district_id.addEventListener('change', () => stations());
  // A changed form must obtain fresh server confirmation for its new contents.
  form.addEventListener('input', () => { pending = null; confirmation.hidden = true; });
  form.addEventListener('change', () => { pending = null; confirmation.hidden = true; });
  function edit(row) {
    if (!writable || busy) return;
    editing = row; pending = null; form.hidden = false; error.textContent = ''; confirmation.hidden = true;
    manual.hidden = true; manual.open = false; fields.latitude.value = ''; fields.longitude.value = '';
    fields.warehouse_name.value = row?.warehouse_name || ''; fields.address.value = row?.address || '';
    fields.district_id.replaceChildren(); option(fields.district_id, '', text.chooseDistrict);
    for (const district of getDistricts()) option(fields.district_id, district.id, district.name_zh);
    fields.district_id.value = row ? (row.district_known === false ? '' : row.district_id) : getCurrentDistrict();
    stations(row?.station_known === false ? '' : row?.station_id || ''); fields.warehouse_name.focus();
  }
  async function load() {
    const current = ++sequence; listStatus.textContent = text.loading;
    try {
      const response = await request('/api/warehouses' + (all ? '' : `?district=${encodeURIComponent(getCurrentDistrict())}`), { cache: 'no-store' });
      const data = await response.json(); if (current !== sequence) return;
      if (!response.ok || !Array.isArray(data.warehouses)) throw new Error('warehouse_load');
      body.replaceChildren();
      for (const row of data.warehouses) {
        const tr = make('tr');
        const values = [row.warehouse_name, row.district_known === false ? text.unknownDistrict : row.district_name_zh,
          row.station_known === false ? text.unknownStation : row.station_id || '—', row.address];
        for (let i = 0; i < values.length; i++) {
          const cell = make('td'), label = make('span', headRow.children[i].textContent, 'warehouse-cell-label');
          cell.append(label, make('span', values[i])); tr.append(cell);
        }
        for (const [label, action] of [[text.edit, () => edit(row)], [text.delete, () => remove(row)]]) {
          const cell = make('td'); cell.hidden = !writable; cell.append(button(label, action)); tr.append(cell);
        }
        body.append(tr);
      }
      headRow.children[4].hidden = headRow.children[5].hidden = !writable;
      listStatus.textContent = data.warehouses.length ? '' : text.empty;
    } catch { if (current === sequence) { body.replaceChildren(); listStatus.textContent = text.loadError; } }
  }
  async function setTab(value) {
    all = value; currentTab.setAttribute('aria-pressed', String(!all)); allTab.setAttribute('aria-pressed', String(all)); await load();
  }
  async function open() {
    pageNotice.replaceChildren(); notice.replaceChildren();
    opened = true; dialog.showModal(); closeButton.focus(); form.hidden = true;
    writable = false; add.hidden = true; readonly.hidden = false;
    const current = ++capabilitySequence;
    try {
      const response = await request('/api/capabilities', { cache: 'no-store' });
      const capabilities = await response.json();
      if (current !== capabilitySequence || !opened) return;
      writable = response.ok && capabilities.warehouse_write === true;
    } catch { writable = false; }
    add.hidden = !writable; readonly.hidden = writable; await setTab(false);
  }
  function close() { opened = false; sequence++; capabilitySequence++; dialog.close(); entry.focus(); }
  dialog.addEventListener('cancel', event => { event.preventDefault(); event.stopPropagation(); close(); });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
  });
  entry.addEventListener('click', open);
  function showConfirmation(data, payload) {
    confirmation.replaceChildren(); confirmation.hidden = false; pending = { data, payload };
    if (data.reasons.includes('duplicate_address')) {
      confirmation.append(make('p', text.duplicate));
      for (const duplicate of data.duplicates || []) confirmation.append(make('p',
        [duplicate.warehouse_name, duplicate.address, getDistricts().find(d => d.id === duplicate.district_id)?.name_zh || text.unknownDistrict].join(' · ')));
    }
    if (data.reasons.includes('far_from_district')) confirmation.append(make('p', text.far(data.distance_km)));
    if (data.geocode?.matched_address) confirmation.append(make('p', text.matched(data.geocode.matched_address)));
    confirmation.append(button(text.confirmSave, () => pending && submit({ ...pending.payload,
      confirm: [...new Set([...(pending.payload.confirm || []), ...pending.data.reasons])] })),
    button(text.back, () => { confirmation.hidden = true; pending = null; fields.address.focus(); }));
  }
  async function synchronize() { await load(); await onSaved({ warehouse: null, geocode: null, warnings: [] }); }
  async function failure(data, status, payload) {
    if (status === 409 && data.error === 'confirmation_required') { showConfirmation(data, payload); return; }
    error.textContent = data.error === 'invalid_warehouse' ? text.invalid((data.fields || []).map(key => text[key] || key)) : text.errors[data.error] || text.saveError;
    if (['geocode_failed', 'geocode_ambiguous', 'geocode_unavailable'].includes(data.error)) manual.hidden = false;
    if (['warehouse_changed', 'warehouse_not_found'].includes(data.error)) await synchronize();
  }
  async function submit(payload) {
    if (busy || !writable) return;
    busy = true; save.disabled = true; error.textContent = '';
    // Freeze the form during a write so the server confirmation always refers to this payload.
    for (const node of Object.values(fields)) node.disabled = true;
    try {
      const response = await request('/api/warehouses' + (editing ? `?id=${encodeURIComponent(editing.id)}` : ''), {
        method: editing ? 'PATCH' : 'POST', headers: { 'X-NC-Warehouse': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await response.json();
      if (!response.ok) { await failure(data, response.status, payload); return; }
      form.hidden = true; pending = null; notice.replaceChildren();
      const warehouse = data.warehouse;
      const inCurrentDistrict = warehouse.district_id === getCurrentDistrict();
      const resultNotice = inCurrentDistrict ? pageNotice : notice;
      resultNotice.replaceChildren();
      if (data.geocode?.matched_address) resultNotice.append(make('p', text.located(data.geocode.matched_address)));
      if (data.warnings?.includes('duplicate_name')) resultNotice.append(make('p', text.duplicateName));
      if (warehouse.district_id !== getCurrentDistrict()) {
        const district = getDistricts().find(d => d.id === warehouse.district_id);
        notice.append(make('p', text.savedTo(district?.name_zh || text.unknownDistrict)));
        if (district) notice.append(button(text.view, async () => { close(); await onView(warehouse); }));
      }
      await load();
      if (inCurrentDistrict) close();
      await onSaved(data);
    } catch { error.textContent = text.saveError; }
    finally { busy = false; save.disabled = false; for (const node of Object.values(fields)) node.disabled = false; }
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    const payload = Object.fromEntries(['warehouse_name', 'address', 'district_id', 'station_id'].map(key => [key, fields[key].value]));
    payload.station_id ||= null;
    if (editing) payload.expected_updated_at = editing.updated_at;
    const lat = fields.latitude.value, lng = fields.longitude.value;
    if (!manual.hidden && lat.trim() && lng.trim() && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))
      && Math.abs(Number(lat)) <= 90 && Math.abs(Number(lng)) <= 180) payload.manual_coordinates = { latitude: Number(lat), longitude: Number(lng) };
    return submit(payload);
  });
  async function remove(row) {
    if (!writable || busy || !confirm(text.deleteConfirm(row.warehouse_name, row.address))) return;
    busy = true;
    try {
      const response = await request(`/api/warehouses?id=${encodeURIComponent(row.id)}`, { method: 'DELETE', headers: { 'X-NC-Warehouse': '1' } });
      if (response.status !== 204) {
        const data = await response.json(); notice.textContent = text.errors[data.error] || text.saveError;
        if (['warehouse_changed', 'warehouse_not_found'].includes(data.error)) await synchronize();
        return;
      }
      await load(); await onDeleted(row.id);
    } catch { notice.textContent = text.saveError; } finally { busy = false; }
  }
  return { open, close, load, isOpen: () => opened };
}
