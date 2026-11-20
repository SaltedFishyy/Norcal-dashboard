import { loadBasemapLayers } from './basemap-layers.js';
export { BASEMAP_FLAVOR, SERVICE_BOUNDS, serviceTile, basemaps } from './basemap-layers.js';
import { palette } from './route-colors.js';
import { difficultyColor } from './difficulty.js';
import { PRICE_COLORS, priceCents, priceLegend } from './price-scale.js';
import { formatPrice, formatNumber } from './format.js';
import { modeColor, dspColorKey, polygonStyle, clearSelection, uncoveredZipStyle, selectionOutlineStyles, hoverStyle, routeLabelAnchors, zipLabelAnchors, POLYGON_STYLE } from './map-state.js';
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

export const ZIP_LABEL = Object.freeze({ minZoom: 10, characterWidth: 7.5, height: 18, padding: 3 });

const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

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
  labelToggle.className = 'map-display-option';
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
    layoutRouteLabels();
  });
  const zipPane = map.createPane('zip-labels');
  zipPane.style.zIndex = '605'; zipPane.style.pointerEvents = 'none';
  const zipLabels = [], zipKey = 'nc-ops-map-zip-labels';
  let zipEnabled = false;
  try { zipEnabled = storage()?.getItem(zipKey) === 'true'; } catch { /* Storage unavailable: default off. */ }
  const zipToggle = doc.createElement('label'), zipCheckbox = doc.createElement('input'), zipCaption = doc.createElement('span');
  zipToggle.className = 'map-display-option'; zipCheckbox.type = 'checkbox'; zipCheckbox.checked = zipEnabled;
  zipCaption.textContent = t.showZipLabels; zipToggle.append(zipCheckbox, zipCaption);
  const syncZipVisibility = () => zipPane.classList[zipEnabled ? 'remove' : 'add']('zip-labels--disabled');
  syncZipVisibility();
  zipCheckbox.addEventListener('change', () => {
    zipEnabled = zipCheckbox.checked;
    try { storage()?.setItem(zipKey, String(zipEnabled)); } catch { /* Keep the in-memory preference. */ }
    syncZipVisibility(); if (zipEnabled) buildZipLabels(); layoutRouteLabels();
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
    for (const [mode, label] of [['route', t.byRoute], ['dsp', t.byDsp], ['station', t.byStation], ['difficulty', t.byDifficulty], ['price', t.byPrice]]) {
      const button = doc.createElement('button'); button.type = 'button'; button.textContent = label;
      button.setAttribute('aria-pressed', String(mode === colorMode));
      button.addEventListener('click', () => onColorMode(mode));
      modeButtons.push({ mode, button }); container.append(button);
    }
    L.DomEvent.disableClickPropagation(container);
    container.addEventListener('wheel', event => event.stopPropagation());
    return container;
  };
  modeControl.addTo(map);
  const legend = doc.createElement('div'), legendTitle = doc.createElement('strong');
  legend.className = 'map-legend'; legend.hidden = true; legend.append(legendTitle);
  const legendControl = L.control({ position: 'topright' });
  legendControl.onAdd = () => {
    const wrapper = doc.createElement('div'), panel = doc.createElement('div'), title = doc.createElement('strong');
    wrapper.className = 'map-controls'; panel.className = 'map-display'; title.textContent = t.displayPanel;
    panel.append(title, labelToggle, zipToggle); wrapper.append(panel, legend);
    L.DomEvent.disableClickPropagation(wrapper);
    wrapper.addEventListener('wheel', event => event.stopPropagation());
    return wrapper;
  };
  legendControl.addTo(map);
  function updateLegend() {
    legend.hidden = layers.length === 0;
    legend.classList.toggle('map-legend--price', colorMode === 'price');
    legend.replaceChildren(legendTitle);
    if (colorMode === 'price') {
      legendTitle.textContent = t.legendPrice;
      const scale = groupColors?.price;
      if (!scale || scale.empty) {
        const message = doc.createElement('div'); message.textContent = t.legendPriceEmpty; legend.append(message);
      } else {
        const items = priceLegend(scale);
        const grid = doc.createElement('div'); grid.className = 'map-legend-price'; legend.append(grid);
        if (layers.some(layer => priceCents(layer.feature.properties.current_first_0_1lb_price) === null))
          items.push({ color: PRICE_COLORS.none, label: t.legendNoPrice });
        for (const item of items) {
          const row = doc.createElement('div'), swatch = doc.createElement('span'), label = doc.createElement('span');
          swatch.className = 'map-swatch'; swatch.style.backgroundColor = item.color;
          label.textContent = item.label; row.append(swatch, label); grid.append(row);
        }
      }
      return;
    }
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
  }
  const tooltip = properties => zipDetails(doc, properties, selection, colorMode, routeDetails.get(properties.route_id), modeColor(properties, colorMode, routeColors, groupColors, selection));
  function labelPriority(label) {
    if (selection.route?.route_id === label.anchor.route_id) return 0;
    const outside = p => focusStation !== null && p.station !== focusStation;
    const faded = p => selection.route !== null || outside(p) || (dsp !== null && p.dsp_name !== dsp);
    if (label.members.every(outside)) return 4;
    if (label.members.some(p => !faded(p))) return 1;
    return label.members.every(faded) ? 3 : 2;
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
    if (zooming) return;
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
    if (!zipEnabled) return;
    const zipPlaced = labelsEnabled ? placed.slice() : [];
    for (const label of zipLabels.toSorted((a, b) => b.anchor.area - a.anchor.area)) {
      const node = label.marker.getElement(), point = map.latLngToContainerPoint(label.anchor.latlng);
      const width = label.anchor.text.length * ZIP_LABEL.characterWidth + 12, height = ZIP_LABEL.height;
      const rect = { left: container.left + point.x - width / 2, right: container.left + point.x + width / 2,
        top: container.top + point.y - height / 2, bottom: container.top + point.y + height / 2 };
      const collision = { left: rect.left - ZIP_LABEL.padding, right: rect.right + ZIP_LABEL.padding,
        top: rect.top - ZIP_LABEL.padding, bottom: rect.bottom + ZIP_LABEL.padding };
      const visible = zoom >= ZIP_LABEL.minZoom && labelPriority(label) < 3
        && (!selection.route || selection.route.route_id === label.anchor.route_id)
        && rect.left >= container.left && rect.right <= container.right && rect.top >= container.top && rect.bottom <= container.bottom
        && ![...warehouses, ...zipPlaced].some(other => overlaps(collision, other));
      if (visible) zipPlaced.push(collision);
      node.classList.toggle('zip-label--hidden', !visible);
    }
  }
  function clearRouteLabels() {
    routeLabels.forEach(label => map.removeLayer(label.marker));
    routeLabels.length = 0;
  }
  function buildZipLabels() {
    for (const label of zipLabels) {
      if (label.marker) continue;
      const text = doc.createElement('span'); text.textContent = label.anchor.text;
      label.marker = L.marker(label.anchor.latlng, { pane: 'zip-labels', interactive: false, keyboard: false,
        icon: L.divIcon({ className: 'zip-label zip-label--hidden', html: text, iconSize: [0, 0], iconAnchor: [0, 0] }) }).addTo(map);
    }
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
    zipLabels.forEach(label => { if (label.marker) map.removeLayer(label.marker); }); zipLabels.length = 0;
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
    const properties = new Map(data.features.features.map(feature => [JSON.stringify([feature.properties.postal_code, feature.properties.route_id, feature.properties.station]), feature.properties]));
    for (const anchor of zipLabelAnchors(data.features.features)) {
      zipLabels.push({ anchor, members: [properties.get(JSON.stringify([anchor.postal_code, anchor.route_id, anchor.station]))] });
    }
    if (zipEnabled) buildZipLabels();
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
  return { map, render, clear, setFocusStation, applySelection, fitStation, fitRoute, fitZip,
    loadBasemaps: () => loadBasemapLayers({ protomaps, map, request, onBasemapError, grid: MAP_RENDER.basemapGrid }),
    setColorMode, setDsp };
}
