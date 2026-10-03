import { formatNumber, formatUpdated, formatValue } from './format.js';
import { routeColor } from './route-colors.js';
import { searchRoutes, classifyQuery, clearSelection } from './map-state.js';
import { mapText as t } from './map-text.js';

export function createMapPanel({ document: doc, onRoute, onClear, onSearch }) {
  const element = id => doc.getElementById(`map-${id}`);
  const text = (tag, value, className) => {
    const node = doc.createElement(tag); node.textContent = value;
    if (className) node.className = className;
    return node;
  };
  const entry = (label, value) => { const node = text('div', ''); node.append(text('dt', label), text('dd', formatValue(value))); return node; };
  let data, selection = clearSelection();
  const search = element('search');
  function renderRoutes() {
    const query = search.value || '', classified = classifyQuery(query);
    const { matches } = searchRoutes(data?.routes || [], classified.kind === 'zip' ? '' : query);
    element('routes').replaceChildren();
    element('no-match').hidden = matches.length !== 0;
    element('search-hint').hidden = !classified.zipHint;
    for (const route of matches) {
      const button = text('button', ''); button.type = 'button'; button.className = 'map-route';
      button.setAttribute('aria-pressed', String(selection.route !== null && selection.route.route_id === route.route_id));
      const swatch = text('span', '', 'map-swatch'); swatch.style.backgroundColor = routeColor(route.route_id);
      button.append(swatch, text('span', route.route_name), text('span', `${route.zip_count} ZIP`));
      button.addEventListener('click', () => onRoute(route.route_id)); element('routes').append(button);
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
    element('clear').disabled = !next.route && !next.zip;
    const current = text('dl', '');
    current.append(entry(t.station, next.station), entry(t.route, next.route?.route_name));
    const zipEntry = entry(t.zip, next.zip?.postal_code);
    if (next.zip) zipEntry.children[1].append(text('span', t.statuses[next.zip.status], 'map-badge'));
    current.append(zipEntry); element('current').replaceChildren(current);
    element('summary').replaceChildren();
    element('summary-panel').hidden = !next.route;
    const route = next.route && (data?.routes.find(row => row.route_id === next.route.route_id) || next.route);
    if (route) {
      const name = text('h3', formatValue(route.route_name), 'map-route-name');
      const owner = text('p', `${t.station} ${formatValue(route.station)} · DSP ${formatValue(route.dsp_name)}`);
      const metrics = text('dl', '', 'map-summary-metrics');
      const count = entry(t.zipCount, formatNumber(route.zip_count, 0));
      count.append(text('small', t.mapped(formatValue(route.mapped_count))));
      metrics.append(count, entry('Pickup Volume', formatNumber(route.pickup_volume, 0)), entry('PPH', formatNumber(route.pph, 2, 2)));
      element('summary').append(name, owner, metrics, text('p', `${t.updated} ${formatUpdated(next.zip?.fetched_at || data?.fetched_at)}`));
      if (route.mapped_count === 0) element('summary').append(text('p', t.noMapped));
      element('snapshot-source').textContent = t.source;
    } else element('snapshot-source').textContent = '';
    element('selection').replaceChildren();
    element('zip-panel').hidden = !next.zip;
    if (next.zip) {
      const dl = text('dl', ''); dl.append(entry('ZIP', next.zip.postal_code));
      dl.append(text('span', t.statuses[next.zip.status], 'map-badge'));
      if (next.route) dl.append(entry(t.station, next.station), entry(t.route, next.route.route_name));
      element('selection').append(dl, text('p', t.zipNotes[next.zip.status]));
    }
  }
  function searchStatus(state, value = '') {
    element('search-message').textContent = value;
    element('search-message').className = state === 'error' ? 'map-error' : 'snapshot';
    element('search-message').setAttribute('role', state === 'error' ? 'alert' : 'status');
  }
  function clear() {
    data = null; search.value = ''; search.disabled = true;
    applySelection(clearSelection());
    element('no-match').hidden = true; searchStatus('success');
    element('coverage').textContent = '—'; element('coverage-count').textContent = '';
    element('missing').replaceChildren(); element('missing-details').open = false;
    element('missing-title').textContent = t.missingTitle(0);
    element('missing-empty').hidden = true; element('regenerate').hidden = true;
    element('source').textContent = ''; element('updated').textContent = '—'; element('updated').removeAttribute('title');
  }
  function render(next) {
    data = next; search.disabled = false;
    const { total, mapped, missing_no_zcta, missing_not_checked } = data.coverage;
    element('coverage').textContent = total > 0 ? `${(mapped / total * 100).toFixed(2)}%` : '—';
    element('coverage-count').textContent = t.coverageCount(mapped, total);
    element('regenerate').hidden = false;
    element('regenerate').textContent = t.missingCount(missing_no_zcta, missing_not_checked);
    element('regenerate').className = missing_not_checked > 0 ? 'map-warning' : '';
    element('source').textContent = t.boundaries(data.boundary_source.dataset, data.boundary_source.vintage);
    element('updated').textContent = formatUpdated(data.fetched_at);
    if (element('updated').textContent !== '—') element('updated').title = data.fetched_at;
    element('missing-title').textContent = t.missingTitle(data.coverage.missing);
    element('missing-details').open = false; element('missing').replaceChildren();
    for (const row of data.missing) {
      const tr = text('tr', ''); tr.append(text('td', row.postal_code), text('td', row.route_name),
        text('td', row.reason === 'no_zcta' ? t.noZcta : t.notChecked)); element('missing').append(tr);
    }
    element('missing-empty').hidden = data.missing.length !== 0; renderRoutes();
  }
  return { render, clear, applySelection, searchStatus };
}
