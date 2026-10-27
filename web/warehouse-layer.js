import { warehouseText as defaults } from './map-text.js';

// Static artwork only: user input is never interpolated into icon HTML.
export const warehouseIcon = '<svg viewBox="0 0 28 28" aria-hidden="true"><path fill="#334155" stroke="#fff" stroke-width="2" d="M3 25V10L14 3l11 7v15H3Z"/><path fill="none" stroke="#fff" stroke-width="2" d="M9 25V14h10v11M9 18h10M9 22h10"/></svg>';

export function createWarehouseLayer({ leaflet: L, map, document: doc, fetch: request,
  text = defaults, onError = () => {} }) {
  const pane = map.createPane('warehouse');
  pane.style.zIndex = '620';
  const markers = new Map(), timers = new Map();
  let sequence = 0, district;
  const legend = doc.createElement('div'); legend.className = 'warehouse-legend'; legend.hidden = true;
  const icon = L.divIcon({ className: 'warehouse-legend-icon', html: warehouseIcon, iconSize: [28, 28] }).createIcon();
  const label = doc.createElement('span'); label.textContent = text.legend; legend.append(icon, label);
  const control = L.control({ position: 'bottomleft' }); control.onAdd = () => legend; control.addTo(map);
  function removeMarkers() {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    for (const marker of markers.values()) map.removeLayer(marker);
    markers.clear(); legend.hidden = true;
  }
  function clear() { sequence++; district = undefined; removeMarkers(); }
  async function load(districtId = district) {
    district = districtId; const current = ++sequence;
    removeMarkers();
    try {
      const response = await request(`/api/warehouses?district=${encodeURIComponent(districtId)}`, { cache: 'no-store' });
      const data = await response.json();
      if (current !== sequence) return false;
      if (!response.ok || !Array.isArray(data.warehouses)) throw new Error('warehouse_load');
      for (const warehouse of data.warehouses) {
        const popup = doc.createElement('dl'); popup.className = 'warehouse-popup';
        const rows = [[text.name, warehouse.warehouse_name], [text.address, warehouse.address],
          [text.district, warehouse.district_name_zh]];
        if (warehouse.station_id) rows.push([text.station, warehouse.station_id]);
        for (const [name, value] of rows) {
          const row = doc.createElement('div'), dt = doc.createElement('dt'), dd = doc.createElement('dd');
          dt.textContent = name; dd.textContent = value ?? '—'; row.append(dt, dd); popup.append(row);
        }
        const marker = L.marker([warehouse.latitude, warehouse.longitude], { pane: 'warehouse',
          icon: L.divIcon({ className: 'warehouse-marker', html: warehouseIcon, iconSize: [28, 28], iconAnchor: [14, 28] }),
          title: text.markerTitle(warehouse.warehouse_name), bubblingMouseEvents: false });
        marker.bindPopup(popup).addTo(map); markers.set(warehouse.id, marker);
      }
      legend.hidden = markers.size === 0; onError(''); return true;
    } catch {
      if (current !== sequence) return false;
      removeMarkers(); onError(text.loadError); return false;
    }
  }
  function focus(id) {
    const marker = markers.get(id); if (!marker) return;
    map.flyTo(marker.getLatLng(), 13); marker.openPopup();
    const node = marker.getElement(); node?.classList.add('warehouse-marker--highlight');
    clearTimeout(timers.get(id));
    const timer = setTimeout(() => { node?.classList.remove('warehouse-marker--highlight'); timers.delete(id); }, 4000);
    timer.unref?.(); timers.set(id, timer);
  }
  return { load, focus, clear };
}
