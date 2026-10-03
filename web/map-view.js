import { polygonStyle, clearSelection, uncoveredZipStyle } from './map-state.js';
import { mapText as t } from './map-text.js';

export const BASEMAP_FLAVOR = 'light';
export const basemaps = [
  { name: 'us', maxDataZoom: 6 },
  { name: 'norcal', maxDataZoom: 10, bounds: [[35.5, -124.6], [42.5, -119.0]] },
  { name: 'ops', maxDataZoom: 14, bounds: [[36.43, -123.16], [39.01, -121.06]] },
];

export function zipDetails(doc, properties) {
  const node = doc.createElement('dl');
  for (const [label, value] of [['ZIP', properties.postal_code], [t.route, properties.route_name], [t.station, properties.station]]) {
    const entry = doc.createElement('div'), dt = doc.createElement('dt'), dd = doc.createElement('dd');
    dt.textContent = label; dd.textContent = value; entry.append(dt, dd); node.append(entry);
  }
  return node;
}

export function createMapView({ leaflet: L, protomaps, document: doc, fetch: request,
  onZip, onClear, onBasemapError }) {
  const map = L.map(doc.getElementById('route-map'), { attributionControl: true, zoomControl: false, minZoom: 3, maxZoom: 16 });
  L.control.zoom({ zoomInTitle: t.zoomIn, zoomOutTitle: t.zoomOut }).addTo(map);
  map.attributionControl.addAttribution('Boundaries: US Census 2020 ZCTA');
  map.setView([37.5, -122], 8);
  let polygons, highlight, selection = clearSelection();
  const layers = [];
  const fit = bounds => { if (bounds.isValid()) map.fitBounds(bounds, { padding: [16, 16] }); };
  const fitStation = () => { if (polygons) fit(polygons.getBounds()); };
  const fitRoute = routeId => {
    const routeLayers = layers.filter(layer => layer.feature.properties.route_id === routeId);
    if (routeLayers.length) fit(L.featureGroup(routeLayers).getBounds());
  };
  const fitZip = target => {
    if (typeof target === 'string') {
      const layer = layers.find(layer => layer.feature.properties.postal_code === target);
      if (layer) fit(layer.getBounds());
    } else if (target) fit(L.geoJSON({ type: 'Feature', properties: {}, geometry: target }).getBounds());
  };
  const control = L.control({ position: 'topleft' });
  control.onAdd = () => {
    const container = doc.createElement('div'), button = doc.createElement('button');
    container.className = 'leaflet-bar map-fit'; button.type = 'button'; button.textContent = t.fit;
    button.addEventListener('click', fitStation); container.append(button);
    L.DomEvent.disableClickPropagation(container); return container;
  };
  control.addTo(map);
  map.on('click', onClear);

  // Preflight the local archives: the renderer logs archive failures rather than firing tileerror.
  // Missing archives must not prevent operational polygons from rendering.
  async function loadBasemaps() {
    for (const { name, ...options } of basemaps) {
      try {
        const url = `/basemap/${name}.pmtiles`;
        const response = await request(url, { headers: { Range: 'bytes=0-7' } });
        if (response.status !== 206) throw new Error('Basemap unavailable');
        const header = new Uint8Array(await response.arrayBuffer());
        if (header.length !== 8 || new TextDecoder().decode(header.subarray(0, 7)) !== 'PMTiles' || header[7] !== 3) {
          throw new Error('Basemap invalid');
        }
        // Use the exported source's PMTiles instance to report later Range failures too.
        // Returning an empty tile on failure lets the renderer preserve polygons without logging private errors.
        const archive = new protomaps.PmtilesSource(url, true).p;
        const getTile = archive.getZxy.bind(archive);
        archive.getZxy = async (...args) => {
          try { return await getTile(...args); }
          catch (error) {
            if (error?.name === 'AbortError') throw error;
            onBasemapError(); return undefined;
          }
        };
        const layer = protomaps.leafletLayer({ url: archive, ...options, flavor: BASEMAP_FLAVOR, noWrap: true });
        layer.on('tileerror', onBasemapError); layer.addTo(map);
      } catch { onBasemapError(); }
    }
  }
  function applySelection(next) {
    selection = next;
    layers.forEach(layer => layer.setStyle(polygonStyle(layer.feature.properties, selection)));
    if (highlight) map.removeLayer(highlight);
    highlight = null;
    const zip = selection.zip;
    const feature = zip && layers.find(layer => layer.feature.properties.postal_code === zip.postal_code)?.feature;
    const geometry = zip?.geometry || feature?.geometry;
    if (geometry) {
      const properties = { ...zip, route_id: selection.route?.route_id };
      highlight = L.geoJSON({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry, properties }] }, {
        style: () => zip.status === 'uncovered' ? uncoveredZipStyle() : polygonStyle(properties, selection),
        onEachFeature(_, layer) {
          layer.options.bubblingMouseEvents = false;
          if (selection.route) layer.bindTooltip(zipDetails(doc, zip), { direction: 'auto', sticky: true });
          layer.on({ click: () => onZip(zip) });
        },
      }).addTo(map);
      highlight.bringToFront();
    }
  }
  function clear() {
    if (highlight) map.removeLayer(highlight);
    highlight = null;
    if (polygons) map.removeLayer(polygons);
    polygons = null; layers.length = 0; selection = clearSelection();
  }
  function render(data, { fitToStation = true } = {}) {
    clear();
    polygons = L.geoJSON(data.features, {
      style: feature => polygonStyle(feature.properties, selection),
      onEachFeature(feature, layer) {
        layers.push(layer);
        layer.bindTooltip(zipDetails(doc, feature.properties), { direction: 'auto', sticky: true });
        layer.options.bubblingMouseEvents = false;
        layer.on({
          mouseover: () => {
            const style = polygonStyle(feature.properties, selection);
            layer.setStyle({ weight: style.weight + 2, color: '#ffffff', opacity: 1 });
          },
          mouseout: () => layer.setStyle(polygonStyle(feature.properties, selection)),
          click: event => {
            if (event.originalEvent) L.DomEvent.stopPropagation(event.originalEvent);
            onZip(feature.properties);
          },
        });
      },
    }).addTo(map);
    if (fitToStation) fitStation();
  }
  return { map, render, clear, applySelection, fitStation, fitRoute, fitZip, loadBasemaps };
}
