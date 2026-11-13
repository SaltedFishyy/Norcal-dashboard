import { palette } from './route-colors.js';
import { difficultyColor } from './difficulty.js';
import { formatPrice, formatNumber } from './format.js';
import { modeColor, dspColorKey, polygonStyle, clearSelection, uncoveredZipStyle, selectionOutlineStyles, hoverStyle, routeLabelAnchors, POLYGON_STYLE } from './map-state.js';
import { mapText as t } from './map-text.js';

export const MAP_RENDER = Object.freeze({
  svgPadding: 1,
  // Vector tiles render on the main thread and cause drag stutter, so draw new tiles only after dragging ends.
  basemapGrid: Object.freeze({ noWrap: true, updateWhenZooming: false, updateWhenIdle: true, keepBuffer: 4 }),
});
export const ROUTE_LABEL = Object.freeze({ sameRouteDistance: 160, widthPadding: 12, selectedWidthPadding: 15,
  tiers: Object.freeze([
    Object.freeze({ name: 'far', maxZoom: 10, characterWidth: 8.5, height: 18, padding: 16, selectedCharacterWidth: 10.5, selectedHeight: 26 }),
    Object.freeze({ name: 'mid', maxZoom: 12, characterWidth: 9, height: 20, padding: 5, selectedCharacterWidth: 10.5, selectedHeight: 26 }),
    Object.freeze({ name: 'near', maxZoom: Infinity, characterWidth: 9.5, height: 22, padding: 2, selectedCharacterWidth: 11, selectedHeight: 26 }),
  ]) });

const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

// Based on @protomaps/basemaps 5.7.2 LIGHT; BSD-3-Clause, © Protomaps.
// Google daytime style overrides follow map-visual-refresh.md P4-1.
export const BASEMAP_FLAVOR = {
  "background": "#aadaff",
  "earth": "#f5f3f0",
  "park_a": "#c3eccb",
  "park_b": "#b5e3bd",
  "hospital": "#fbe3e3",
  "industrial": "#ebe9ee",
  "school": "#efe9de",
  "wood_a": "#cfe8cf",
  "wood_b": "#b9dfb9",
  "pedestrian": "#f1efec",
  "scrub_a": "#e4efdc",
  "scrub_b": "#dcebd2",
  "glacier": "#ffffff",
  "sand": "#f3eedf",
  "beach": "#f3eedf",
  "aerodrome": "#e9eaf0",
  "runway": "#d9dbe2",
  "water": "#aadaff",
  "zoo": "#c3eccb",
  "military": "#eceae6",
  "tunnel_other_casing": "#dadce0",
  "tunnel_minor_casing": "#dadce0",
  "tunnel_link_casing": "#dadce0",
  "tunnel_major_casing": "#dadce0",
  "tunnel_highway_casing": "#dadce0",
  "tunnel_other": "#f1f3f4",
  "tunnel_minor": "#f1f3f4",
  "tunnel_link": "#f1f3f4",
  "tunnel_major": "#f1f3f4",
  "tunnel_highway": "#f1f3f4",
  "pier": "#ffffff",
  "buildings": "#e8e9ed",
  "minor_service_casing": "#e2e3e6",
  "minor_casing": "#dadce0",
  "link_casing": "#e9bc62",
  "major_casing_late": "#dadce0",
  "highway_casing_late": "#e9bc62",
  "other": "#ffffff",
  "minor_service": "#ffffff",
  "minor_a": "#ffffff",
  "minor_b": "#ffffff",
  "link": "#fde293",
  "major_casing_early": "#dadce0",
  "major": "#ffffff",
  "highway_casing_early": "#e9bc62",
  "highway": "#fdd774",
  "railway": "#c4c7cc",
  "boundaries": "#9aa0a6",
  "bridges_other_casing": "#dadce0",
  "bridges_minor_casing": "#dadce0",
  "bridges_link_casing": "#e9bc62",
  "bridges_major_casing": "#dadce0",
  "bridges_highway_casing": "#e9bc62",
  "bridges_other": "#ffffff",
  "bridges_minor": "#ffffff",
  "bridges_link": "#fde293",
  "bridges_major": "#ffffff",
  "bridges_highway": "#fdd774",
  "roads_label_minor": "#70757a",
  "roads_label_minor_halo": "#ffffff",
  "roads_label_major": "#5f6368",
  "roads_label_major_halo": "#ffffff",
  "ocean_label": "#4c7fae",
  "subplace_label": "#70757a",
  "subplace_label_halo": "#ffffff",
  "city_label": "#3c4043",
  "city_label_halo": "#ffffff",
  "state_label": "#80868b",
  "state_label_halo": "#ffffff",
  "country_label": "#5f6368",
  "address_label": "#80868b",
  "address_label_halo": "#ffffff",
  "pois": {
    "blue": "#1A8CBD",
    "green": "#20834D",
    "lapis": "#315BCF",
    "pink": "#EF56BA",
    "red": "#F2567A",
    "slategray": "#6A5B8F",
    "tangerine": "#CB6704",
    "turquoise": "#00C3D4"
  },
  "landcover": {
    "grassland": "rgba(212, 238, 205, 1)",
    "barren": "rgba(240, 236, 226, 1)",
    "urban_area": "rgba(240, 238, 235, 1)",
    "farmland": "rgba(232, 240, 220, 1)",
    "glacier": "rgba(255, 255, 255, 1)",
    "scrub": "rgba(222, 238, 212, 1)",
    "forest": "rgba(197, 230, 197, 1)"
  }
};

