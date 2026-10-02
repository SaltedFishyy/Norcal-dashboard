import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { startApiServer } from '../src/api/server.js';
import { createRequestHandler } from '../src/api/app.js';
import { formatValue, formatNumber, formatUpdated, pageState } from '../../web/format.js';

const webDir = fileURLToPath(new URL('../../web/', import.meta.url));
const assets = [['/', 'index.html', 'text/html'], ['/styles.css', 'styles.css', 'text/css'],
  ['/app.js', 'app.js', 'text/javascript'], ['/format.js', 'format.js', 'text/javascript']];

async function fixture(t, options = {}) {
  // A temporary directory ensures these tests never read the real runtime snapshot.
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-t7-'));
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  const logs = [];
  const server = await startApiServer({ port: 0, runtimeDir, log: (line) => logs.push(line), ...options });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return { server, logs, url: `http://127.0.0.1:${server.address().port}` };
}

test('T7 fixed assets serve exact files with security headers', async (t) => {
  const { url, logs } = await fixture(t);
  for (const [route, filename, type] of assets) {
    const response = await fetch(url + route, { headers: { Origin: 'https://example.invalid' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), `${type}; charset=utf-8`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('content-security-policy'), "default-src 'self'; frame-ancestors 'none'");
    assert.equal([...response.headers.keys()].some((key) => key.startsWith('access-control-')), false);
    assert.equal(await response.text(), await fs.readFile(path.join(webDir, filename), 'utf8'));
  }
  assert.deepEqual(logs, assets.map(() => 'HTTP 200'));
});

function rawRequest(server, pathname, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: server.address().port, path: pathname, method }, (res) => {
      let text = '';
      res.setEncoding('utf8'); res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    request.on('error', reject); request.end();
  });
}

test('T7 raw traversal and non-whitelisted paths are rejected', async (t) => {
  const { server } = await fixture(t);
  // http.request preserves dot segments that fetch would normalize before sending.
  for (const pathname of ['/../package.json', '/%2e%2e/package.json', '/web/app.js', '/index.html',
    '/legacy/', '/web/../app.js', '/%2e/', '/foo/../', '//', '/%61pp.js', '/app.js/']) {
    const response = await rawRequest(server, pathname);
    assert.equal(response.status, 404, pathname);
    assert.deepEqual(JSON.parse(response.text), { error: 'not_found' });
  }
});

test('T7 static assets reject non-GET methods', async (t) => {
  const { server } = await fixture(t);
  for (const [route] of assets) {
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD']) {
      const response = await rawRequest(server, route, method);
      assert.equal(response.status, 405);
      assert.equal(response.headers.allow, 'GET');
      if (method === 'HEAD') assert.equal(response.text, '');
      else assert.deepEqual(JSON.parse(response.text), { error: 'method_not_allowed' });
    }
  }
});

test('T7 webDir override and missing asset errors are sanitized', async (t) => {
  const alternate = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-t7-web-'));
  t.after(() => fs.rm(alternate, { recursive: true, force: true }));
  await fs.writeFile(path.join(alternate, 'index.html'), '<p>Mock web root</p>');
  const { url, logs } = await fixture(t, { webDir: alternate });
  assert.equal(await (await fetch(url + '/')).text(), '<p>Mock web root</p>');
  const response = await fetch(url + '/styles.css?secret=private');
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'internal_error' });
  assert.deepEqual(logs, ['HTTP 200', 'HTTP 500']);
  const health = await fetch(url + '/api/health');
  assert.equal(health.headers.get('content-security-policy'), null);
  assert.deepEqual(await health.json(), { ok: true });
});

