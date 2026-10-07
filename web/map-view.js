import { difficultyColor } from './difficulty.js';
import { polygonStyle, clearSelection, uncoveredZipStyle, selectionOutlineStyles } from './map-state.js';
import { routeDifficultyText, zipDifficultyText, mapText as t } from './map-text.js';

export const BASEMAP_FLAVOR = 'light';
export const basemaps = [
  { name: 'us', maxDataZoom: 6 },
  { name: 'norcal', maxDataZoom: 10, bounds: [[35.5, -124.6], [42.5, -119.0]] },
  { name: 'ops', maxDataZoom: 14, bounds: [[36.43, -123.16], [39.01, -121.06]] },
];

export function zipDetails(doc, properties, selection = clearSelection(), colorMode = 'route', detail) {
  const node = doc.createElement('dl');
  if (colorMode === 'difficulty') node.className = 'map-difficulty-details';
  for (const [label, value] of [['ZIP', properties.postal_code], [t.route, properties.route_name], [t.station, properties.station]]) {
    const entry = doc.createElement('div'), dt = doc.createElement('dt'), dd = doc.createElement('dd');
    dt.textContent = label; dd.textContent = value; entry.append(dt, dd); node.append(entry);
  }
  if (colorMode === 'difficulty') {
    const selected = selection.route?.route_id === properties.route_id;
    const entry = doc.createElement('div'), dt = doc.createElement('dt'), dd = doc.createElement('dd');
    dt.textContent = selected ? t.zipDifficulty : t.routeDifficulty;
    dd.textContent = selected ? zipDifficultyText(properties, detail) : routeDifficultyText(properties.route_difficulty);
    entry.append(dt, dd); node.append(entry);
  }
  return node;
}