// Generated from config/basemap-service-region.json; [west, south, east, north].
export const SERVICE_BOUNDS = [
  [-122.57,36.53,-121.16,37.92], // SFO01
  [-122.03,35.9,-120.79,36.87], // OAR01
  [-122.27,38.07,-120.92,39.45], // SMF01
  [-122.01,37.61,-120.86,38.89], // SCK01
  [-120.3,38.68,-118.7,39.99], // RNO01
  [-122.83,39.89,-121.86,40.82], // RDG01
  [-122.73,39.33,-121.57,40.25], // RDG02
  [-121.54,36.96,-120.39,37.98], // MOD01
  [-123.69,41.95,-122.24,42.82], // MFR01
  [-123.06,37.74,-121.48,38.91], // SFO02
  [-105.57,37.87,-104.24,40.89], // DEN01
  [-105.33,40.95,-104.27,41.71], // CYS01
  [-107.25,34.39,-106.35,35.53], // ABQ01
  [-108.36,36.06,-107.59,37.05], // FMN01
  [-106.38,35.33,-105.67,36.11], // SAF01
  [-114.09,39.76,-110.85,41.42], // SLC01
  [-113,42.5,-112.05,43.6], // PIH01
  [-114.75,42.16,-113.56,42.93], // TWF01
  [-112.46,43.32,-111.51,43.99], // IDA01
  [-112.5,41.29,-111.38,42.05], // LGU01
  [-108.97,45.38,-108.02,45.99], // BIL01
  [-117.84,33.38,-116.62,35.32], // CNO01
  [-118.29,33.72,-117.47,34.39], // LAX01
  [-118.57,33.66,-117.91,34.3], // LAX02
  [-118.32,33.21,-117.37,33.97], // LAX03
  [-119.07,34.01,-118.05,34.67], // SFV01
  [-118.76,34.18,-117.62,34.91], // SFV02
  [-120.47,34.04,-118.65,34.84], // VTC01
  [-121.24,34.39,-119.97,35.84], // SMX01
  [-119.7,34.86,-118.54,36.19], // BKD01
  [-121.17,35.74,-118.8,37.59], // FAT01
  [-116.82,33.53,-115.75,34.08], // PLM01
  [-117.45,32.48,-116.73,33.37], // SAN01
  [-114.87,32.39,-113.63,33.51], // YUM02
  [-116.01,32.6,-114.88,33.27], // YUM01
  [-158.33,21.21,-157.6,21.76], // HNL01
  [-122.98,46.85,-121.25,48.04], // SEA01
  [-122.87,47.66,-121.58,49.05], // PAE01
  [-117.59,47.44,-116.46,48.01], // GEG01
  [-120.97,46.5,-120.08,46.96], // YKM01
  [-119.49,45.88,-118.48,46.69], // TRC01
  [-116.81,43.31,-116.01,43.92], // BOI01
  [-123.17,45.07,-122.19,45.92], // PDX01
  [-123.42,43.79,-122.57,45.16], // EUG01
  [-112.82,32.9,-111.33,34.06], // PHX01
  [-111.39,31.64,-110.6,32.67], // TUC01
  [-112.56,32.57,-111.47,33.2], // CGZ01
  [-113.27,34.33,-111.88,35.08], // PRC01
  [-115.7,35.73,-114.67,36.53], // LAS01
  [-114.1,36.95,-112.87,38.08], // STG01
  [-114.7,34.2,-113.28,35.77], // IFP01
  [-112,34.89,-110.99,35.77], // FLG01
];

