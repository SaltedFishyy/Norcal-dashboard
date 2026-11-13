import { difficultyColor, difficultyLevel } from './difficulty.js';
import { formatNumber, formatUpdated, formatValue, formatPrice, formatPriceRange } from './format.js';
import { openPriceDetail } from './price-detail.js';
import { modeColor, dspColorKey, filteredRoutes, classifyQuery, clearSelection } from './map-state.js';
import { routeDifficultyText, mapText as t } from './map-text.js';

// Compare instants before formatting; API order and timezone offsets need not match chronology.
export function mapUpdatedSummary(stations, fallback) {
  const times = stations.map(station => station.fetched_at).filter(value => value && Number.isFinite(Date.parse(value)))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  if (!times.length) return formatUpdated(fallback);
  return Date.parse(times[0]) === Date.parse(times.at(-1)) ? formatUpdated(times[0])
    : `${formatUpdated(times[0])} – ${formatUpdated(times.at(-1))}`;
}

export function createMapPanel({ document: doc, onRoute, onClear, onSearch }) {
  const element = id => doc.getElementById(`map-${id}`);
  const text = (tag, value, className) => {
    const node = doc.createElement(tag); node.textContent = value;
    if (className) node.className = className;
    return node;
  };
  const entry = (label, value) => { const node = text('div', ''); node.append(text('dt', label), text('dd', formatValue(value))); return node; };
  const difficultyEntry = (label, value) => {
    const node = entry(label, routeDifficultyText(value));
    if (difficultyLevel(value)) { node.children[1].className = 'difficulty system-difficulty'; node.children[1].style.backgroundColor = difficultyColor(difficultyLevel(value)); node.children[1].style.color = '#ffffff'; }
    return node;
  };
  let data, routeColors, groupColors, selection = clearSelection(), colorMode = 'route', focusStation = null, dsp = null;
  const search = element('search');
  const coverageToggle = element('coverage-toggle'), coveragePanel = element('coverage-panel');
  function setCoverageOpen(open) {
    if (!coveragePanel) return;
    coveragePanel.hidden = !open;
    coverageToggle.setAttribute('aria-expanded', String(open));
  }
  coverageToggle?.addEventListener('click', () => setCoverageOpen(coveragePanel.hidden));
  function syncCoverageControl() {
    if (!coverageToggle) return;
    const value = element('coverage').textContent;
    element('coverage-label').textContent = (!value || value === '—') ? t.coverageToggle : t.coverageToggleValue(value);
    element('coverage-dot').hidden = element('conflicts-details').hidden;
  }
  // These overlays live outside Leaflet; keep wheel and pointer events local.
  for (const id of ['detail-card', 'coverage-control']) {
    const node = element(id);
    for (const type of ['wheel', 'click', 'dblclick', 'pointerdown'])
      node?.addEventListener(type, event => event.stopPropagation());
  }

  function renderRoutes() {
    const query = search.value || '', classified = classifyQuery(query);
    const { matches } = filteredRoutes(data?.routes || [], query, focusStation, dsp);
    element('route-items').replaceChildren();
    element('no-match').hidden = matches.length !== 0;
    element('search-hint').hidden = !classified.zipHint;
    const dspGroups = new Map();
    if (colorMode === 'dsp') for (const route of matches) {
      const key = dspColorKey(route.dsp_name);
      if (!dspGroups.has(key)) dspGroups.set(key, { routes: [], zips: 0 });
      const group = dspGroups.get(key); group.routes.push(route); group.zips += route.zip_count;
    }
    const sortedGroups = [...dspGroups].sort((a, b) => b[1].zips - a[1].zips || String(a[0]).localeCompare(String(b[0])));
    const groups = colorMode !== 'dsp' && !focusStation && data?.stations;
    const ordered = colorMode === 'dsp' ? sortedGroups.flatMap(([, group]) => group.routes.sort((a, b) => a.route_name.localeCompare(b.route_name)))
      : groups ? data.stations.flatMap(station => matches.filter(route => route.station === station.code)) : matches;
    element('route-count').textContent = t.routeCount(ordered.length);
    let previous;
    for (const route of ordered) {
      if (colorMode === 'dsp' && previous !== dspColorKey(route.dsp_name)) {
        previous = dspColorKey(route.dsp_name);
        const heading = text('h3', '', 'map-dsp-group');
        const swatch = text('span', '', 'map-swatch'); swatch.style.backgroundColor = modeColor(route, colorMode, routeColors, groupColors);
        heading.append(swatch, text('span', t.dspRouteGroup(previous ?? t.unassignedDsp, dspGroups.get(previous).routes.length)));
        element('route-items').append(heading);
      }
      if (groups && previous !== route.station) { element('route-items').append(text('h3', route.station)); previous = route.station; }
      const button = text('button', ''); button.type = 'button'; button.className = 'map-route';
      button.setAttribute('aria-pressed', String(selection.route !== null && selection.route.route_id === route.route_id));
      const swatch = text('span', '', 'map-swatch'); swatch.style.backgroundColor = modeColor(route, colorMode, routeColors, groupColors);
      const name = query && !focusStation ? route.station + ' · ' + route.route_name : route.route_name;
      const owner = formatValue(route.dsp_name), pph = formatNumber(route.pph, 2, 2), volume = formatNumber(route.pickup_volume, 0);
      const info = text('span', '', 'map-route-info');
      info.append(text('span', name, 'map-route-title'), text('span', owner + ' · ' + route.zip_count + ' ZIP', 'map-route-owner'));
      const metrics = text('span', '', 'map-route-values');
      const pphLine = text('span', '', 'map-route-metric'), volumeLine = text('span', '', 'map-route-metric');
      pphLine.append(text('span', pph, 'map-route-pph'), text('small', t.pph));
      volumeLine.append(text('span', volume, 'map-route-pickup'), text('small', t.pieceUnit));
      metrics.append(pphLine, volumeLine);
      const level = difficultyLevel(route.route_difficulty);
      const badge = text('span', level || '—', 'map-route-difficulty');
      badge.style.backgroundColor = difficultyColor(level);
      // White meets 4.5:1 on S/A/C; dark text is needed on B/D/unknown.
      badge.style.color = ['S', 'A', 'C'].includes(level) ? '#ffffff' : '#111827';
      button.setAttribute('aria-label', name + ', DSP ' + owner + ', ' + route.zip_count + ' ZIP, ' + t.pph + ' ' + pph + ', ' + t.routePickupVolume + ' ' + volume + ' ' + t.pieceUnit + ', ' + t.routeDifficulty + ' ' + (level || '—'));
      button.append(swatch, info, metrics, badge);
      button.addEventListener('click', () => onRoute(route.route_id)); element('route-items').append(button);
    }
  }
  search.addEventListener('input', () => { renderRoutes(); return onSearch(search.value || '', false); });
  search.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault(); return onSearch(search.value || '', true);
  });
  element('clear').addEventListener('click', onClear);
  function applySelection(next) {
    selection = next; renderRoutes();
    if (element('detail-card')) element('detail-card').hidden = !next.route && !next.zip;
    if (next.route) [...element('route-items').children].find(row => row.getAttribute?.('aria-pressed') === 'true')?.scrollIntoView?.({ block: 'nearest' });
    element('clear').disabled = !next.route && !next.zip;
    element(next.zip ? 'zip-heading' : 'summary-heading').append(element('clear'));
    element('summary').replaceChildren();
    element('summary-panel').hidden = !next.route;
    const route = next.route && (data?.routes.find(row => row.route_id === next.route.route_id) || next.route);
    if (route) {
      const name = text('h3', formatValue(route.route_name), 'map-route-name');
      const owner = text('p', `${t.station} ${formatValue(route.station)} · ${t.dsp} ${formatValue(route.dsp_name)}`);
      const metrics = text('dl', '', 'map-summary-metrics');
      const count = entry(t.zipCount, formatNumber(route.zip_count, 0));
      count.append(text('small', t.mapped(formatValue(route.mapped_count))));
      metrics.append(count, entry(t.pickupVolume, formatNumber(route.pickup_volume, 0)), entry(t.pph, formatNumber(route.pph, 2, 2)), difficultyEntry(t.routeDifficulty, route.route_difficulty));
      element('summary').append(name, owner, metrics);
      metrics.append(entry(t.firstPrice, formatPriceRange(route.current_first_0_1lb_price_min, route.current_first_0_1lb_price_max)));
      if (route.quoted_zip_count > 0) {
        const button = text('button', t.priceDetail, 'price-detail-button'); button.type = 'button';
        button.addEventListener('click', () => openPriceDetail(route, button, { highlightZip: next.zip?.postal_code }));
        element('summary').append(button);
      }
      if (route.mapped_count === 0) element('summary').append(text('p', t.noMapped));
      if (colorMode === 'difficulty') {
        element('summary').append(text('p', route.zip_detail?.status === 'available'
          ? t.detailAvailable(route.zip_detail.zip_count, route.zip_detail.fetched_at) : t.missingDetail));
      }
      element('summary').append(text('p', `${t.updated} ${formatUpdated(next.zip?.fetched_at || (data?.stations?.find(station => station.code === route.station)?.fetched_at || data?.fetched_at))}`, 'map-summary-updated'));
    }
    element('selection').replaceChildren();
    element('zip-panel').hidden = !next.zip;
    if (next.zip) {
      const zip = next.zip;
      const heading = text('div', '', 'map-zip-title');
      heading.append(text('strong', formatValue(zip.postal_code), 'map-zip-number'), text('span', t.statuses[zip.status], 'map-badge'));
      if (zip.status === 'covered_no_boundary') heading.append(text('span', t.statuses.no_boundary, 'map-badge'));
      const metrics = text('dl', '', 'map-zip-metrics');
      metrics.append(entry(t.experiencedPph, formatNumber(zip.experienced_pph, 2, 2)), entry(t.pickupDaily, formatNumber(zip.pickup_volume_daily, 0)), entry(t.dsp, zip.dsp_name), difficultyEntry(t.zipDifficulty, zip.zip_difficulty));
      const info = text('dl', '', 'map-zip-info');
      if (zip.status !== 'multi_station') metrics.append(entry(t.firstPrice, formatPrice(zip.current_first_0_1lb_price)));
      info.append(entry(t.station, zip.station));
      element('selection').append(heading, metrics, info);
      if (zip.status === 'multi_station') {
        const owners = text('ul', '', 'map-zip-owners');
        for (const owner of zip.owners) owners.append(text('li', owner.station + ' · ' + owner.route_name + ' · ' + formatPrice(owner.current_first_0_1lb_price)));
        element('selection').append(owners);
      }
      if (t.zipNotes[zip.status]) element('selection').append(text('p', t.zipNotes[zip.status], 'snapshot'));

    }
  }
  function searchStatus(state, value = '') {
    element('search-message').textContent = value;
    element('search-message').className = state === 'error' ? 'map-error' : 'snapshot';
    element('search-message').setAttribute('role', state === 'error' ? 'alert' : 'status');
  }
  function clear() {
    data = null; search.disabled = true;
    element('conflicts-details').hidden = true; element('conflicts-details').open = false; element('conflicts').replaceChildren();
    applySelection(clearSelection());
    element('no-match').hidden = true; searchStatus('success');
    element('coverage').textContent = '—'; element('coverage-count').textContent = '';
    element('missing').replaceChildren(); element('missing-details').open = false;
    element('missing-title').textContent = t.missingTitle(0);
    element('missing-empty').hidden = true; element('regenerate').hidden = true;
    if (element('station-times')) element('station-times').textContent = '';
    syncCoverageControl();
    element('source').textContent = ''; element('updated').textContent = '—'; element('updated').removeAttribute('title');
  }
  function render(next, { focusStation: focus = null, routeColors: colors, groupColors: groups } = {}) {
    routeColors = colors; groupColors = groups;
    data = next; focusStation = focus;
    const scoped = focus ? next.routes.filter(route => route.station === focus) : next.routes;
    const missing = focus ? next.missing.filter(row => row.station === focus) : next.missing;
    const coverage = focus ? { total: scoped.reduce((sum, row) => sum + row.zip_count, 0), mapped: scoped.reduce((sum, row) => sum + row.mapped_count, 0), missing: missing.length, missing_no_zcta: missing.filter(row => row.reason === 'no_zcta').length, missing_not_checked: missing.filter(row => row.reason === 'not_checked').length } : next.coverage; search.disabled = false;
    const conflicts = data.cross_station_conflicts || [];
    element('conflicts-details').hidden = conflicts.length === 0; element('conflicts-details').open = false;
    element('conflicts-title').textContent = t.crossStation; element('conflicts').replaceChildren();
    for (const conflict of conflicts) element('conflicts').append(text('li', `${conflict.postal_code} · ${conflict.stations.join(' / ')}`));
    const { total, mapped, missing_no_zcta, missing_not_checked } = coverage;
    element('coverage').textContent = total > 0 ? `${(mapped / total * 100).toFixed(2)}%` : '—';
    element('coverage-count').textContent = t.coverageCount(mapped, total);
    syncCoverageControl();
    element('regenerate').hidden = false;
    element('regenerate').textContent = t.missingCount(missing_no_zcta, missing_not_checked);
    element('regenerate').className = missing_not_checked > 0 ? 'map-warning' : '';
    element('source').textContent = t.boundaries(data.boundary_source.dataset, data.boundary_source.vintage);
    const times = data.stations?.filter(station => !focus || station.code === focus) || [];
    element('updated').textContent = mapUpdatedSummary(times, data.fetched_at);
    const detail = element('station-times');
    if (detail) detail.textContent = times.length ? times.map(station => station.code + ' ' + formatUpdated(station.fetched_at)).join(' · ') : formatUpdated(data.fetched_at);
    element('updated').removeAttribute('title');
    element('missing-title').textContent = t.missingTitle(coverage.missing);
    element('missing-details').open = false; element('missing').replaceChildren();
    for (const row of missing) {
      const tr = text('tr', ''); tr.append(text('td', row.postal_code), text('td', row.station), text('td', row.route_name),
        text('td', row.reason === 'no_zcta' ? t.noZcta : t.notChecked)); element('missing').append(tr);
    }
    element('missing-empty').hidden = missing.length !== 0; renderRoutes();
  }
  function setColorMode(mode) { colorMode = mode; applySelection(selection); }
  function setDsp(value) { dsp = value; renderRoutes(); }
  function closeCoverage() {
    if (!coveragePanel || coveragePanel.hidden) return false;
    setCoverageOpen(false); coverageToggle.focus(); return true;
  }
  return { render, clear, applySelection, searchStatus, setColorMode, setDsp, closeCoverage };
}