export function createMapView({ leaflet: L, protomaps, document: doc, fetch: request,
  onZip, onClear, onBasemapError, onColorMode }) {
  const map = L.map(doc.getElementById('route-map'), { attributionControl: true, zoomControl: false, minZoom: 3, maxZoom: 16 });
  L.control.zoom({ zoomInTitle: t.zoomIn, zoomOutTitle: t.zoomOut }).addTo(map);
  map.attributionControl.addAttribution('Boundaries: US Census 2020 ZCTA');
  map.setView([37.5, -122], 8);
  // Keep outlines above all operational fills without intercepting hover, click or touch.
  const outlinePane = map.createPane('selection-outline');
  outlinePane.style.zIndex = '450';
  outlinePane.style.pointerEvents = 'none';
  const outlines = [];
  let polygons, highlight, selection = clearSelection(), colorMode = 'route', focusStation = null;
  let routeDetails = new Map();
  const highlightLayers = [];
  const layers = [];
  const fit = bounds => { if (bounds.isValid()) map.fitBounds(bounds, { padding: [16, 16] }); };
  const fitStation = () => {
    const targets = focusStation ? layers.filter(layer => layer.feature.properties.station === focusStation) : layers;
    if (targets.length) fit(L.featureGroup(targets).getBounds());
  };
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
  let fitButton;
  const control = L.control({ position: 'topleft' });
  control.onAdd = () => {
    const container = doc.createElement('div'), button = doc.createElement('button');
    fitButton = button; container.className = 'leaflet-bar map-fit'; button.type = 'button'; button.textContent = t.fit;
    button.addEventListener('click', fitStation); container.append(button);
    L.DomEvent.disableClickPropagation(container); return container;
  };
  control.addTo(map);
  const modeControl = L.control({ position: 'topright' });
  const modeButtons = [];
  modeControl.onAdd = () => {
    const container = doc.createElement('div'); container.className = 'leaflet-bar map-mode';
    container.setAttribute('role', 'group'); container.setAttribute('aria-label', t.colorMode);
    for (const [mode, label] of [['route', t.byRoute], ['difficulty', t.byDifficulty]]) {
      const button = doc.createElement('button'); button.type = 'button'; button.textContent = label;
      button.setAttribute('aria-pressed', String(mode === colorMode));
      button.addEventListener('click', () => onColorMode(mode));
      modeButtons.push({ mode, button }); container.append(button);
    }
    L.DomEvent.disableClickPropagation(container); return container;
  };
  modeControl.addTo(map);
  const legend = doc.createElement('div'), legendTitle = doc.createElement('strong');
  legend.className = 'map-legend'; legend.hidden = true; legend.append(legendTitle);
  ['S', 'A', 'B', 'C', 'D', null].forEach((level, index) => {
    const row = doc.createElement('div'), swatch = doc.createElement('span'), label = doc.createElement('span');
    swatch.className = 'map-swatch'; swatch.style.backgroundColor = difficultyColor(level);
    label.textContent = t.legendItems[index]; row.append(swatch, label); legend.append(row);
  });
  const legendControl = L.control({ position: 'bottomright' });
  legendControl.onAdd = () => { L.DomEvent.disableClickPropagation(legend); return legend; };
  legendControl.addTo(map);
  function updateLegend() {
    legend.hidden = colorMode !== 'difficulty';
    legendTitle.textContent = selection.route ? t.legendZip(selection.route.route_name) : t.legendRoute;
  }
  const tooltip = properties => zipDetails(doc, properties, selection, colorMode, routeDetails.get(properties.route_id));
  function refreshStyles() {
    layers.forEach(layer => {
      layer.setStyle(polygonStyle(layer.feature.properties, selection, colorMode, focusStation));
      layer.bindTooltip(tooltip(layer.feature.properties), { direction: 'auto', sticky: true });
    });
    highlightLayers.forEach(layer => {
      layer.setStyle(selection.zip?.status === 'uncovered' ? uncoveredZipStyle() : polygonStyle(layer.feature.properties, selection, colorMode, focusStation));
      if (selection.route) layer.bindTooltip(tooltip(layer.feature.properties), { direction: 'auto', sticky: true });
    });
    updateLegend();
  }
  function setColorMode(mode) {
    colorMode = mode;
    modeButtons.forEach(({ mode, button }) => button.setAttribute('aria-pressed', String(mode === colorMode)));
    refreshStyles();
  }
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
    refreshStyles();
    if (highlight) map.removeLayer(highlight);
    highlight = null; highlightLayers.length = 0;
    const zip = selection.zip;
    const feature = zip && layers.find(layer => layer.feature.properties.postal_code === zip.postal_code)?.feature;
    const geometry = zip?.geometry || feature?.geometry;
    if (geometry) {
      const properties = { ...feature?.properties, ...zip, route_id: selection.route?.route_id ?? feature?.properties.route_id };
      highlight = L.geoJSON({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry, properties }] }, {
        style: () => zip.status === 'uncovered' ? uncoveredZipStyle() : polygonStyle(properties, selection, colorMode, focusStation),
        onEachFeature(_, layer) {
          highlightLayers.push(layer);
          layer.options.bubblingMouseEvents = false;
          if (selection.route) layer.bindTooltip(tooltip(properties), { direction: 'auto', sticky: true });
          layer.on({ click: () => onZip(zip) });
        },
      }).addTo(map);
      highlight.bringToFront();
    }
    rebuildOutlines();
  }
  function clearOutlines() {
    outlines.forEach(layer => map.removeLayer(layer));
    outlines.length = 0;
  }
  function rebuildOutlines() {
    clearOutlines();
    const zip = selection.zip;
    const selectedFeature = zip && layers.find(layer => layer.feature.properties.postal_code === zip.postal_code)?.feature;
    const geometry = zip?.geometry || selectedFeature?.geometry;
    const draw = (features, options) => {
      if (!features.length) return;
      for (const style of selectionOutlineStyles(options)) {
        outlines.push(L.geoJSON({ type: 'FeatureCollection', features }, {
          ...style, pane: 'selection-outline', style: () => style,
        }).addTo(map));
      }
    };
    draw(layers.filter(layer => layer.feature.properties.route_id === selection.route?.route_id
      && (!geometry || layer.feature.properties.postal_code !== zip?.postal_code)).map(layer => layer.feature), {});
    // Draw the selected ZIP last, so its wider strokes sit above the route strokes.
    if (geometry) draw([{ type: 'Feature', geometry, properties: {} }], { zip: true, uncovered: zip.status === 'uncovered' });
  }
  function clear() {
    clearOutlines();
    if (highlight) map.removeLayer(highlight);
    highlight = null; highlightLayers.length = 0;
    if (polygons) map.removeLayer(polygons);
    polygons = null; layers.length = 0; selection = clearSelection(); routeDetails = new Map(); updateLegend();
  }
  function render(data, { fitToStation = true, focusStation: focus = null } = {}) {
    clear();
    focusStation = focus; fitButton.textContent = focus ? t.fit : '定位片区';
    routeDetails = new Map(data.routes.map(route => [route.route_id, route.zip_detail]));
    polygons = L.geoJSON(data.features, {
      style: feature => polygonStyle(feature.properties, selection, colorMode, focusStation),
      onEachFeature(feature, layer) {
        layers.push(layer);
        layer.bindTooltip(tooltip(feature.properties), { direction: 'auto', sticky: true });
        layer.options.bubblingMouseEvents = false;
        layer.on({
          mouseover: () => {
            const style = polygonStyle(feature.properties, selection, colorMode, focusStation);
            layer.setStyle({ weight: style.weight + 2, color: '#ffffff', opacity: 1 });
          },
          mouseout: () => layer.setStyle(polygonStyle(feature.properties, selection, colorMode, focusStation)),
          click: event => {
            if (event.originalEvent) L.DomEvent.stopPropagation(event.originalEvent);
            onZip(feature.properties);
          },
        });
      },
    }).addTo(map);
    if (fitToStation) fitStation();
  }
  return { map, render, clear, applySelection, fitStation, fitRoute, fitZip, loadBasemaps, setColorMode };
}