// Match the actual service data tile (including overzoom), not a continent-sized envelope.
export function serviceTile(coords) {
  if (coords.z < 11) return null;
  const z = Math.min(coords.z, 14), scale = 2 ** (coords.z - z);
  const x = Math.floor(coords.x / scale), y = Math.floor(coords.y / scale);
  // Admission follows display tiles; using only an overzoom parent would suppress
  // fallback beyond the outer bounds where GridLayer never creates service tiles.
  const displayN = 2 ** coords.z;
  const displayLat = row => Math.atan(Math.sinh(Math.PI * (1 - 2 * row / displayN))) * 180 / Math.PI;
  const west = coords.x / displayN * 360 - 180, east = (coords.x + 1) / displayN * 360 - 180;
  const north = displayLat(coords.y), south = displayLat(coords.y + 1);
  return SERVICE_BOUNDS.some(([w, s, e, n]) => west < e && east > w && south < n && north > s)
    ? { z, x, y, key: z + '/' + x + '/' + y } : null;
}
export const basemaps = [
  { name: 'us', maxZoom: 6, maxDataZoom: 6, bounds: [[24.0, -125.0], [49.5, -66.5]] },
  { name: 'norcal', minZoom: 7, maxDataZoom: 10, bounds: [[35.5, -124.6], [42.5, -119.0]] },
  { name: 'socal', minZoom: 7, maxDataZoom: 10, bounds: [[32.4, -121.5], [35.6, -114.0]] },
  { name: 'mountain', minZoom: 7, maxDataZoom: 10, bounds: [[34.0, -116.5], [47.0, -103.0]] },
  { name: 'pnw', minZoom: 7, maxDataZoom: 10, bounds: [[42.0, -124.9], [49.1, -116.4]] },
  { name: 'az', minZoom: 7, maxDataZoom: 10, bounds: [[31.2, -115.0], [37.4, -108.8]] },
  { name: 'hawaii', minZoom: 7, maxDataZoom: 10, bounds: [[18.8, -160.6], [22.4, -154.7]] },
  { name: 'ops', minZoom: 10, maxDataZoom: 14, bounds: [[36.43, -123.16], [39.01, -121.06]] },
  { name: 'service', minZoom: 11, maxDataZoom: 14, levelDiff: 0, bounds: [[21.21, -158.33], [49.05, -104.24]] },
];

export function zipDetails(doc, properties, selection = clearSelection(), colorMode = 'route', detail, color) {
  const node = doc.createElement('dl');
  const swatch = doc.createElement('span'); swatch.className = 'map-swatch map-tooltip-swatch';
  swatch.style.backgroundColor = color ?? modeColor(properties, colorMode, undefined, undefined, selection);
  swatch.setAttribute('aria-hidden', 'true');
  const pickup = formatNumber(properties.pickup_volume_daily, 0);
  for (const [label, value] of [[t.zipLabel, properties.postal_code], [t.route, properties.route_name], [t.dsp, properties.dsp_name], [t.pickupDaily, pickup === '—' ? pickup : `${pickup} ${t.pieceUnit}`], [t.firstPrice, formatPrice(properties.current_first_0_1lb_price)]]) {
    const entry = doc.createElement('div'), dt = doc.createElement('dt'), dd = doc.createElement('dd');
    dt.textContent = label; dd.textContent = value ?? '—';
    if (!node.children.length) dt.append(swatch);
    entry.append(dt, dd); node.append(entry);
  }
  return node;
}