test('T7 handler uses injected asset reader and only logs status', async (t) => {
  const logs = [];
  const calls = [];
  const server = http.createServer(createRequestHandler({
    getSnapshot: async () => { assert.fail('Static requests must not read snapshots'); },
    getStaticFile: async (pathname) => {
      calls.push(pathname);
      if (pathname !== '/') throw new Error('C:/private/path secret stack');
      return { body: 'injected', contentType: 'text/html; charset=utf-8' };
    }, log: (line) => logs.push(line),
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  assert.equal((await rawRequest(server, '/?secret=value')).text, 'injected');
  const response = await rawRequest(server, '/app.js');
  assert.equal(response.status, 500);
  assert.deepEqual(JSON.parse(response.text), { error: 'internal_error' });
  assert.deepEqual(calls, ['/', '/app.js']);
  assert.deepEqual(logs, ['HTTP 200', 'HTTP 500']);
});

test('T7 formatting preserves values and handles missing or invalid numbers', () => {
  for (const value of [null, undefined, '']) assert.equal(formatValue(value), '—');
  for (const value of [null, undefined, '', NaN, Infinity]) assert.equal(formatNumber(value), '—');
  assert.equal(formatValue(0), '0');
  assert.equal(formatValue('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>');
  assert.equal(formatValue('S'), 'S');
  assert.equal(formatNumber(12345), '12,345');
  assert.equal(formatNumber(12.345), '12.35');
  assert.equal(formatNumber(0), '0');
  assert.equal(formatNumber(1.2), '1.2');
});

test('T7 column formats use integer volume and fixed two decimal metrics', () => {
  assert.equal(formatNumber(1150, 0, 0), '1,150');
  assert.equal(formatNumber(1150.4, 0, 0), '1,150');
  for (const [value, expected] of [[30, '30.00'], [22.5, '22.50'], [21.37, '21.37'],
    [3.9, '3.90'], [55.7, '55.70'], [0, '0.00']]) {
    assert.equal(formatNumber(value, 2, 2), expected);
  }
  for (const digits of [0, 2]) {
    for (const value of [null, undefined, '', NaN, Infinity, -Infinity]) {
      assert.equal(formatNumber(value, digits, digits), '—');
    }
  }
});

test('T7 Last Updated shows local minutes and timezone, invalid dates are empty', () => {
  for (const value of [null, undefined, '', 'invalid', '2026-99-99', 0]) assert.equal(formatUpdated(value), '—');
  const iso = '2026-10-01T18:20:35Z';
  const date = new Date(iso);
  const formatted = formatUpdated(iso);
  assert.match(formatted, /^2026-10-\d{2} \d{2}:\d{2} .+$/);
  const hour = String(date.getHours()).padStart(2, '0');
  assert.ok(formatted.includes(`${hour}:20`));
  const zone = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(date)
    .find((part) => part.type === 'timeZoneName').value;
  assert.ok(formatted.endsWith(zone));
});

test('T7 page states cover loading, success, no data and sanitized errors', () => {
  assert.equal(pageState({ loading: true }).state, 'loading');
  assert.equal(pageState({ status: 200, data: { rows: [{}] } }).state, 'success');
  assert.equal(pageState({ status: 200, data: { rows: [] } }).state, 'empty');
  for (const error of ['snapshot_not_found', 'station_not_found']) {
    assert.equal(pageState({ status: 404, data: { error } }).state, 'empty');
    assert.equal(pageState({ status: 500, data: { error } }).state, 'error');
  }
  for (const [status, error] of [[400, 'invalid_station'], [500, 'snapshot_invalid'], [500, 'internal_error']]) {
    const result = pageState({ status, data: { error } });
    assert.equal(result.state, 'error'); assert.ok(result.message.includes(error));
  }
  assert.equal(pageState({ failed: true }).message, 'Cannot reach the local server.');
  assert.equal(pageState({ status: 200, data: {} }).state, 'error');
  assert.doesNotMatch(pageState({ status: 500, data: { error: 'C:/private/path stack' } }).message, /private|stack|C:/);
});

test('T7 frontend structure and safe rendering use no external resources', async () => {
  const sources = await Promise.all(assets.map(([, filename]) => fs.readFile(path.join(webDir, filename), 'utf8')));
  const [html, css, app] = sources;
  assert.match(html, /North California Route Profile/);
  for (const label of ['Station', 'SFO01', 'Last Updated', 'Total Routes', 'Snapshot from DMS — not live data',
    'Route Name', 'DSP / Fleet', 'Pickup Volume', 'PPH', 'First-mile Distance (mi)', 'Route Difficulty', 'Manual Difficulty']) {
    assert.ok(html.includes(label), label);
  }
  assert.equal((html.match(/<th scope=/g) || []).length, 7);
  assert.match(html, /<script type="module" src="\/app.js"><\/script>/);
  assert.doesNotMatch(html, /style=|<script(?![^>]*src=)/);
  for (const source of sources) assert.doesNotMatch(source, /https?:\/\/|Daily Volume/);
  assert.doesNotMatch(app, /innerHTML|address_type_distribution|parse_errors/);
  assert.match(app, /fetch\('\/api\/route-profiles\?station=SFO01'/);
  assert.match(app, /updated.title = data.fetched_at/);
  assert.match(css, /overflow-x: auto/);
});

test('T7 app renders API order and text safely, and handles retries and failures', async (t) => {
  // Minimal DOM doubles exercise the actual app module without a browser or DOM dependency.
  class Element {
    constructor() { this.children = []; this.textContent = ''; this.attributes = {}; this.listeners = {}; }
    append(...children) {
      for (const child of children) {
        if (child.fragment) this.children.push(...child.children);
        else this.children.push(child);
      }
    }
    replaceChildren() { this.children = []; }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; if (name === 'title') delete this.title; }
    addEventListener(name, handler) { this.listeners[name] = handler; }
  }
  const elements = Object.fromEntries(['updated', 'total', 'rows', 'table-container', 'message', 'retry', 'profiles']
    .map((id) => [id, new Element()]));
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousFetch = globalThis.fetch;
  t.after(() => {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete globalThis.document;
    globalThis.fetch = previousFetch;
  });
  globalThis.document = {
    getElementById: (id) => elements[id], createElement: () => new Element(),
    createDocumentFragment: () => Object.assign(new Element(), { fragment: true }),
  };
  let reply;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let requests = 0;
  globalThis.fetch = async (url, options) => {
    requests++;
    assert.equal(url, '/api/route-profiles?station=SFO01');
    assert.equal(options.cache, 'no-store');
    if (requests === 1) await pending;
    if (reply instanceof Error) throw reply;
    return reply;
  };
  await import('../../web/app.js');
  assert.equal(elements.message.textContent, 'Loading route profiles…');
  assert.equal(elements.profiles.attributes['aria-busy'], 'true');
  const iso = '2026-10-01T18:20:35Z';
  const malicious = '<img src=x onerror=alert(1)>';
  reply = { status: 200, json: async () => ({ fetched_at: iso, total: 2, rows: [
    { route_name: 'Mock Z', dsp_name: malicious, pickup_volume: 12345, pph: 2.345,
      first_mile_distance: 1.2, route_difficulty: 'S', route_difficulty_manual: null },
    { route_name: 'Mock A', dsp_name: '', pickup_volume: null, pph: null },
  ] }) };
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements['table-container'].hidden, false);
  assert.equal(elements.updated.title, iso);
  assert.equal(elements.updated.textContent, formatUpdated(iso));
  assert.equal(elements.total.textContent, '2');
  const rendered = elements.rows.children;
  assert.equal(rendered.length, 2);
  assert.deepEqual(rendered[0].children.slice(0, 5).map((cell) => cell.textContent),
    ['Mock Z', malicious, '12,345', '2.35', '1.20']);
  assert.equal(rendered[0].children[5].children[0].textContent, 'S');
  assert.equal(rendered[0].children[6].textContent, '—');
  assert.equal(rendered[0].children[6].children.length, 0);
  assert.equal(rendered[1].children[0].textContent, 'Mock A');
  assert.equal(rendered[1].children[1].textContent, '—');
  for (const value of [null, undefined, '']) {
    reply = { status: 200, json: async () => ({ total: 1, rows: [{
      route_name: 'SFO02-042', pickup_volume: 1150, pph: 30, first_mile_distance: 3.9,
      route_difficulty: value, route_difficulty_manual: value,
    }] }) };
    await elements.retry.listeners.click();
    const cells = elements.rows.children[0].children;
    assert.deepEqual(cells.slice(0, 5).map((cell) => cell.textContent),
      ['SFO02-042', '—', '1,150', '30.00', '3.90']);
    for (const cell of cells.slice(5)) {
      assert.equal(cell.textContent, '—');
      assert.equal(cell.children.length, 0);
    }
  }
  reply = { status: 200, json: async () => ({ total: 1, rows: [{
    pickup_volume: null, pph: null, first_mile_distance: null,
    route_difficulty: 'A级 难', route_difficulty_manual: 'B级 中',
  }] }) };
  await elements.retry.listeners.click();
  const cells = elements.rows.children[0].children;
  assert.deepEqual(cells.slice(2, 5).map((cell) => cell.textContent), ['—', '—', '—']);
  for (const [index, expected] of [[5, 'A级 难'], [6, 'B级 中']]) {
    assert.equal(cells[index].children.length, 1);
    assert.equal(cells[index].children[0].className, 'difficulty');
    assert.equal(cells[index].children[0].textContent, expected);
  }
  for (const failure of [
    { status: 404, json: async () => ({ error: 'snapshot_not_found' }) },
    { status: 500, json: async () => ({ error: 'snapshot_invalid' }) },
    new Error('C:/secret/path stack'),
    { status: 200, json: async () => { throw new SyntaxError('private-path'); } },
  ]) {
    reply = failure;
    await elements.retry.listeners.click();
    assert.equal(elements['table-container'].hidden, true);
    assert.equal(elements.retry.hidden, false);
    assert.equal(elements.rows.children.length, 0);
    assert.doesNotMatch(elements.message.textContent, /secret|stack|private-path/);
  }
  assert.equal(requests, 9);
});
