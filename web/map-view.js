import { difficultyColor } from './difficulty.js';
import { formatPrice } from './format.js';
import { polygonStyle, clearSelection, uncoveredZipStyle, selectionOutlineStyles, hoverStyle, routeLabelAnchors, POLYGON_STYLE } from './map-state.js';
import { mapText as t } from './map-text.js';

export const MAP_RENDER = Object.freeze({ svgPadding: 0.5 });
export const ROUTE_LABEL = Object.freeze({ sameRouteDistance: 160, widthPadding: 8, selectedWidthPadding: 12,
  tiers: Object.freeze([
    Object.freeze({ name: 'far', maxZoom: 10, characterWidth: 8.5, height: 18, padding: 10, selectedCharacterWidth: 10.5, selectedHeight: 26 }),
    Object.freeze({ name: 'mid', maxZoom: 12, characterWidth: 9, height: 20, padding: 5, selectedCharacterWidth: 10.5, selectedHeight: 26 }),
    Object.freeze({ name: 'near', maxZoom: Infinity, characterWidth: 9.5, height: 22, padding: 2, selectedCharacterWidth: 11, selectedHeight: 26 }),
  ]) });

const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

export const BASEMAP_FLAVOR = 'light';
export const basemaps = [
  { name: 'us', maxDataZoom: 6 },
  { name: 'norcal', minZoom: 7, maxDataZoom: 10, bounds: [[35.5, -124.6], [42.5, -119.0]] },
  { name: 'socal', minZoom: 7, maxDataZoom: 10, bounds: [[32.4, -121.5], [35.6, -114.0]] },
  { name: 'mountain', minZoom: 7, maxDataZoom: 10, bounds: [[34.0, -116.5], [47.0, -103.0]] },
  { name: 'pnw', minZoom: 7, maxDataZoom: 10, bounds: [[42.0, -124.9], [49.1, -116.4]] },
  { name: 'az', minZoom: 7, maxDataZoom: 10, bounds: [[31.2, -115.0], [37.4, -108.8]] },
  { name: 'hawaii', maxDataZoom: 10, bounds: [[18.8, -160.6], [22.4, -154.7]] },
  { name: 'ops', minZoom: 10, maxDataZoom: 14, bounds: [[36.43, -123.16], [39.01, -121.06]] },
];

export function zipDetails(doc, properties, selection = clearSelection(), colorMode = 'route', detail) {
  const node = doc.createElement('dl');
  for (const [label, value] of [[t.zipLabel, properties.postal_code], [t.route, properties.route_name], [t.dsp, properties.dsp_name], [t.firstPrice, formatPrice(properties.current_first_0_1lb_price)]]) {
    const entry = doc.createElement('div'), dt = doc.createElement('dt'), dd = doc.createElement('dd');
    dt.textContent = label; dd.textContent = value ?? '—';
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
  const labelPane = map.createPane('route-labels');
  labelPane.style.zIndex = '610';
  labelPane.style.pointerEvents = 'none';
  const routeLabels = [];
  let zooming = false, labelTier = null;
  const renderer = L.svg({ padding: MAP_RENDER.svgPadding });
  const outlineRenderer = L.svg({ pane: 'selection-outline', padding: MAP_RENDER.svgPadding });
  const outlines = [];
  let polygons, highlight, selection = clearSelection(), colorMode = 'route', focusStation = null, dsp = null;
  let routeDetails = new Map(), routeColors;
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
  function labelPriority(label) {
    if (selection.route?.route_id === label.anchor.route_id) return 0;
    const styles = label.members.map(p => polygonStyle(p, selection, colorMode, focusStation, dsp, routeColors));
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
      const visible = (tier.name !== 'far' || label.anchor.primary || label.priority === 0)
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
  map.on('zoomstart', () => { zooming = true; });
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
      layer.setStyle(polygonStyle(layer.feature.properties, selection, colorMode, focusStation, dsp, routeColors));
      layer.bindTooltip(tooltip(layer.feature.properties), { direction: 'auto', sticky: true });
    });
    highlightLayers.forEach(layer => {
      layer.setStyle(selection.zip?.status === 'uncovered' ? uncoveredZipStyle() : polygonStyle(layer.feature.properties, selection, colorMode, focusStation, dsp, routeColors));
      if (selection.route) layer.bindTooltip(tooltip(layer.feature.properties), { direction: 'auto', sticky: true });
    });
    updateLegend();
    layoutRouteLabels();
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
        const layer = protomaps.leafletLayer({ url: archive, ...options, flavor: BASEMAP_FLAVOR, noWrap: true, updateWhenZooming: false });
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
        renderer,
        style: () => zip.status === 'uncovered' ? uncoveredZipStyle() : polygonStyle(properties, selection, colorMode, focusStation, dsp, routeColors),
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
    clearRouteLabels();
    clearOutlines();
    if (highlight) map.removeLayer(highlight);
    highlight = null; highlightLayers.length = 0;
    if (polygons) map.removeLayer(polygons);
    polygons = null; layers.length = 0; selection = clearSelection(); routeDetails = new Map(); updateLegend();
  }
  function render(data, { fitToStation = true, focusStation: focus = null, routeColors: colors } = {}) {
    routeColors = colors;
    clear();
    focusStation = focus; fitButton.setAttribute('aria-label', focus ? t.fit : '定位片区'); fitButton.title = focus ? t.fit : '定位片区';
    routeDetails = new Map(data.routes.map(route => [route.route_id, route.zip_detail]));
    polygons = L.geoJSON(data.features, {
      renderer,
      style: feature => polygonStyle(feature.properties, selection, colorMode, focusStation, dsp, routeColors),
      onEachFeature(feature, layer) {
        layers.push(layer);
        layer.bindTooltip(tooltip(feature.properties), { direction: 'auto', sticky: true });
        layer.options.bubblingMouseEvents = false;
        layer.on({
          mouseover: () => {
            const style = polygonStyle(feature.properties, selection, colorMode, focusStation, dsp, routeColors);
            layer.setStyle(hoverStyle(style));
          },
          mouseout: () => layer.setStyle(polygonStyle(feature.properties, selection, colorMode, focusStation, dsp, routeColors)),
          click: event => {
            if (event.originalEvent) L.DomEvent.stopPropagation(event.originalEvent);
            onZip(feature.properties);
          },
        });
      },
    }).addTo(map);
    buildRouteLabels(data.features.features);
    if (fitToStation) fitStation();
    layoutRouteLabels();
  }
  function setDsp(value) { dsp = value; refreshStyles(); }
  return { map, render, clear, applySelection, fitStation, fitRoute, fitZip, loadBasemaps, setColorMode, setDsp };
}