export function createMapView({ leaflet: L, protomaps, document: doc, fetch: request,
  onZip, onClear, onBasemapError, onColorMode, onDsp, storage = () => doc.defaultView?.localStorage }) {
  const map = L.map(doc.getElementById('route-map'), { attributionControl: true, zoomControl: false, minZoom: 3, maxZoom: 16 });
  // Header wrapping can resize the canvas without a window resize event.
  const canvas = doc.getElementById('route-map').parentElement;
  if (globalThis.ResizeObserver && canvas) {
    const resizeObserver = new globalThis.ResizeObserver(() => map.invalidateSize({ pan: false }));
    resizeObserver.observe(canvas);
  }
  L.control.zoom({ zoomInTitle: t.zoomIn, zoomOutTitle: t.zoomOut }).addTo(map);
  map.attributionControl.addAttribution('Boundaries: US Census 2020 ZCTA');
  map.setView([37.5, -122], 8);
  // Keep outlines above all operational fills without intercepting hover, click or touch.
  const outlinePane = map.createPane('selection-outline');
  outlinePane.style.zIndex = '450';
  outlinePane.style.pointerEvents = 'none';
  const labelPane = map.createPane('route-labels');
  labelPane.style.zIndex = '610';
  labelPane.style.pointerEvents = 'none';
  const routeLabels = [];
  const labelsKey = 'nc-ops-map-route-labels';
  let labelsEnabled = true;
  try { labelsEnabled = storage()?.getItem(labelsKey) !== 'false'; } catch { /* Storage unavailable: default on. */ }
  const labelToggle = doc.createElement('label'), labelCheckbox = doc.createElement('input'), labelCaption = doc.createElement('span');
  labelToggle.className = 'map-route-label-toggle';
  labelCheckbox.type = 'checkbox'; labelCheckbox.checked = labelsEnabled;
  labelCaption.textContent = t.showRouteLabels;
  labelToggle.append(labelCheckbox, labelCaption);
  const syncLabelVisibility = () => {
    labelPane.classList[labelsEnabled ? 'remove' : 'add']('route-labels--disabled');
  };
  syncLabelVisibility();
  labelCheckbox.addEventListener('change', () => {
    labelsEnabled = labelCheckbox.checked;
    try { storage()?.setItem(labelsKey, String(labelsEnabled)); } catch { /* Keep the in-memory preference. */ }
    syncLabelVisibility();
    if (labelsEnabled) layoutRouteLabels();
  });
  let zooming = false, dragging = false, labelTier = null;
  const renderer = L.svg({ padding: MAP_RENDER.svgPadding });
  const outlineRenderer = L.svg({ pane: 'selection-outline', padding: MAP_RENDER.svgPadding });
  const outlines = [];
  let polygons, highlight, selection = clearSelection(), colorMode = 'route', focusStation = null, dsp = null;
  let routeDetails = new Map(), routeColors, groupColors;
  const highlightLayers = [];
  const layers = [];
  const hoveredLayers = new Set();
  const blockedTooltips = new Set();
  let transitionTimer;
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
    fitButton = button; container.className = 'leaflet-bar map-fit'; button.type = 'button'; button.setAttribute('aria-label', t.fit); button.title = t.fit;
    const icon = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true'); icon.setAttribute('class', 'ui-icon');
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M12 2v5 M12 17v5 M2 12h5 M17 12h5 M19 12a7 7 0 1 1-14 0 7 7 0 0 1 14 0');
    icon.append(path); button.append(icon);
    button.addEventListener('click', fitStation); container.append(button);
    L.DomEvent.disableClickPropagation(container); return container;
  };
  control.addTo(map);
  const modeControl = L.control({ position: 'topright' });
  const modeButtons = [];
  modeControl.onAdd = () => {
    const container = doc.createElement('div'); container.className = 'leaflet-bar map-mode';
    container.setAttribute('role', 'group'); container.setAttribute('aria-label', t.colorMode);
    for (const [mode, label] of [['route', t.byRoute], ['dsp', t.byDsp], ['station', t.byStation], ['difficulty', t.byDifficulty]]) {
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
  const legendControl = L.control({ position: 'topright' });
  legendControl.onAdd = () => {
    L.DomEvent.disableClickPropagation(legend);
    legend.addEventListener('wheel', event => event.stopPropagation());
    return legend;
  };
  legendControl.addTo(map);
  function updateLegend() {
    legend.hidden = layers.length === 0;
    legend.replaceChildren(legendTitle);
    if (colorMode === 'difficulty') {
      legendTitle.textContent = selection.route ? t.legendZip(selection.route.route_name) : t.legendRoute;
      ['S', 'A', 'B', 'C', 'D', null].forEach((level, index) => {
        const row = doc.createElement('div'), swatch = doc.createElement('span'), label = doc.createElement('span');
        swatch.className = 'map-swatch'; swatch.style.backgroundColor = difficultyColor(level);
        label.textContent = t.legendItems[index]; row.append(swatch, label); legend.append(row);
      });
      return;
    }
    if (colorMode === 'dsp' || colorMode === 'station') {
      legendTitle.textContent = colorMode === 'dsp' ? t.byDsp : t.byStation;
      const groups = new Map();
      for (const { feature: { properties: p } } of layers) {
        if ((focusStation !== null && p.station !== focusStation) || (colorMode !== 'dsp' && dsp !== null && p.dsp_name !== dsp)) continue;
        const key = colorMode === 'dsp' ? dspColorKey(p.dsp_name) : p.station;
        if (!groups.has(key)) groups.set(key, { p, zips: new Set(), names: new Set() });
        const group = groups.get(key); group.zips.add(p.postal_code);
        if (p.dsp_name) group.names.add(p.dsp_name);
      }
      const list = doc.createElement('section'); list.className = 'map-legend-groups';
      for (const [key, group] of [...groups].sort((a, b) => b[1].zips.size - a[1].zips.size
        || String(a[0]).localeCompare(String(b[0])))) {
        const row = doc.createElement(colorMode === 'dsp' ? 'button' : 'div'), swatch = doc.createElement('span'), label = doc.createElement('span');
        swatch.className = 'map-swatch'; swatch.style.backgroundColor = modeColor(group.p, colorMode, routeColors, groupColors);
        label.textContent = t.legendGroupCount(key ?? t.unassignedDsp, group.zips.size);
        if (colorMode === 'dsp') {
          const enabled = group.names.size === 1;
          const name = [...group.names][0];
          row.type = 'button';
          row.setAttribute('aria-disabled', String(!enabled));
          row.setAttribute('aria-pressed', String(dsp !== null && group.names.has(dsp)));
          row.title = group.names.size > 1 ? t.legendDspAmbiguous : name || t.unassignedDsp;
          row.addEventListener('click', () => { if (enabled) onDsp?.(dsp === name ? null : name); });
        }
        row.append(swatch, label); list.append(row);
      }
      legend.append(list); return;
    }
    legendTitle.textContent = t.byRoute;
    // Count mapped routes independently of sidebar search and the current selection.
    const routes = new Set(layers.map(layer => layer.feature.properties)
      .filter(p => (focusStation === null || p.station === focusStation) && (dsp === null || p.dsp_name === dsp))
      .map(p => p.route_id));
    const summary = doc.createElement('div');
    summary.textContent = t.legendRouteCount(routes.size); legend.append(summary);
    const other = focusStation === null ? 'dimmed' : 'outside';
    ['selectedRoute', 'focused', other].forEach((state, index) => {
      const row = doc.createElement('div'), sample = doc.createElement('span'), swatch = doc.createElement('span'), label = doc.createElement('span');
      const style = POLYGON_STYLE[state];
      sample.className = 'map-legend-sample';
      row.className = 'map-legend-state'; swatch.className = 'map-swatch';
      // Separate fill and stroke alpha, as Leaflet does for the operational polygons.
      const fillRgb = palette[0].slice(1).match(/../g).map(value => parseInt(value, 16));
      swatch.style.backgroundColor = `rgba(${fillRgb.join(', ')}, ${style.fillOpacity})`;
      const rgb = style.color.slice(1).match(/../g).map(value => parseInt(value, 16));
      swatch.style.border = `${style.weight}px solid rgba(${rgb.join(', ')}, ${style.opacity})`;
      sample.append(swatch);
      label.textContent = t.legendRouteStates[index]; row.append(sample, label); legend.append(row);
    });
    legend.append(labelToggle);
  }
  const tooltip = properties => zipDetails(doc, properties, selection, colorMode, routeDetails.get(properties.route_id), modeColor(properties, colorMode, routeColors, groupColors, selection));
  function labelPriority(label) {
    if (selection.route?.route_id === label.anchor.route_id) return 0;
    const styles = label.members.map(p => polygonStyle(p, selection, colorMode, focusStation, dsp, routeColors, groupColors));
    if (styles.every(style => style.fillOpacity === POLYGON_STYLE.outside.fillOpacity)) return 4;
    if (styles.some(style => style.fillOpacity === POLYGON_STYLE.focused.fillOpacity)) return 1;
    return styles.every(style => style.fillOpacity === POLYGON_STYLE.dimmed.fillOpacity) ? 3 : 2;
  }
  function labelRectangle(label, container, tier) {
    const point = map.latLngToContainerPoint(label.anchor.latlng);
    const selected = label.priority === 0, c = ROUTE_LABEL;
    const width = label.anchor.text.length * (selected ? tier.selectedCharacterWidth : tier.characterWidth)
      + (selected ? c.selectedWidthPadding : c.widthPadding);
    const height = selected ? tier.selectedHeight : tier.height;
    return { left: container.left + point.x - width / 2, right: container.left + point.x + width / 2,
      top: container.top + point.y - height / 2, bottom: container.top + point.y + height / 2 };
  }
  function layoutRouteLabels() {
    if (colorMode !== 'route') {
      routeLabels.forEach(label => label.marker.getElement().classList.add('route-label--hidden'));
      return;
    }
    if (zooming || !routeLabels.length) return;
    const container = map.getContainer().getBoundingClientRect(), zoom = map.getZoom();
    const tier = ROUTE_LABEL.tiers.find(candidate => zoom < candidate.maxZoom);
    if (labelTier !== tier.name) {
      if (labelTier) labelPane.classList.remove(`route-labels--${labelTier}`);
      labelPane.classList.add(`route-labels--${tier.name}`);
      labelTier = tier.name;
    }
    const warehouses = [...map.getContainer().querySelectorAll('.warehouse-marker')]
      .map(node => node.getBoundingClientRect()).filter(rect => rect.width > 0 && rect.height > 0);
    const placed = [], routeCenters = new Map();
    for (const label of routeLabels) label.priority = labelPriority(label);
    for (const label of routeLabels.toSorted((a, b) => a.priority - b.priority || Number(b.anchor.primary) - Number(a.anchor.primary) || b.anchor.weight - a.anchor.weight)) {
      const node = label.marker.getElement();
      node.classList.toggle('route-label--focused', label.priority === 1);
      node.classList.toggle('route-label--selected', label.priority === 0);
      node.classList.toggle('route-label--dimmed', label.priority === 3);
      const rect = labelRectangle(label, container, tier);
      const collision = { left: rect.left - tier.padding, right: rect.right + tier.padding,
        top: rect.top - tier.padding, bottom: rect.bottom + tier.padding };
      const center = { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
      const centers = routeCenters.get(label.anchor.route_id) || [];
      const visible = label.priority !== 4 && (tier.name !== 'far' || label.anchor.primary || label.priority === 0)
        && !centers.some(other => Math.hypot(center.x - other.x, center.y - other.y) < ROUTE_LABEL.sameRouteDistance)
        && rect.left >= container.left && rect.right <= container.right
        && rect.top >= container.top && rect.bottom <= container.bottom
        && ![...warehouses, ...placed].some(other => overlaps(collision, other));
      if (visible) {
        placed.push(collision); centers.push(center); routeCenters.set(label.anchor.route_id, centers);
      }
      node.classList.toggle('route-label--hidden', !visible);
    }
  }
  function clearRouteLabels() {
    routeLabels.forEach(label => map.removeLayer(label.marker));
    routeLabels.length = 0;
  }
  function buildRouteLabels(features) {
    const members = new Map();
    for (const { properties: p } of features) {
      if (!members.has(p.route_id)) members.set(p.route_id, []);
      members.get(p.route_id).push(p);
    }
    // Geometry is computed only here; viewport events reuse these cached anchors.
    for (const anchor of routeLabelAnchors(features)) {
      const text = doc.createElement('span'); text.textContent = anchor.text;
      const marker = L.marker(anchor.latlng, { pane: 'route-labels', interactive: false, keyboard: false,
        icon: L.divIcon({ className: 'route-label route-label--hidden', html: text, iconSize: [0, 0], iconAnchor: [0, 0] }) }).addTo(map);
      routeLabels.push({ anchor, marker, members: members.get(anchor.route_id) });
    }
  }
  function clearHover(layer) {
    hoveredLayers.delete(layer);
    layer.setStyle(polygonStyle(layer.feature.properties, selection, colorMode, focusStation, dsp, routeColors, groupColors));
  }
  function clearInteraction() {
    for (const layer of [...layers, ...highlightLayers]) layer.closeTooltip();
    for (const layer of hoveredLayers) clearHover(layer);
  }
  function tooltipEvents(layer) {
    return {
      mouseover: event => {
        if (dragging || zooming) {
          blockedTooltips.add(layer);
          layer.closeTooltip();
        } else if (blockedTooltips.delete(layer)) {
          layer.openTooltip(event?.latlng);
        }
      },
      // Leaflet may defer a drag-time mouseover until moveend. Keep it blocked
      // until the pointer enters this layer again after the interaction.
      tooltipopen: () => {
        if (dragging || zooming || blockedTooltips.has(layer)) layer.closeTooltip();
      },
    };
  }
  map.on('dragstart', () => { dragging = true; clearInteraction(); });
  map.on('dragend', () => { dragging = false; });
  map.on('zoomstart', () => { zooming = true; clearInteraction(); });
  map.on('zoomend', () => { zooming = false; layoutRouteLabels(); });
  map.on('moveend', layoutRouteLabels);
  // Warehouses load asynchronously; react to their DOM arrival without importing the warehouse module.
  const Observer = doc.defaultView?.MutationObserver;
  if (Observer) {
    const observer = new Observer(records => {
      if (records.some(record => [...record.addedNodes, ...record.removedNodes]
        .some(node => node.matches?.('.warehouse-marker') || node.querySelector?.('.warehouse-marker')))) layoutRouteLabels();
    });
    observer.observe(map.getContainer(), { childList: true, subtree: true });
  }
  function refreshStyles() {
    layers.forEach(layer => {
      layer.setStyle(polygonStyle(layer.feature.properties, selection, colorMode, focusStation, dsp, routeColors, groupColors));
    });
    highlightLayers.forEach(layer => {
      layer.setStyle(selection.zip?.status === 'uncovered' ? uncoveredZipStyle() : polygonStyle(layer.feature.properties, selection, colorMode, focusStation, dsp, routeColors, groupColors));
    });
    updateLegend();
    layoutRouteLabels();
  }
  function setColorMode(mode) {
    // Enable only mode changes: subsequent hover removes the class immediately.
    const paths = [...layers, ...highlightLayers].filter(layer => !hoveredLayers.has(layer)).map(layer => layer.getElement?.()).filter(Boolean);
    if (mode !== colorMode) {
      clearTimeout(transitionTimer);
      paths.forEach(path => path.classList.add('mvr-mode-transition'));
      transitionTimer = setTimeout(() => paths.forEach(path => path.classList.remove('mvr-mode-transition')), 220);
    }
    colorMode = mode;
    modeButtons.forEach(({ mode, button }) => button.setAttribute('aria-pressed', String(mode === colorMode)));
    refreshStyles();
  }
  map.on('click', onClear);

  // Preflight the local archives: the renderer logs archive failures rather than firing tileerror.
  // Missing archives must not prevent operational polygons from rendering.
  async function loadBasemaps() {
    const baseLayers = [], missing = new Set();
    let serviceAvailable = false, refreshPending = false;
    const refreshCoverage = () => {
      if (refreshPending) return;
      refreshPending = true;
      queueMicrotask(() => {
        refreshPending = false;
        baseLayers.forEach(layer => layer.redraw?.());
      });
    };
    const hasService = coords => {
      const tile = serviceTile(coords);
      return serviceAvailable && tile && !missing.has(tile.key);
    };
    for (const { name, ...options } of basemaps) {
      try {
        const url = `/basemap/${name}.pmtiles`;
        const validate = async () => {
          const response = await request(url, { headers: { Range: 'bytes=0-7' } });
          if (response.status !== 206) throw new Error('Basemap unavailable');
          const header = new Uint8Array(await response.arrayBuffer());
          if (header.length !== 8 || new TextDecoder().decode(header.subarray(0, 7)) !== 'PMTiles' || header[7] !== 3) {
            throw new Error('Basemap invalid');
          }
        };
        // The service union is sparse. Defer even its header Range until an admitted tile.
        let validated;
        if (name !== 'service') await validate();
        // Use the exported source's PMTiles instance to report later Range failures too.
        // Returning an empty tile on failure lets the renderer preserve polygons without logging private errors.
        const archive = new protomaps.PmtilesSource(url, true).p;
        const getTile = archive.getZxy.bind(archive);
        archive.getZxy = async (...args) => {
          // Defense in depth: no tile Range requests in gaps between service bboxes.
          if (name === 'service' && !serviceTile({ z: args[0], x: args[1], y: args[2] })) return undefined;
          try {
            if (name === 'service') await (validated ??= validate());
            const tile = await getTile(...args);
            if (name === 'service' && !tile) {
              const key = args.slice(0, 3).join('/');
              if (!missing.has(key)) { missing.add(key); refreshCoverage(); }
            }
            return tile;
          }
          catch (error) {
            if (error?.name === 'AbortError') throw error;
            if (name === 'service') { serviceAvailable = false; refreshCoverage(); }
            onBasemapError(); return undefined;
          }
        };
        const layer = protomaps.leafletLayer({ url: archive, ...options, paintRules: protomaps.paintRules(BASEMAP_FLAVOR), labelRules: protomaps.labelRules(BASEMAP_FLAVOR, "en"), backgroundColor: BASEMAP_FLAVOR.background, ...MAP_RENDER.basemapGrid });
        // GridLayer bounds only understands one rectangle. Refine admission to the union
        // and give each display tile exactly one owner; regional overzoom fills the rest.
        const validTile = layer._isValidTile?.bind(layer) ?? (() => true);
        layer._isValidTile = coords => validTile(coords) &&
          (name === 'service' ? Boolean(hasService(coords)) : !hasService(coords));
        if (name === 'service') serviceAvailable = true;
        baseLayers.push(layer);
        layer.on('tileerror', onBasemapError); layer.addTo(map);
      } catch { onBasemapError(); }
    }
    refreshCoverage();
  }
  function applySelection(next) {
    if (!next.route && !next.zip && !selection.route && !selection.zip && next.station === selection.station) return;
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
        renderer,
        style: () => zip.status === 'uncovered' ? uncoveredZipStyle() : polygonStyle(properties, selection, colorMode, focusStation, dsp, routeColors, groupColors),
        onEachFeature(_, layer) {
          highlightLayers.push(layer);
          layer.options.bubblingMouseEvents = false;
          if (selection.route) layer.bindTooltip(() => tooltip(properties), { direction: 'auto', sticky: true });
          layer.on({ ...tooltipEvents(layer), click: () => onZip(zip) });
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
          ...style, pane: 'selection-outline', renderer: outlineRenderer, style: () => style,
        }).addTo(map));
      }
    };
    draw(layers.filter(layer => layer.feature.properties.route_id === selection.route?.route_id
      && (!geometry || layer.feature.properties.postal_code !== zip?.postal_code)).map(layer => layer.feature), {});
    // Draw the selected ZIP last, so its wider strokes sit above the route strokes.
    if (geometry) draw([{ type: 'Feature', geometry, properties: {} }], { zip: true, uncovered: zip.status === 'uncovered' });
  }
  function clear() {
    hoveredLayers.clear();
    blockedTooltips.clear();
    clearRouteLabels();
    clearOutlines();
    if (highlight) map.removeLayer(highlight);
    highlight = null; highlightLayers.length = 0;
    if (polygons) map.removeLayer(polygons);
    polygons = null; layers.length = 0; selection = clearSelection(); routeDetails = new Map(); updateLegend();
  }
  function render(data, { fitToStation = true, focusStation: focus = null, routeColors: colors, groupColors: groups } = {}) {
    routeColors = colors; groupColors = groups;
    clear();
    focusStation = focus; fitButton.setAttribute('aria-label', focus ? t.fit : '定位片区'); fitButton.title = focus ? t.fit : '定位片区';
    routeDetails = new Map(data.routes.map(route => [route.route_id, route.zip_detail]));
    polygons = L.geoJSON(data.features, {
      renderer,
      style: feature => polygonStyle(feature.properties, selection, colorMode, focusStation, dsp, routeColors, groupColors),
      onEachFeature(feature, layer) {
        layers.push(layer);
        layer.bindTooltip(() => tooltip(feature.properties), { direction: 'auto', sticky: true });
        layer.options.bubblingMouseEvents = false;
        const events = tooltipEvents(layer);
        layer.on({
          tooltipopen: events.tooltipopen,
          mouseover: event => {
            events.mouseover(event);
            if (dragging || zooming) return;
            hoveredLayers.add(layer);
            layer.getElement?.()?.classList.remove('mvr-mode-transition');
            const style = polygonStyle(feature.properties, selection, colorMode, focusStation, dsp, routeColors, groupColors);
            layer.setStyle(hoverStyle(style));
          },
          mouseout: () => clearHover(layer),
          click: event => {
            if (event.originalEvent) L.DomEvent.stopPropagation(event.originalEvent);
            onZip(feature.properties);
          },
        });
      },
    }).addTo(map);
    updateLegend();
    buildRouteLabels(data.features.features);
    if (fitToStation) fitStation();
    layoutRouteLabels();
  }
  function setFocusStation(station, { fit = true } = {}) {
    clearInteraction();
    hoveredLayers.clear(); blockedTooltips.clear();
    clearOutlines();
    if (highlight) map.removeLayer(highlight);
    highlight = null; highlightLayers.length = 0;
    selection = clearSelection(station);
    focusStation = station;
    fitButton.setAttribute('aria-label', station ? t.fit : '\u5b9a\u4f4d\u7247\u533a');
    fitButton.title = station ? t.fit : '\u5b9a\u4f4d\u7247\u533a';
    refreshStyles();
    if (fit) fitStation();
  }
  function setDsp(value) { if (dsp === value) return; dsp = value; refreshStyles(); }
  return { map, render, clear, setFocusStation, applySelection, fitStation, fitRoute, fitZip, loadBasemaps, setColorMode, setDsp };
}
