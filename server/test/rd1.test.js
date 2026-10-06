import { difficultyColor, difficultyLevel } from '../../web/difficulty.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { transformRouteDetail } from '../src/transform/route-detail.js';
import { SchemaError } from '../src/transform/route-profile.js';
import { StoreError } from '../src/store/route-profiles-file.js';
import { saveRouteDetail, getRouteDetail, RouteDetailNotFoundError, RouteDetailInvalidError } from '../src/store/route-details-file.js';
import { captureRouteDetail } from '../src/dms/route-detail-page.js';
import { captureRoutePortrait, NeedsLoginError, CaptureError, SelectorError, LoadLimitError, CircuitBreakerError } from '../src/dms/route-profile-page.js';
import { runRouteDetailScrape } from '../bin/dms-scrape-route-detail.js';
import { runRouteDetailsBatch } from '../bin/dms-scrape-route-details.js';
import { parseMaxRouteDetailRequests } from '../src/config.js';
import { createRequestHandler } from '../src/api/app.js';
import { startApiServer } from '../src/api/server.js';
import { formatPercent, difficultyTone, formatUpdated } from '../../web/format.js';
import { openRouteDetail } from '../../web/route-detail.js';

// All fixtures and page doubles use synthetic data, never local session or runtime files.
const contentBody = JSON.parse(await fs.readFile(new URL('./fixtures/route-detail-content.json', import.meta.url), 'utf8'));
const headerBody = JSON.parse(await fs.readFile(new URL('./fixtures/route-detail-header.json', import.meta.url), 'utf8'));
const metadata = { station: 'SFO01', routeId: 900101, fetchedAt: '2026-10-02T12:00:00Z' };
const input = () => structuredClone({ contentBody, headerBody });
const transform = (body = input(), options = metadata) => transformRouteDetail(body, options);
async function temporary(t) {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-rd1-'));
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  return runtimeDir;
}

test('RD1 synthetic transform maps every field without mutating raw values or percentages', () => {
  const body = input(), before = structuredClone(body);
  const { route, warnings } = transform(body);
  assert.deepEqual(body, before); assert.deepEqual(warnings, []);
  assert.deepEqual(Object.keys(route).sort(), ['route_id', 'station', 'route_name', 'route_difficulty', 'route_difficulty_code', 'fetched_at', 'source', 'zip_count', 'zips', 'parse_errors'].sort());
  assert.equal(route.station, 'SFO01'); assert.equal(route.route_name, 'MOCK-001');
  assert.equal(route.route_id, 900101); assert.equal(route.fetched_at, metadata.fetchedAt);
  assert.equal(route.source, 'dms-playwright'); assert.equal(route.zip_count, 3);
  assert.equal(route.route_difficulty, 'A级 难'); assert.equal(route.route_difficulty_code, '3');
  assert.deepEqual(route.zips[0], {
    postal_code: '00123', postal_code_tag: '1', postal_code_difficulty: 'A级 难', first_mile_distance: 12.34,
    experienced_pph: 23.45, delivery_fail_rate: .0047, dnr_rate: .5, safety_level: '安全', raw: contentBody.data[0], parse_errors: [],
  });
  assert.equal(route.zips[1].experienced_pph, null); assert.equal(route.zips[1].postal_code_difficulty, null);
  assert.equal(route.zips[2].dnr_rate, 0); assert.equal(route.zips[2].postal_code_tag, null);
  assert.deepEqual(route.zips[1].parse_errors, []);
});

test('RD1 transform preserves nulls, flags invalid types and ZIP counts without repair', () => {
  for (const bad of ['12.3', true, {}, [], Infinity, NaN]) {
    const body = input(); body.contentBody.data[0].experiencedPph = bad;
    const zip = transform(body).route.zips[0];
    assert.equal(zip.experienced_pph, null); assert.ok(zip.parse_errors.some((error) => error.field === 'experienced_pph'));
  }
  for (const bad of [null, undefined, '', 123, true]) {
    const body = input(); body.contentBody.data[0].postalCode = bad;
    assert.ok(transform(body).route.zips[0].parse_errors.some((error) => error.field === 'postal_code'));
  }
  const body = input();
  delete body.contentBody.data[0].experiencedPph;
  body.contentBody.data[0].postalCodeTag = 1;
  body.contentBody.data[0].postalCodeDifficulty = {};
  body.contentBody.data[0].safetyLevel = true;
  body.headerBody.data.postalCodeNum = 99;
  const { route } = transform(body);
  assert.equal(route.zip_count, 99); assert.equal(route.zips.length, 3);
  assert.deepEqual(route.parse_errors, [{ field: 'zip_count' }]);
  assert.equal(route.zips[0].experienced_pph, null);
  assert.deepEqual(route.zips[0].parse_errors.map((error) => error.field), ['postal_code_tag', 'postal_code_difficulty', 'safety_level']);
  body.headerBody.data.postalCodeNum = '3'; assert.equal(transform(body).route.zip_count, null);
});

test('RD1 transform rejects duplicate ZIPs, invalid top-level responses and metadata', () => {
  const body = input(); body.contentBody.data[1].postalCode = body.contentBody.data[0].postalCode;
  assert.throws(() => transform(body), SchemaError);
  for (const change of [
    (b) => { b.contentBody.data = {}; }, (b) => { b.headerBody.data = []; },
    (b) => { b.contentBody.data = [null]; }, (b) => { delete b.headerBody.data.roadAreaName; },
  ]) { const b = input(); change(b); assert.throws(() => transform(b), SchemaError); }
  for (const options of [{ ...metadata, routeId: 0 }, { ...metadata, station: '' }, { ...metadata, fetchedAt: 'invalid' }]) {
    assert.throws(() => transform(input(), options), SchemaError);
  }
});

test('RD1 store creates and atomically upserts only one route; API never exposes raw', async (t) => {
  const runtimeDir = await temporary(t), events = [];
  await assert.rejects(getRouteDetail({ runtimeDir, routeId: 900101 }), RouteDetailNotFoundError);
  const route = transform().route;
  const fileOps = { ...fs,
    writeFile: async (...args) => { events.push(['write', args[0]]); return fs.writeFile(...args); },
    rename: async (...args) => { events.push(['rename', ...args]); return fs.rename(...args); },
  };
  const filename = await saveRouteDetail({ runtimeDir, route, fileOps });
  assert.deepEqual(events[1], ['rename', events[0][1], filename]); assert.notEqual(events[0][1], filename);
  await saveRouteDetail({ runtimeDir, route: { ...route, route_id: 900102, route_name: 'MOCK-002' } });
  await saveRouteDetail({ runtimeDir, route: { ...route, zip_count: 99 } });
  const file = JSON.parse(await fs.readFile(filename, 'utf8'));
  assert.equal(file.schema_version, 1); assert.equal(file.routes['900102'].route_name, 'MOCK-002');
  assert.equal(file.routes['900101'].zip_count, 99);
  assert.deepEqual(await fs.readdir(runtimeDir), ['route-details.json']);
  const result = await getRouteDetail({ runtimeDir, routeId: 900101 });
  assert.equal(result.zips[0].delivery_fail_rate, .0047);
  assert.ok(result.zips.every((zip) => !Object.hasOwn(zip, 'raw')));
  assert.equal(Object.hasOwn(result, 'source'), false);
  await assert.rejects(getRouteDetail({ runtimeDir, routeId: 900103 }), RouteDetailNotFoundError);
});

test('RD1 corrupt stores and failed rename preserve old bytes and clean temporary files', async (t) => {
  const runtimeDir = await temporary(t), filename = path.join(runtimeDir, 'route-details.json');
  const route = transform().route;
  for (const invalid of ['broken', 'null', '{"schema_version":2,"routes":{}}', '{"schema_version":1,"routes":{"900101":{}}}']) {
    await fs.writeFile(filename, invalid);
    await assert.rejects(saveRouteDetail({ runtimeDir, route }), StoreError);
    await assert.rejects(getRouteDetail({ runtimeDir, routeId: 900101 }), RouteDetailInvalidError);
    assert.equal(await fs.readFile(filename, 'utf8'), invalid);
  }
  await fs.writeFile(filename, JSON.stringify({ schema_version: 1, routes: { '900101': route } }));
  const old = await fs.readFile(filename, 'utf8');
  await assert.rejects(saveRouteDetail({ runtimeDir, route: { ...route, zip_count: 50 }, fileOps: { ...fs, rename: async () => { throw new Error('private path'); } } }), StoreError);
  assert.equal(await fs.readFile(filename, 'utf8'), old); assert.deepEqual(await fs.readdir(runtimeDir), ['route-details.json']);
  for (const field of Object.keys(route)) {
    const damaged = { ...route }; delete damaged[field];
    await fs.writeFile(filename, JSON.stringify({ schema_version: 1, routes: { '900101': damaged } }));
    await assert.rejects(getRouteDetail({ runtimeDir, routeId: 900101 }), RouteDetailInvalidError, field);
  }
});

// Small tree double executes the actual selector callbacks, including fixed-column duplicates.
class Tree {
  constructor(tag, text = '', children = [], visible = true) {
    this.tag = tag; this.value = text; this.children = children; this.visible = visible; this.attributes = {};
    children.forEach((child) => { child.parentElement = this; });
  }
  get textContent() { return this.value + this.children.map((child) => child.textContent).join(''); }
  querySelectorAll(selector) { return this.children.flatMap((child) => [...(selector === '*' || child.tag === selector || selector === 'tr[rowid]' && child.tag === 'tr' || selector.includes('.') && child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  matches(selector) {
    const [tag, className] = selector.split('.');
    return (!tag || this.tag === tag) && (!className || (this.className || '').split(/\s+/).includes(className));
  }
  getClientRects() { return this.visible ? [{}] : []; }
  contains(other) { return this === other || this.children.some((child) => child.contains(other)); }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  get classList() { return { contains: value => (this.className || '').split(/\s+/).includes(value) }; }
  scrollIntoView() { this.scrolled = true; }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector); }
  getBoundingClientRect() { return this.rect ?? { left: 0, top: 0, right: 100, bottom: 100 }; }
}
function evaluate(fn, nodes, argument, hitBlocked = false) {
  const oldDocument = globalThis.document, oldStyle = globalThis.getComputedStyle;
  globalThis.document = { querySelectorAll: () => nodes.flatMap((node) => [node, ...node.querySelectorAll('*')]).filter((node) => Object.keys(node.attributes).some(key => key.startsWith('data-rd'))),
    elementFromPoint: () => hitBlocked ? null : nodes.flatMap(node => node.querySelectorAll('*')).find(node => node.value === '画像详情') };
  globalThis.getComputedStyle = node => ({ visibility: node.hidden ? 'hidden' : 'visible', overflowY: node.overflowY || 'visible' });
  try { return fn(nodes, argument); }
  finally {
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
    if (oldStyle === undefined) delete globalThis.getComputedStyle; else globalThis.getComputedStyle = oldStyle;
  }
}

function pageHarness({ records, login = false, password = false, status, listRequests = 1, detailRequests = 2,
  wrongId, wrongHeaderId, wrongHeader, virtual = false, missingRow = false, ambiguousAction = false, ambiguousDetail = false, mixedSection = false,
  modalDelay = 0, detailDelay = 0, missingDetail = false, actionError, actionDelay = 0, missingAction = false,
  missingModal = false, pendingNavigation = false, navigationStatus, navigationPaths = [],
  changedRowId = false, occludedFor = 0, hitBlockedFor = 0, wrongCapacityId, wrongPostalId, wrongCapacityName = false,
  capacityTitle = '业务属性（产能）- 详情', capacityName = 'MOCK-001', capacityLinks = 1, postalLinks = 1,
  postalSelected = false, autoPostal = false, unknownTabs = false, stalePostal = false, postalTimeout = false,
  countCapacityRequests = false, tabsDelay = 0, bothTabs = false, clickDelay = 0, postalStuck = false, dateStuck = false,
  separateGroups = false, missingLabel = false, inputOnly = false, classOnly = false,
  loadingMs = 0, resetScroll = false, ineffectiveMain = false, actualScroller = false, wheelWorks = false,
  routeFilter = false, filterLabel = '路区名称', filteredRecords, duplicateRow = false } = {}) {
  const page = new EventEmitter(), clicks = [], logs = [], waits = [];
  const listeners = new Set();
  const capacityListeners = new Map();
  const emitCapacity = (endpoint, id = 900101) => {
    const req = { ...detailRequest(endpoint), postDataJSON: () => ({ roadAreaId: id }) };
    if (countCapacityRequests) page.emit('request', req);
    const reply = response(req, endpoint.endsWith('/header')
      ? { data: { roadAreaName: wrongCapacityName ? 'OTHER' : 'MOCK-001' } } : { data: [] });
    const waiting = capacityListeners.get(endpoint);
    if (waiting?.predicate(reply)) waiting.resolve(reply);
  };
  let closes = 0, scrolled = false, modalEvaluations = 0, detailEvaluations = 0;
  const list = { data: { records: records ?? [{ roadAreaId: 900101, roadAreaName: 'MOCK-001-extra', transitStationName: 'SFO01' }, { roadAreaId: 900101, roadAreaName: 'MOCK-001', transitStationName: 'SFO01' }] } };
  const request = (suffix, body) => ({ url: () => `https://example.invalid/prod-api/dlvs-dataApi/roadAreaPortrait/home/${suffix}`, method: () => 'POST', postDataJSON: () => body });
  const listRequest = () => request('frontPage/queryList/pagination', { transitStationCodeList: ['SFO01'], pageSize: 100 });
  const detailRequest = (endpoint) => request(`roadAreaPortraitDetails/details/${endpoint}`, { roadAreaId: endpoint === 'getRoadAreaHeader' ? wrongHeaderId ?? wrongId ?? 900101 : wrongId ?? 900101 });
  const response = (req, body) => ({ url: req.url, request: () => req, status: () => 200, json: async () => body });
  const row = new Tree('tr', '', [new Tree('td', 'MOCK-001')]); row.setAttribute('rowid', 'mock-row');
  const bodyNode = new Tree('div'); bodyNode.clientHeight = 100; bodyNode.scrollTop = 0;
  bodyNode.className = 'vxe-table--body-wrapper'; row.parentElement = bodyNode;
  bodyNode.children = [row];
  const mainWrapper = new Tree('div', '', [bodyNode]); mainWrapper.className = 'vxe-table--main-wrapper';
  const scrollBar = new Tree('div'); scrollBar.className = 'vxe-table--scroll-y'; scrollBar.overflowY = 'auto';
  scrollBar.clientHeight = 100; scrollBar.scrollHeight = 1000;
  const table = new Tree('div', '', [mainWrapper, scrollBar]); table.className = 'vxe-table is--virtual-y';
  let position = 0, reset = false, filtered = false;
  Object.defineProperty(bodyNode, 'scrollTop', { get: () => position, set: value => {
    if (ineffectiveMain) return;
    if (resetScroll && !reset) { reset = true; return; }
    position = value; row.scrolled = true;
  } });
  Object.defineProperty(scrollBar, 'scrollTop', { get: () => position, set: value => { if (actualScroller) { position = value; row.scrolled = true; } } });
  row.getBoundingClientRect = () => ({ left: 0, top: (filtered ? 10 : 320) - position, right: 100, bottom: (filtered ? 90 : 400) - position });
  const action = new Tree('button', '画像详情'), hiddenAction = new Tree('button', '画像详情'); hiddenAction.hidden = true;
  row.children.push(hiddenAction);
  const fixedRow = new Tree('tr', '', [action, ...(ambiguousAction ? [new Tree('button', '画像详情')] : [])]);
  fixedRow.setAttribute('rowid', 'mock-row');
  const fixedBody = new Tree('div', '', [fixedRow]); fixedBody.className = 'vxe-table--body-wrapper';
  const fixedWrapper = new Tree('div', '', [fixedBody]); fixedWrapper.className = 'vxe-table--fixed-right-wrapper';
  table.children.push(fixedWrapper); fixedWrapper.parentElement = table;
  const label = new Tree('span', '路区难易度'), link = new Tree('span', '详情 >');
  const section = new Tree('section', '', [label, link, ...(ambiguousDetail ? [new Tree('span', '详情 >')] : []), ...(mixedSection ? [new Tree('span', '基础属性')] : [])]);
  // Match the real ancestor chain and sibling sections without using real DMS data.
  const heading = new Tree('div', '', [label]);
  const difficultyRow = new Tree('div', '', [heading]);
  const content = new Tree('div', '', [difficultyRow]);
  const card = new Tree('div', '', [content]);
  const modalBody = new Tree('div', '', [card, new Tree('span', '基础属性'),
    ...Array.from({ length: 4 }, () => new Tree('div', '', [new Tree('span', '详情 >')]))]);
  const delayedDetail = detailDelay > 0 || missingDetail;
  if (!delayedDetail) label.parentElement = section;
  const modal = new Tree('div', '', [new Tree('h2', '路区画像详情'), new Tree('span', '路区名称：MOCK-001'), delayedDetail ? modalBody : section]);
  modal.className = 'dbuMicroSysApp-modal-content'; modal.children[0].className = 'dbuMicroSysApp-modal-title';
  const portraitClose = new Tree('button'); portraitClose.className = 'dbuMicroSysApp-modal-close';
  portraitClose.parentElement = modal; modal.children.push(portraitClose);
  const capacitySection = new Tree('section', '', [new Tree('span', '业务属性-产能（日均）'), ...Array.from({length: capacityLinks}, () => new Tree('span', '详情>'))]);
  modal.children.push(capacitySection); capacitySection.parentElement = modal;
  const makeModal = (title, children = []) => {
    const heading = new Tree('h2', title); heading.className = 'dbuMicroSysApp-modal-title';
    const close = new Tree('button'); close.className = 'dbuMicroSysApp-modal-close';
    const node = new Tree('div', '', [heading, close, ...children]); node.className = 'dbuMicroSysApp-modal-content';
    return node;
  };
  const labelModal = makeModal('标签详情');
  const dateTab = new Tree('label', '', [new Tree('input'), new Tree('span', '按日期')]);
  const postalTabs = Array.from({length: postalLinks}, () => new Tree('label', '', [new Tree('input'), new Tree('span', '按邮编')]));
  const setTabs = selected => {
    [dateTab, ...postalTabs].forEach((tab, index) => {
      const checked = !unknownTabs && (bothTabs || (index ? selected : !selected));
      tab.className = 'dbuMicroSysApp-radio-button-wrapper' + (!inputOnly && checked ? ' dbuMicroSysApp-radio-button-wrapper-checked' : '');
      tab.querySelector('input').checked = !classOnly && checked;
    });
  };
  setTabs(postalSelected);
  if (missingLabel) postalTabs.forEach(tab => { tab.tag = 'div'; });
  const radioGroup = new Tree('div', '', [dateTab, ...(!separateGroups ? postalTabs : [])]);
  radioGroup.className = 'dbuMicroSysApp-radio-group dbuMicroSysApp-radio-group-solid dbuMicroSysApp-radio-group-default';
  const otherGroup = new Tree('div', '', separateGroups ? postalTabs : []); otherGroup.className = 'dbuMicroSysApp-radio-group';
  const capacityModal = makeModal(capacityTitle, [new Tree('span', `路区名称：${capacityName}`), radioGroup, ...(separateGroups ? [otherGroup] : [])]);
  let tabElapsed = 0, pendingSelection;
  const outer = new Tree('div', '', [modal]);
  const filterHeading = new Tree('label', filterLabel); filterHeading.className = 'dbuMicroSysApp-form-item-label';
  const filterItem = new Tree('div', '', [filterHeading, new Tree('input')]); filterItem.className = 'dbuMicroSysApp-form-item';
  const locator = (selector, index = 0) => ({
    count: async () => selector === 'input[type=password]' ? Number(password) : selector === 'actions' ? 3
      : selector === '.dbuMicroSysApp-form-item' && routeFilter ? 2 : 1,
    nth: (i) => locator(selector, selector === 'portrait-action' ? index : i), first: () => locator(selector),
    filter: () => locator(selector === 'tr[rowid]' ? 'actions' : selector),
    locator: (value) => locator(value, index), getByText: (text) => locator(text === '画像详情' ? 'portrait-action' : 'station-option', index),
    innerText: async () => index === 1 && routeFilter ? filterLabel : '转运站点', getAttribute: async () => 'mock-row',
    fill: async value => { filtered = Boolean(value); position = 0; row.scrolled = true; },
    isVisible: async () => selector === 'portrait-action' ? !missingAction && waits.length >= actionDelay && (index === 1 || ambiguousAction && index === 0) : true,
    evaluateAll: async (fn, arg) => {
      if (selector === '.dbuMicroSysApp-form-item') return evaluate(fn, routeFilter ? [filterItem] : [], arg);
      if (selector.endsWith('tr[rowid]')) {
        const value = evaluate(fn, missingRow || virtual && !scrolled ? [] : duplicateRow ? [row, row] : [row], arg);
        if (bodyNode.scrollTop > 0) { row.scrolled = true; if (changedRowId) { row.setAttribute('rowid', 'new-row'); fixedRow.setAttribute('rowid', 'new-row'); } }
        return value;
      }
      if (selector.includes('fixed-right-wrapper')) {
        action.visible = !missingAction && waits.length >= actionDelay;
        action.rect = {left: 0, right: 20, top: waits.length < occludedFor ? 110 : (filtered ? 30 : 340) - position, bottom: waits.length < occludedFor ? 130 : (filtered ? 50 : 360) - position};
        return evaluate(fn, [fixedBody], arg, waits.length < hitBlockedFor);
      }
      if (selector.endsWith('.vxe-table--body-wrapper')) {
        table.className = 'vxe-table is--virtual-y' + (tabElapsed < loadingMs ? ' is--loading' : '');
        const value = evaluate(fn, [bodyNode], arg); scrolled = true; return value;
      }
      if (selector.includes('closing')) return evaluate(fn, [labelModal, capacityModal, modal].filter(node => node.getAttribute('data-rd3-modal')), arg);
      if (selector === '.dbuMicroSysApp-modal-content') {
        radioGroup.querySelectorAll('*').forEach(node => { node.visible = tabElapsed >= tabsDelay; });
        return evaluate(fn, [labelModal, capacityModal, ...(routeFilter ? [modal] : [])], arg);
      }
      if (delayedDetail && !missingDetail && arg?.section === '路区难易度' && detailEvaluations++ >= detailDelay && !difficultyRow.children.includes(link)) {
        difficultyRow.children.push(link); link.parentElement = difficultyRow;
      }
      return evaluate(fn, missingModal || modalEvaluations++ < modalDelay ? [] : [outer, modal, capacityModal], arg);
    },
    click: async () => {
      if (selector === '[data-rd1-target="difficulty"]') {
        assert.equal(link.getAttribute('data-rd1-target'), 'difficulty');
        assert.ok(modalBody.querySelectorAll('*').filter((node) => node !== link).every((node) => !node.getAttribute('data-rd1-target')));
      }
      if (selector === '[data-rd3-close="close"]') {
        for (const node of [labelModal, capacityModal, modal]) {
          if (node.querySelectorAll('*').some(child => child.getAttribute('data-rd3-close') === 'close')) node.visible = false;
        }
      }
      if (selector === 'query' && routeFilter) page.emit('request', listRequest());
      if (selector === '[data-rd1-target="capacity"]') {
        assert.ok(listeners.has('businessPropertiesProductionCapacity/header'));
        assert.ok(listeners.has('businessPropertiesProductionCapacity/details/postalCodeDimension'));
        emitCapacity('businessPropertiesProductionCapacity/header', wrongCapacityId ?? 900101);
        if (wrongCapacityId) capacityListeners.get('businessPropertiesProductionCapacity/header').reject(new Error('synthetic header timeout'));
        if (stalePostal) emitCapacity('businessPropertiesProductionCapacity/details/postalCodeDimension', 2);
        if (autoPostal) emitCapacity('businessPropertiesProductionCapacity/details/postalCodeDimension');
      }
      if (selector === '[data-rd1-target="postal"]') {
        assert.ok(listeners.has('businessPropertiesProductionCapacity/details/postalCodeDimension'));
        assert.equal(postalTabs[0].getAttribute('data-rd1-target'), 'postal');
        if (!postalStuck) { if (clickDelay) pendingSelection = { selected: true, at: tabElapsed + clickDelay }; else setTabs(true); }
        if (!postalTimeout) emitCapacity('businessPropertiesProductionCapacity/details/postalCodeDimension', wrongPostalId ?? 900101);
        if (wrongPostalId || postalTimeout) capacityListeners.get('businessPropertiesProductionCapacity/details/postalCodeDimension').reject(new Error('page.waitForResponse: Timeout 30000ms exceeded'));
      }
      if (selector === '[data-rd1-target="date"]') {
        assert.equal(dateTab.getAttribute('data-rd1-target'), 'date');
        if (!dateStuck) { if (clickDelay) pendingSelection = { selected: false, at: tabElapsed + clickDelay }; else setTabs(false); }
        if (countCapacityRequests) page.emit('request', detailRequest('businessPropertiesProductionCapacity/details/dayDimension'));
      }
      clicks.push(selector === '[data-rd1-row-action="portrait"]' ? 'portrait-action' : selector);
      if (selector === '[data-rd1-row-action="portrait"]') {
        assert.equal(row.scrolled, true);
        assert.equal(fixedRow.getAttribute('rowid'), row.getAttribute('rowid'));
        if (changedRowId) assert.equal(row.getAttribute('rowid'), 'new-row');
        assert.equal(action.getAttribute('data-rd1-row-action'), 'portrait');
        assert.equal(hiddenAction.getAttribute('data-rd1-row-action'), null);
        if (actionError) throw actionError;
        for (let i = 0; i < detailRequests; i++) page.emit('request', detailRequest('getRoadAreaContent'));
        if (status) page.emit('response', { url: () => 'https://example.invalid/prod-api/mock', status: () => status });
      }
    },
  });
  page.locator = locator; page.getByText = (text) => locator(text); page.getByRole = () => locator('query');
  page.keyboard = { press: async (key) => clicks.push(key) };
  page.mouse = { move: async () => {}, wheel: async (_x, y) => { if (wheelWorks) { position += y; row.scrolled = true; } } };
  page.waitForTimeout = async (milliseconds) => {
    waits.push({ milliseconds, clicks: [...clicks] }); tabElapsed += milliseconds;
    if (pendingSelection && tabElapsed >= pendingSelection.at) { setTabs(pendingSelection.selected); pendingSelection = undefined; }
  };
  page.goto = async () => {
    for (let i = 0; i < listRequests; i++) page.emit('request', listRequest());
    for (const suffix of navigationPaths) page.emit('request', suffix.startsWith('https://')
      ? { url: () => suffix } : request(suffix));
    if (navigationStatus) page.emit('response', { url: () => 'https://example.invalid/prod-api/mock', status: () => navigationStatus });
    if (pendingNavigation) {
      page.emit('response', { url: () => 'https://example.invalid/prod-api/mock', status: () => status });
      await new Promise(() => {});
    }
  };
  page.url = () => `https://example.invalid/${login ? 'login' : 'areaDepiction'}`;
  page.waitForResponse = async (predicate, options) => {
    const header = structuredClone(headerBody); if (wrongHeader) header.data.roadAreaName = 'OTHER-MOCK';
    const capacityReply = (endpoint, id, body) => response({ ...detailRequest(endpoint), postDataJSON: () => ({ roadAreaId: id ?? 900101 }) }, body);
    const filteredList = filteredRecords ?? [{ roadAreaId: 900101, roadAreaName: 'MOCK-001', transitStationName: 'SFO01' }];
    const replies = [response(listRequest(), filtered ? { data: { records: filteredList, total: filteredList.length } } : list), response(detailRequest('getRoadAreaContent'), contentBody), response(detailRequest('getRoadAreaHeader'), header),
      capacityReply('businessPropertiesProductionCapacity/header', wrongCapacityId, {data: {roadAreaName: wrongCapacityName ? 'OTHER' : 'MOCK-001'}}),
      capacityReply('businessPropertiesProductionCapacity/details/postalCodeDimension', wrongPostalId, {data: []})];
    for (const reply of replies) {
      assert.equal(predicate({ ...reply, request: () => ({ ...reply.request(), method: () => 'GET' }) }), false);
      const endpoint = new URL(reply.url()).pathname.split('/roadAreaPortraitDetails/details/')[1];
      if (endpoint?.startsWith('businessPropertiesProductionCapacity/')) {
        const current = { ...reply, request: () => ({ ...reply.request(), postDataJSON: () => ({ roadAreaId: 900101 }) }) };
        if (!predicate(current)) continue;
        assert.equal(predicate({ ...current, request: () => ({ ...current.request(), postDataJSON: () => ({ roadAreaId: 2 }) }) }), false);
        assert.equal(options.timeout, 30000);
        listeners.add(endpoint);
        return new Promise((resolve, reject) => capacityListeners.set(endpoint, { predicate, resolve, reject }));
      }
      if (predicate(reply)) {
        listeners.add(endpoint);
        return reply;
      }
    }
    throw new Error('No synthetic response matched');
  };
  const browserType = { launch: async () => ({ newContext: async () => ({ newPage: async () => page }), close: async () => { closes++; } }) };
  const options = { browserType, statePath: '/synthetic/not-read', baseUrl: 'https://example.invalid/areaDepiction', station: 'SFO01', log: (line) => logs.push(line) };
  return { clicks, logs, waits, page, get closes() { return closes; },
    run: (overrides = {}) => captureRouteDetail({ ...options, routeName: 'MOCK-001', ...overrides }),
    runPortrait: () => captureRoutePortrait(options) };
}

test('RD3-14 L0 waits for loading to disappear and fails after ten seconds without clicking', async () => {
  const ready = pageHarness({ loadingMs: 2000 });
  assert.equal((await ready.run()).locateMethod, 'L1');
  assert.equal(ready.waits.reduce((sum, wait) => sum + wait.milliseconds, 0), 2000);
  const busy = pageHarness({ loadingMs: Infinity });
  await assert.rejects(busy.run(), { name: 'SelectorError', message: '页面控件不可用：表格未就绪', attempts: [] });
  assert.equal(busy.waits.reduce((sum, wait) => sum + wait.milliseconds, 0), 10000);
  assert.ok(!busy.clicks.includes('portrait-action'));
});

test('RD3-14 L1 repositions after layout reset, L2 uses the actual scrollbar, L3 uses mouse wheel', async () => {
  for (const [options, method, attempts] of [
    [{ resetScroll: true, changedRowId: true }, 'L1', []],
    [{ ineffectiveMain: true, actualScroller: true, changedRowId: true }, 'L2', ['L1']],
    [{ ineffectiveMain: true, wheelWorks: true, changedRowId: true }, 'L3', ['L1', 'L2']],
  ]) {
    const records = Array.from({ length: 5 }, (_, index) => ({ roadAreaId: index === 4 ? 900101 : 900102 + index,
      roadAreaName: index === 4 ? 'MOCK-001' : `OTHER-${index}`, transitStationName: 'SFO01' }));
    const h = pageHarness({ ...options, records }), result = await h.run();
    assert.equal(result.locateMethod, method); assert.deepEqual(result.attempts, attempts);
    assert.equal(h.clicks.filter(click => click === 'portrait-action').length, 1);
    assert.ok(h.waits.reduce((sum, wait) => sum + wait.milliseconds, 0) <= 30000);
  }
});

test('RD3-14 duplicates and failed clicks stop immediately without fallback clicks', async () => {
  for (const [options, message] of [[{ duplicateRow: true }, 'Route 行不唯一'], [{ ambiguousAction: true }, '画像详情按钮不唯一']]) {
    const h = pageHarness(options);
    await assert.rejects(h.run(), error => error.message.endsWith(message) && JSON.stringify(error.attempts) === '["L1"]');
    assert.equal(h.waits.length, 0); assert.ok(!h.clicks.includes('portrait-action'));
  }
  const h = pageHarness({ actionError: new SelectorError('synthetic click failure') });
  await assert.rejects(h.run(), error => error.portraitClickAttempted && error.attempts.length === 1);
  assert.equal(h.clicks.filter(click => click === 'portrait-action').length, 1);
});

test('RD3-14 total location deadline bounds a long list with delayed readiness', async () => {
  const h = pageHarness({ ineffectiveMain: true, loadingMs: 9000,
    records: Array.from({ length: 100 }, (_, index) => ({ roadAreaId: index === 99 ? 900101 : index + 1,
      roadAreaName: index === 99 ? 'MOCK-001' : `OTHER-${index}`, transitStationName: 'SFO01' })) });
  const originalNow = Date.now;
  Date.now = () => h.waits.reduce((sum, wait) => sum + wait.milliseconds, 0);
  try {
    await assert.rejects(h.run(), error => error.message.endsWith('画像详情定位失败') && error.attempts.at(-1) === 'L5:unavailable');
    assert.ok(Date.now() <= 30000);
  } finally { Date.now = originalNow; }
});

test('RD3-14 L5 requires the exact label, validates a single ID/name, counts and restores queries', async () => {
  const h = pageHarness({ ineffectiveMain: true, routeFilter: true });
  const result = await h.run({ maxListRequests: 2 });
  assert.equal(result.locateMethod, 'L5'); assert.deepEqual(result.attempts, ['L1', 'L2', 'L3']);
  assert.equal(result.listRequestCount, 4); // Startup + initial query + filter + restoration; budget is 2 + 2.
  assert.equal(h.clicks.filter(click => click === 'portrait-action').length, 1);
  assert.equal(h.clicks.filter(click => click === 'query').length, 3);
  assert.equal(h.clicks.at(-1), 'query');
  for (const filteredRecords of [[], [{ roadAreaId: 900101, roadAreaName: 'MOCK-001' }, { roadAreaId: 2, roadAreaName: 'OTHER' }],
    [{ roadAreaId: 2, roadAreaName: 'MOCK-001' }], [{ roadAreaId: 900101, roadAreaName: 'OTHER' }]]) {
    const bad = pageHarness({ ineffectiveMain: true, routeFilter: true, filteredRecords });
    await assert.rejects(bad.run(), error => error instanceof CaptureError || error.cause instanceof CaptureError);
    assert.ok(!bad.clicks.includes('portrait-action'));
  }
  const other = pageHarness({ ineffectiveMain: true, routeFilter: true, filterLabel: '快递员工作区域名称' });
  await assert.rejects(other.run(), error => error.attempts.at(-1) === 'L5:unavailable');
  assert.equal(other.clicks.filter(click => click === 'query').length, 1);
});

test('RD3 shared row selector waits only for rendering, scrolls first and distinguishes missing from duplicate buttons', async () => {
  const immediate = pageHarness(); await immediate.run(); assert.equal(immediate.waits.length, 0);
  const delayed = pageHarness({ actionDelay: 3 }); await delayed.run();
  assert.equal(delayed.waits.length, 3);
  assert.ok(delayed.waits.every(wait => wait.milliseconds === 200 && !wait.clicks.includes('portrait-action')));
  const missing = pageHarness({ missingAction: true });
  await assert.rejects(missing.run(), { name: 'SelectorError', message: '页面控件不可用：画像详情定位失败', attempts: ['L1', 'L2', 'L3', 'L5:unavailable'] });
  assert.ok(missing.waits.reduce((sum, wait) => sum + wait.milliseconds, 0) <= 30000);
  assert.equal(missing.clicks.includes('portrait-action'), false);
  const duplicate = pageHarness({ ambiguousAction: true });
  await assert.rejects(duplicate.run(), { name: 'SelectorError', message: '页面控件不可用：画像详情按钮不唯一' });
  assert.equal(duplicate.waits.length, 0); assert.equal(duplicate.clicks.includes('portrait-action'), false);
});

test('RD4 first opening switches date to postal and restores date before returning', async () => {
  const h = pageHarness(); await h.run();
  assert.deepEqual(h.clicks.filter(click => /target="(?:postal|date)"/.test(click)),
    ['[data-rd1-target="postal"]', '[data-rd1-target="date"]']);
  assert.equal(h.waits.length, 0);
});

test('RD4 real radio-group structure isolates each label for both initial states and class/input signals', async () => {
  for (const postalSelected of [false, true]) {
    for (const signals of [{}, { inputOnly: true }, { classOnly: true }]) {
      const h = pageHarness({ postalSelected, autoPostal: postalSelected, ...signals });
      assert.deepEqual((await h.run()).capacityBody, { data: [] });
      assert.equal(h.clicks.filter(click => click === '[data-rd1-target="postal"]').length, postalSelected ? 0 : 1);
      assert.equal(h.waits.length, 0);
    }
  }
});

test('RD4 labels appearing after two seconds are awaited before clicking', async () => {
  const h = pageHarness({ tabsDelay: 2000 }); await h.run();
  assert.equal(h.waits.length, 10);
  assert.ok(h.waits.every(wait => wait.milliseconds === 200 && !wait.clicks.includes('[data-rd1-target="postal"]')));
});

test('RD4 missing, equally selected or structurally invalid labels time out after ten seconds without clicking', async () => {
  for (const options of [{ tabsDelay: Infinity }, { bothTabs: true }, { unknownTabs: true },
    { separateGroups: true }, { missingLabel: true }]) {
    const h = pageHarness(options);
    await assert.rejects(h.run(), { name: 'SelectorError', message: '页面控件不可用：按邮编标签状态' });
    assert.equal(h.waits.reduce((sum, wait) => sum + wait.milliseconds, 0), 10000);
    assert.ok(h.waits.every(wait => wait.milliseconds === 200));
    assert.ok(!h.clicks.some(click => /target="(?:postal|date)"/.test(click)));
  }
});

test('RD4 confirms asynchronous selection after clicks even when the response has already arrived', async () => {
  const h = pageHarness({ clickDelay: 600 }); await h.run();
  assert.equal(h.waits.length, 6);
  assert.ok(h.waits.slice(0, 3).every(wait => wait.clicks.at(-1) === '[data-rd1-target="postal"]'));
  assert.ok(h.waits.slice(3).every(wait => wait.clicks.at(-1) === '[data-rd1-target="date"]'));
  const stuck = pageHarness({ postalStuck: true });
  await assert.rejects(stuck.run(), { name: 'SelectorError', message: '页面控件不可用：按邮编标签状态' });
  assert.equal(stuck.waits.length, 50);
  assert.equal(stuck.clicks.filter(click => click === '[data-rd1-target="postal"]').length, 1);
  assert.ok(!stuck.clicks.includes('[data-rd1-target="date"]'));
});

test('RD4 date restoration failure preserves validated data, writes once and stops before the next Route', async () => {
  const h = pageHarness({ dateStuck: true });
  const result = await h.run();
  assert.deepEqual(result.capacityBody, { data: [] });
  assert.equal(result.restorationError.message, '页面控件不可用：按日期标签状态');
  assert.equal(h.waits.length, 50);
  let captures = 0, writes = 0, closes = 0, record;
  const code = await runRouteDetailsBatch({ args: ['--station', 'SFO01'],
    env: { DMS_BASE_URL: 'https://example.invalid/areaDepiction' }, sessionExists: async () => {},
    cachedIds: async () => new Set(), signals: new EventEmitter(),
    session: async (_options, callback) => callback({
      body: { data: { records: [1, 2].map(i => ({ roadAreaId: 900100 + i, roadAreaName: `MOCK-00${i}`, transitStationName: 'SFO01' })), total: 2 } },
      guarded: action => action(), beginRoute: () => {}, counts: () => ({ routeDetailRequestCount: 0 }),
    }), capture: async () => { captures++; return result; }, save: async () => { writes++; },
    closeModals: async () => { closes++; }, writeRun: async ({ record: value }) => { record = value; },
    failure: async () => {}, log: () => {}, errorLog: () => {} });
  assert.equal(code, 1); assert.equal(captures, 1); assert.equal(writes, 1); assert.equal(closes, 0);
  assert.equal(record.routes[0].result, 'written'); assert.equal(record.routes[1].result, 'not_run');
  assert.equal(record.stop_reason, 'close_modals:SelectorError');
  writes = 0;
  assert.equal(await runRouteDetailScrape({ args: ['--route', 'MOCK-001'],
    env: { DMS_BASE_URL: 'https://example.invalid/areaDepiction' }, sessionExists: async () => {},
    capture: async () => result, save: async () => { writes++; },
    failure: async () => {}, log: () => {}, errorLog: () => {} }), 1);
  assert.equal(writes, 1);
});

test('RD4 remembered postal tab uses the automatic opening response without clicking postal', async () => {
  const h = pageHarness({ postalSelected: true, autoPostal: true });
  assert.deepEqual((await h.run()).capacityBody, { data: [] });
  assert.deepEqual(h.clicks.filter(click => /target="(?:postal|date)"/.test(click)), ['[data-rd1-target="date"]']);
  assert.equal(h.waits.length, 0);
});

test('RD4 remembered postal tab without a response waits five seconds then switches date and postal once', async () => {
  const h = pageHarness({ postalSelected: true }); await h.run();
  assert.deepEqual(h.clicks.filter(click => /target="(?:postal|date)"/.test(click)),
    ['[data-rd1-target="date"]', '[data-rd1-target="postal"]', '[data-rd1-target="date"]']);
  assert.equal(h.waits.reduce((sum, wait) => sum + wait.milliseconds, 0), 5000);
});

test('RD4 ignores a previous Route postal response while waiting for the current Route', async () => {
  const h = pageHarness({ postalSelected: true, stalePostal: true });
  assert.equal((await h.run()).routeId, 900101);
  assert.equal(h.waits.length, 25);
  assert.equal(h.clicks.filter(click => click === '[data-rd1-target="postal"]').length, 1);
});

test('RD4 unknown tab state stops with SelectorError and postal timeout retains the diagnostic cause', async () => {
  const unknown = pageHarness({ unknownTabs: true });
  await assert.rejects(unknown.run(), { name: 'SelectorError', message: '页面控件不可用：按邮编标签状态' });
  assert.equal(unknown.waits.length, 50);
  assert.ok(!unknown.clicks.some(click => /target="(?:postal|date)"/.test(click)));
  const timedOut = pageHarness({ postalTimeout: true });
  await assert.rejects(timedOut.run(), error => error instanceof SelectorError
    && error.message === '页面控件不可用：按邮编'
    && error.cause.message === 'page.waitForResponse: Timeout 30000ms exceeded');
});

test('RD4 date restoration requests are counted and every tab path stays below the Route ceiling', async () => {
  for (const options of [{}, { postalSelected: true, autoPostal: true }, { postalSelected: true }]) {
    const h = pageHarness({ ...options, detailRequests: 14, countCapacityRequests: true });
    const result = await h.run();
    assert.equal(result.detailRequestCount, options.postalSelected && !options.autoPostal ? 18 : 17);
    assert.ok(result.detailRequestCount <= 30);
    assert.equal(h.clicks.at(-1), '[data-rd1-target="date"]');
  }
  await assert.rejects(pageHarness({ detailRequests: 28, countCapacityRequests: true }).run(), LoadLimitError);
});

test('RD4 row five re-resolves changed IDs and clicks only the hit-tested fixed-right button', async () => {
  const changed = pageHarness({ changedRowId: true }); await changed.run();
  assert.equal(changed.clicks.filter(click => click === 'portrait-action').length, 1);
  for (const option of ['occludedFor', 'hitBlockedFor']) {
    const delayed = pageHarness({ [option]: 3 }); await delayed.run();
    assert.equal(delayed.waits.length, 3);
    const hidden = pageHarness({ [option]: Infinity });
    await assert.rejects(hidden.run(), error => error.message.endsWith('画像详情定位失败'));
    assert.ok(hidden.waits.length >= 25); assert.ok(!hidden.clicks.includes('portrait-action'));
  }
});

test('RD4 capacity controls, title, route name and both request IDs fail closed', async () => {
  const good = pageHarness(); const result = await good.run();
  assert.deepEqual(result.capacityBody, { data: [] });
  assert.ok(good.clicks.indexOf('[data-rd3-close="close"]') < good.clicks.indexOf('[data-rd1-target="capacity"]'));
  for (const options of [{ capacityLinks: 0 }, { capacityLinks: 2 }, { postalLinks: 0 }, { postalLinks: 2 },
    { capacityTitle: 'OTHER' }, { capacityName: 'MOCK-0010' }, { wrongCapacityId: 2 }, { wrongPostalId: 2 }, { wrongCapacityName: true }]) {
    const h = pageHarness(options);
    await assert.rejects(h.run(), error => ['SelectorError', 'CaptureError'].includes(error.name), JSON.stringify(options));
    assert.ok(h.closes);
    assert.ok(h.clicks.filter(click => click === '[data-rd1-target="capacity"]').length <= 1);
    assert.ok(h.clicks.filter(click => click === '[data-rd1-target="postal"]').length <= 1);
    let writes = 0;
    assert.equal(await runRouteDetailScrape({ args: ['--route', 'MOCK-001'],
      env: { DMS_BASE_URL: 'https://example.invalid/areaDepiction' }, sessionExists: async () => {},
      capture: () => pageHarness(options).run(), save: async () => { writes++; },
      failure: async () => {}, log: () => {}, errorLog: () => {} }), 1);
    assert.equal(writes, 0);
    assert.equal(await runRouteDetailsBatch({ args: ['--station', 'SFO01'],
      env: { DMS_BASE_URL: 'https://example.invalid/areaDepiction' }, sessionExists: async () => {},
      cachedIds: async () => new Set(), signals: new EventEmitter(),
      session: async (_options, callback) => callback({
        body: { data: { records: [{ roadAreaId: 900101, roadAreaName: 'MOCK-001', transitStationName: 'SFO01' }], total: 1 } },
        guarded: action => action(), beginRoute: () => {}, counts: () => ({ routeDetailRequestCount: 0 }),
      }), capture: () => pageHarness(options).run(), save: async () => { writes++; },
      writeRun: async () => {}, failure: async () => {}, log: () => {}, errorLog: () => {} }), 1);
    assert.equal(writes, 0);
  }
});

test('RD4 transform merges exact ZIP strings, preserves fractions and flags missing and extra ZIPs', () => {
  const body = input();
  body.capacityBody = { data: [{ postalCode: '00123', receiptQty: 12.345 }, { postalCode: 'EXTRA', receiptQty: 1 }] };
  const original = structuredClone(body), { route, warnings } = transform(body);
  assert.deepEqual(body, original); assert.equal(route.zips.length, 3);
  assert.equal(route.zips[0].pickup_volume_daily, 12.345);
  assert.deepEqual(route.capacity_raw, body.capacityBody.data);
  for (const zip of route.zips.slice(1)) {
    assert.equal(zip.pickup_volume_daily, null);
    assert.ok(zip.parse_errors.some(error => error.field === 'pickup_volume_daily'));
  }
  assert.ok(warnings.some(error => error.field === 'capacity_postal_code_extra' && error.value === 'EXTRA'));
  for (const value of ['12', true, {}, Infinity]) {
    body.capacityBody.data[0].receiptQty = value;
    const zip = transform(body).route.zips[0];
    assert.equal(zip.pickup_volume_daily, null); assert.ok(zip.parse_errors.some(error => error.field === 'pickup_volume_daily'));
  }
  for (const data of [{}, [null], [{ postalCode: 123 }], [{ postalCode: '00123' }, { postalCode: '00123' }]]) {
    assert.throws(() => transform({ ...input(), capacityBody: { data } }), SchemaError);
  }
});

test('RD4 store reads legacy records and API exposes pickup only, never capacity raw', async t => {
  const runtimeDir = await temporary(t);
  const legacy = transform().route;
  await saveRouteDetail({ runtimeDir, route: legacy });
  assert.ok((await getRouteDetail({ runtimeDir, routeId: legacy.route_id })).zips.every(zip => zip.pickup_volume_daily === null));
  const body = input(); body.capacityBody = { data: [{ postalCode: '00123', receiptQty: 12.25 }] };
  const route = transform(body).route;
  await saveRouteDetail({ runtimeDir, route });
  const api = await getRouteDetail({ runtimeDir, routeId: route.route_id });
  assert.equal(api.zips[0].pickup_volume_daily, 12.25); assert.ok(!Object.hasOwn(api, 'capacity_raw'));
  assert.equal(api.zips[0].delivery_fail_rate, legacy.zips[0].delivery_fail_rate);
  const stored = JSON.parse(await fs.readFile(path.join(runtimeDir, 'route-details.json'), 'utf8'));
  assert.equal(stored.schema_version, 1); assert.deepEqual(stored.routes[route.route_id].capacity_raw, body.capacityBody.data);
  for (const pickup_volume_daily of ['bad', {}, true]) {
    await assert.rejects(saveRouteDetail({ runtimeDir, route: { ...route, zips: [{ ...route.zips[0], pickup_volume_daily }] } }), StoreError);
  }
});

test('RD1 shared portrait session preserves T3 counting, 401 behavior and listener cleanup', async () => {
  const navigationPaths = ['https://example.invalid/unrelated', 'another/roadAreaPortrait/extra', 'roadAreaPortraitDetails/details/mock'];
  const portrait = pageHarness({ navigationPaths, navigationStatus: 401 });
  const result = await portrait.runPortrait();
  assert.deepEqual(Object.keys(result), ['body', 'requestCount', 'listRequestCount']);
  assert.equal(result.requestCount, 4); assert.equal(result.listRequestCount, 3);
  assert.ok(portrait.closes);
  assert.equal(portrait.page.listenerCount('request'), 0);
  assert.equal(portrait.page.listenerCount('response'), 0);
  const detail = pageHarness({ navigationPaths });
  const detailResult = await detail.run();
  assert.equal(detailResult.listRequestCount, 1); assert.equal(detailResult.detailRequestCount, 3);
  const expired = pageHarness({ navigationStatus: 401 });
  await assert.rejects(expired.run(), NeedsLoginError);
  assert.deepEqual(expired.clicks, []);
  assert.equal(expired.page.listenerCount('request'), 0);
  assert.equal(expired.page.listenerCount('response'), 0);
});

test('RD1 modal polling waits beyond five seconds with a twenty-second bound and no extra clicks or requests', async () => {
  const delayed = pageHarness({ modalDelay: 40 });
  const result = await delayed.run();
  assert.equal(delayed.waits.length, 40);
  assert.equal(delayed.waits.reduce((sum, wait) => sum + wait.milliseconds, 0), 8000);
  assert.equal(result.listRequestCount, 1); assert.equal(result.detailRequestCount, 2);
  const missing = pageHarness({ missingModal: true });
  await assert.rejects(missing.run(), SelectorError);
  assert.equal(missing.waits.length, 100);
  assert.equal(missing.waits.reduce((sum, wait) => sum + wait.milliseconds, 0), 20000);
  for (const harness of [delayed, missing]) {
    for (const wait of harness.waits) {
      assert.equal(wait.milliseconds, 200);
      assert.deepEqual(wait.clicks, harness.clicks.slice(0, 8));
    }
    assert.equal(harness.clicks.filter((click) => click === 'portrait-action').length, 1);
  }
  assert.equal(missing.clicks.length, 8); assert.ok(missing.closes);
});

test('RD1 difficulty label waits for its own link while four sibling detail links are ready', async () => {
  const harness = pageHarness({ detailDelay: 40 });
  const result = await harness.run();
  assert.equal(harness.waits.length, 40);
  assert.equal(result.listRequestCount, 1); assert.equal(result.detailRequestCount, 2);
  for (const wait of harness.waits) {
    assert.equal(wait.milliseconds, 200);
    assert.deepEqual(wait.clicks, harness.clicks.slice(0, 8));
  }
  assert.equal(harness.clicks.filter((click) => click === '[data-rd1-target="difficulty"]').length, 1);
});

test('RD1 difficulty ambiguity preserves its reason and missing link times out without clicks', async () => {
  const ambiguous = pageHarness({ ambiguousDetail: true });
  await assert.rejects(ambiguous.run(), { name: 'SelectorError', message: '页面控件不可用：路区难易度详情不唯一' });
  assert.equal(ambiguous.waits.length, 0);
  const missing = pageHarness({ missingDetail: true });
  await assert.rejects(missing.run(), { name: 'SelectorError', message: '页面控件不可用：路区画像详情未加载' });
  assert.equal(missing.waits.length, 100);
  assert.equal(missing.waits.reduce((sum, wait) => sum + wait.milliseconds, 0), 20000);
  for (const harness of [ambiguous, missing]) {
    assert.equal(harness.clicks.length, 8); assert.ok(harness.closes);
    for (const wait of harness.waits) assert.deepEqual(wait.clicks, harness.clicks);
  }
});

test('RD1 control rethrows the same SelectorError and normalizes other control errors', async () => {
  const original = new SelectorError('画像详情不唯一');
  await assert.rejects(pageHarness({ actionError: original }).run(), (error) => error === original);
  await assert.rejects(pageHarness({ actionError: new Error('synthetic internal error') }).run(),
    { name: 'SelectorError', message: '页面控件不可用：画像详情' });
});

test('RD1 page selects exact route, visible fixed-column action and innermost difficulty link', async () => {
  for (const virtual of [false, true]) {
    const harness = pageHarness({ virtual, modalDelay: 2 }); const result = await harness.run();
    assert.equal(result.routeId, 900101); assert.equal(result.contentBody, contentBody);
    assert.equal(result.listRequestCount, 1); assert.equal(result.detailRequestCount, 2);
    assert.deepEqual(harness.clicks, ['展开', '.dbuMicroSysApp-select-selector', 'station-option', 'Escape', '.vxe-pager--sizes', '.vxe-select-option:visible', 'query', 'portrait-action', '[data-rd1-target="difficulty"]', '[data-rd3-close="close"]', '[data-rd1-target="capacity"]', '[data-rd1-target="postal"]', '[data-rd1-target="date"]']);
    assert.ok(harness.closes); assert.doesNotMatch(harness.logs.join(''), /example.invalid|mock-row/);
  }
});
for (const [label, options, type] of [
  ['zero matches', { records: [] }, CaptureError],
  ['multiple matches', { records: [1, 2].map((id) => ({ roadAreaId: id, roadAreaName: 'MOCK-001' })) }, CaptureError],
  ['wrong request ID', { wrongId: 900102 }, CaptureError], ['wrong header name', { wrongHeader: true }, CaptureError],
  ['wrong header request ID', { wrongHeaderId: 900102 }, CaptureError],
  ['missing rendered row', { missingRow: true }, SelectorError], ['ambiguous action', { ambiguousAction: true }, SelectorError],
  ['ambiguous difficulty link', { ambiguousDetail: true }, SelectorError], ['mixed base section', { mixedSection: true }, SelectorError],
  ['modal never rendered', { missingModal: true }, SelectorError],
  ['detail ceiling', { detailRequests: 31 }, LoadLimitError], ['list ceiling', { listRequests: 4 }, LoadLimitError],
  ['expired session', { login: true }, NeedsLoginError], ['password form', { password: true }, NeedsLoginError],
  ['session expires during detail', { status: 401 }, NeedsLoginError],
  ...[429, 500, 503, 599].map((status) => [`circuit ${status}`, { status }, CircuitBreakerError]),
]) test(`RD1 page stops and closes on ${label}`, async () => {
  const harness = pageHarness(options);
  await assert.rejects(harness.run(), type); assert.ok(harness.closes);
  if (options.login || options.password) assert.deepEqual(harness.clicks, []);
  if (type === LoadLimitError || type === CircuitBreakerError) assert.ok(!harness.clicks.includes('[data-rd1-target="difficulty"]'));
});

test('RD1 capture stops even while navigation is pending and accepts exact request ceilings', async () => {
  for (const status of [429, 503, 401]) {
    const harness = pageHarness({ pendingNavigation: true, status });
    await assert.rejects(harness.run(), status === 401 ? NeedsLoginError : CircuitBreakerError);
    assert.ok(harness.closes); assert.deepEqual(harness.clicks, []);
  }
  const harness = pageHarness({ listRequests: 3, detailRequests: 20 });
  const result = await harness.run(); assert.equal(result.listRequestCount, 3); assert.equal(result.detailRequestCount, 20);
});

const cliEnv = { DMS_BASE_URL: 'https://example.invalid/areaDepiction', DMS_STATE_PATH: path.join(os.tmpdir(), 'nc-rd1-synthetic-state-not-read.json') };
test('RD1 CLI validates route, station and ceilings before session access', async () => {
  for (const args of [[], ['--route', ''], ['--route', 'bad/name'], ['--route', 'a'.repeat(65)], ['--route', 'MOCK-001', '--station', 'SFO02'], ['--route', 'MOCK-001', '--station'], ['--route'], ['--route', 'MOCK-001', '--route', 'MOCK-002']]) {
    let touched = false;
    assert.equal(await runRouteDetailScrape({ args, env: cliEnv, errorLog: () => {}, sessionExists: async () => { touched = true; }, capture: async () => { touched = true; } }), 1);
    assert.equal(touched, false);
  }
  assert.equal(parseMaxRouteDetailRequests(''), 30); assert.equal(parseMaxRouteDetailRequests('8'), 8);
  for (const value of ['0', '-1', '1.5', 'bad', 'Infinity']) assert.throws(() => parseMaxRouteDetailRequests(value));
});

test('RD1 CLI first failure and missing session create only last-failure; store failure is recorded', async (t) => {
  const runtimeDir = await temporary(t);
  const base = { args: ['--route', 'MOCK-001'], env: { ...cliEnv, RUNTIME_DATA_DIR: runtimeDir }, log: () => {}, errorLog: () => {} };
  assert.equal(await runRouteDetailScrape({ ...base, sessionExists: async () => {}, capture: async () => { throw new CaptureError(); } }), 1);
  assert.deepEqual(await fs.readdir(runtimeDir), ['last-failure.json']);
  assert.equal(await runRouteDetailScrape({ ...base, sessionExists: async () => { throw Object.assign(new Error(), { code: 'ENOENT' }); }, capture: assert.fail }), 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(runtimeDir, 'last-failure.json'), 'utf8')).step, 'session');
  assert.equal(await runRouteDetailScrape({ ...base, sessionExists: async () => {}, capture: async () => ({ ...input(), routeId: 900101 }), save: async () => { throw new StoreError(); } }), 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(runtimeDir, 'last-failure.json'), 'utf8')).step, 'store');
  assert.deepEqual(await fs.readdir(runtimeDir), ['last-failure.json']);
});

test('RD1 CLI saves detail and reports one summary using default SFO01', async (t) => {
  const runtimeDir = await temporary(t), logs = [];
  const code = await runRouteDetailScrape({ args: ['--route', 'MOCK-001', '--headless'], env: { ...cliEnv, RUNTIME_DATA_DIR: runtimeDir }, log: (line) => logs.push(line), errorLog: assert.fail,
    sessionExists: async () => {}, capture: async (options) => {
      assert.equal(options.station, 'SFO01'); assert.equal(options.routeName, 'MOCK-001'); assert.equal(options.headless, true);
      assert.equal(options.maxDetailRequests, 30);
      return { ...input(), routeId: 900101, listRequestCount: 2, detailRequestCount: 11 };
    } });
  assert.equal(code, 0); assert.deepEqual(await fs.readdir(runtimeDir), ['route-details.json']);
  const summaries = logs.filter((line) => line.startsWith('station：'));
  assert.equal(summaries.length, 1); assert.match(summaries[0], /route：MOCK-001.*route_id：900101.*ZIP 数：3.*list 请求数：2.*detail 请求数：11/);
});

test('RD1 CLI failures retain detail cache and write sanitized last-failure, including NeedsLogin', async (t) => {
  const runtimeDir = await temporary(t), filename = path.join(runtimeDir, 'route-details.json');
  await fs.writeFile(filename, 'previous bytes');
  for (const error of [new CaptureError(), new NeedsLoginError(), new SelectorError('画像详情'), new Error('private session path')]) {
    const logs = [];
    assert.equal(await runRouteDetailScrape({ args: ['--route', 'MOCK-001'], env: { ...cliEnv, RUNTIME_DATA_DIR: runtimeDir }, log: () => {}, errorLog: (line) => logs.push(line), sessionExists: async () => {}, capture: async () => { throw error; } }), 1);
    assert.equal(await fs.readFile(filename, 'utf8'), 'previous bytes');
    const failure = await fs.readFile(path.join(runtimeDir, 'last-failure.json'), 'utf8');
    assert.equal(JSON.parse(failure).step, 'capture'); assert.doesNotMatch(failure + logs.join(''), /private session path/);
  }
  for (const mutate of [(b) => { b.contentBody.data = {}; }, (b) => { b.headerBody.data.roadAreaName = 'OTHER-MOCK'; }]) {
    const body = input(); mutate(body);
    assert.equal(await runRouteDetailScrape({ args: ['--route', 'MOCK-001'], env: { ...cliEnv, RUNTIME_DATA_DIR: runtimeDir }, log: () => {}, errorLog: () => {}, sessionExists: async () => {}, capture: async () => ({ ...body, routeId: 900101 }) }), 1);
    assert.equal(JSON.parse(await fs.readFile(path.join(runtimeDir, 'last-failure.json'), 'utf8')).step, 'transform');
    assert.equal(await fs.readFile(filename, 'utf8'), 'previous bytes');
  }
  assert.deepEqual((await fs.readdir(runtimeDir)).sort(), ['last-failure.json', 'route-details.json']);
});

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
test('RD1 API validates a unique positive safe integer and maps injected errors', async (t) => {
  const logs = [], calls = []; let failure;
  const url = await listen(t, createRequestHandler({ log: (line) => logs.push(line), getSnapshot: async () => ({ fetched_at: metadata.fetchedAt, total: 0, rows: [], source_as_of: null }),
    getRouteDetail: async (id) => { calls.push(id); if (failure) throw failure; return { route_id: id, zips: [] }; } }));
  for (const query of ['', '?route_id=', '?route_id=0', '?route_id=-1', '?route_id=1.1', '?route_id=1e2', '?route_id=9007199254740992', '?route_id=1&route_id=2', '?route_id=%201']) {
    const response = await fetch(url + '/api/route-details' + query);
    assert.equal(response.status, 400, query); assert.deepEqual(await response.json(), { error: 'invalid_route_id' });
  }
  assert.deepEqual(calls, []);
  const response = await fetch(url + '/api/route-details?route_id=900101', { headers: { Origin: 'https://example.invalid' } });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { route_id: 900101, zips: [] });
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD']) {
    const reply = await fetch(url + '/api/route-details?route_id=900101', { method });
    assert.equal(reply.status, 405); assert.equal(reply.headers.get('allow'), 'GET');
  }
  for (const [error, status, code] of [[new RouteDetailNotFoundError(), 404, 'route_detail_not_found'], [new RouteDetailInvalidError(), 500, 'route_detail_invalid'], [new Error('secret path'), 500, 'internal_error']]) {
    failure = error; const reply = await fetch(url + '/api/route-details?route_id=900101');
    assert.equal(reply.status, status); assert.deepEqual(await reply.json(), { error: code });
  }
  assert.deepEqual(await (await fetch(url + '/api/health')).json(), { ok: true });
  assert.equal((await fetch(url + '/api/route-profiles?station=SFO01')).status, 200);
  assert.ok(logs.every((line) => /^HTTP \d{3}$/.test(line)));
});

test('RD1 running local server wires detail store and static module, without touching profiles', async (t) => {
  const runtimeDir = await temporary(t);
  await saveRouteDetail({ runtimeDir, route: transform().route });
  const server = await startApiServer({ port: 0, runtimeDir });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const reply = await fetch(url + '/api/route-details?route_id=900101');
  assert.equal(reply.status, 200); assert.ok((await reply.json()).zips.every((zip) => !Object.hasOwn(zip, 'raw')));
  assert.equal((await fetch(url + '/api/route-profiles?station=SFO01')).status, 404);
  assert.equal((await fetch(url + '/route-detail.js')).status, 200);
  assert.deepEqual(await fs.readdir(runtimeDir), ['route-details.json']);
});

test('RD1 shared formatters implement five exact difficulty tones and decimal percentages', () => {
  for (const [value, expected] of [[.0047, '0.47%'], [.5, '50.00%'], [0, '0.00%']]) assert.equal(formatPercent(value), expected);
  for (const value of [null, undefined, '', '.5', NaN, Infinity, true]) assert.equal(formatPercent(value), '—');
  for (const [value, tone] of [['D级 极易', 'easy'], ['C级 易', 'easy'], ['B级 中', 'medium'], ['A级 难', 'hard'], ['S级 极难', 'hard'], [' C级 易 ', 'easy'], [null, 'unknown'], ['NEW', 'unknown'], ['D级 极易 extra', 'unknown'], ['toString', 'unknown']]) assert.equal(difficultyTone(value), tone);
});

class Element {
  constructor(tag = 'div') { this.tag = tag; this.style = {}; this.children = []; this.textContent = ''; this.listeners = {}; this.attributes = {}; this.open = false; this.focused = false; }
  append(...children) { for (const child of children) this.children.push(...(child.fragment ? child.children : [child])); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.close?.(); }
  focus() { this.focused = true; }
  getBoundingClientRect() { return { left: 10, top: 10, right: 100, bottom: 100 }; }
}
function documentDouble(t) {
  const previousDocument = globalThis.document, previousFetch = globalThis.fetch;
  const elements = Object.fromEntries(['route-detail', 'detail-content', 'detail-close', 'detail-title', 'updated', 'total', 'rows', 'table-container', 'message', 'retry', 'profiles'].map((id) => [id, new Element()]));
  globalThis.document = { getElementById: (id) => elements[id], createElement: (tag) => new Element(tag), createDocumentFragment: () => Object.assign(new Element(), { fragment: true }) };
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
    globalThis.fetch = previousFetch;
  });
  return elements;
}
const descendants = (node) => [node, ...node.children.flatMap(descendants)];
test('RD2 basic info keeps profile fields and snapshot time, with detail and fallback ZIP counts', async (t) => {
  const elements = documentDouble(t), source = new Element('button');
  const snapshotTime = '2026-09-30T18:20:00Z', detailTime = '2026-10-01T20:10:00Z';
  const row = Object.freeze({ route_id: 900101, route_name: 'MOCK-001', station: 'MOCKA',
    dsp_name: 'Mock DSP', pickup_volume: 12345, pph: 30, first_mile_distance: 3.9,
    route_difficulty: 'A级 难', route_difficulty_manual: null, postal_codes: Object.freeze(['00123', '00987']) });
  let reply;
  globalThis.fetch = async () => reply;
  const values = () => Object.fromEntries(elements['detail-content'].children[0].children
    .map(item => [item.children[0].textContent, item.children[1]]));
  for (const [profile, expected] of [[row, '2'], [{ ...row, postal_codes: [] }, '0'],
    [{ ...row, postal_codes: undefined }, '—']]) {
    reply = { status: 404, json: async () => ({ error: 'route_detail_not_found' }) };
    await openRouteDetail(profile, source, snapshotTime);
    assert.equal(values()['ZIP 数'].textContent, expected);
    assert.equal(values()['线路数据更新时间'].title, snapshotTime);
    assert.equal(values()['ZIP 详情更新时间'].textContent, '—');
    assert.equal(elements['detail-content'].children[1].textContent, '该线路暂无详细数据');
  }
  for (const count of [0, 7]) {
    reply = { status: 200, json: async () => ({ route_name: 'OTHER', station: 'OTHER',
      route_difficulty: 'C级 易', zip_count: count, fetched_at: detailTime, zips: [] }) };
    await openRouteDetail(row, source, snapshotTime);
    const info = values();
    assert.equal(info['ZIP 数'].textContent, String(count));
    assert.equal(info['线路名称'].textContent, row.route_name);
    assert.equal(info['站点'].textContent, row.station);
    assert.equal(info['线路难度'].children[0].textContent, row.route_difficulty);
    assert.equal(info['线路数据更新时间'].title, snapshotTime);
    assert.equal(info['ZIP 详情更新时间'].title, detailTime);
    assert.equal(info['Pickup Volume'].textContent, '12,345');
    assert.equal(info.PPH.textContent, '30.00');
    assert.equal(info['首公里距离 (mi)'].textContent, '3.90');
    assert.equal(info['人工难度'].children[0].textContent, '—');
    assert.equal(info['人工难度'].children[0].className, undefined);
  }
});
test('RD1 main table route button opens modal, safely renders ZIP fields and restores focus', async (t) => {
  const elements = documentDouble(t), requests = [], malicious = '<img src=x onerror=alert(1)>';
  const route = { route_id: 900101, route_name: 'MOCK-001', station: 'MOCKA', dsp_name: malicious,
    pickup_volume: 12345, pph: 30, first_mile_distance: 3.9,
    route_difficulty: 'A级 难', route_difficulty_manual: null, postal_codes: ['00001'] };
  const detail = transform().route;
  detail.zips[0].pickup_volume_daily = 1200;
  detail.zips[1].pickup_volume_daily = 12.345;
  detail.route_name = malicious; detail.zips[0].safety_level = malicious;
  globalThis.fetch = async (url) => {
    requests.push(url);
    return { status: 200, json: async () => url.includes('route-profiles') ? { fetched_at: metadata.fetchedAt, total: 1, rows: [route] } : detail };
  };
  await import('../../web/app.js?rd1'); await new Promise((resolve) => setImmediate(resolve));
  const button = elements.rows.children[0].children[0].children[0];
  assert.equal(button.tag, 'button'); assert.equal(button.type, 'button'); assert.equal(button.textContent, 'MOCK-001');
  assert.equal(elements.rows.children[0].children[5].children[0].className, 'difficulty system-difficulty');
  const pending = button.listeners.click();
  assert.equal(elements['route-detail'].open, true);
  assert.equal(elements['detail-content'].children[1].textContent, '加载中…');
  await pending;
  assert.deepEqual(requests, ['/api/route-profiles?station=SFO01', '/api/route-details?route_id=900101']);
  const nodes = descendants(elements['detail-content']);
  const metrics = elements['detail-content'].children[0];
  const values = Object.fromEntries(metrics.children.map(item => [item.children[0].textContent, item.children[1]]));
  assert.deepEqual(Object.keys(values), ['线路名称', 'Route ID', '站点', 'DSP', 'Pickup Volume', 'PPH',
    '首公里距离 (mi)', '线路难度', '人工难度', 'ZIP 数', '线路数据更新时间', 'ZIP 详情更新时间']);
  for (const [label, expected] of Object.entries({ '线路名称': 'MOCK-001', 'Route ID': '900101',
    '站点': 'MOCKA', DSP: malicious, 'Pickup Volume': '12,345', PPH: '30.00',
    '首公里距离 (mi)': '3.90', 'ZIP 数': '3', '线路数据更新时间': formatUpdated(metadata.fetchedAt),
    'ZIP 详情更新时间': formatUpdated(metadata.fetchedAt) })) assert.equal(values[label].textContent, expected, label);
  assert.equal(values['线路数据更新时间'].title, metadata.fetchedAt);
  assert.equal(values['线路难度'].children[0].className, 'difficulty system-difficulty');
  assert.equal(values['人工难度'].children[0].textContent, '—');
  assert.equal(values['人工难度'].children[0].className, undefined);
  assert.deepEqual(nodes.filter(node => node.tag === 'th').map(node => node.textContent),
    ['ZIP', '领件量（日均）', '熟手 PPH', 'ZIP 难度', '首公里距离 (mi)']);
  assert.equal(nodes.filter((node) => node.tag === 'th').length, 5);
  assert.ok(nodes.some((node) => node.textContent === malicious)); assert.ok(nodes.every((node) => node.tag !== 'img'));
  for (const text of ['12.34', '23.45', '00123', formatUpdated(metadata.fetchedAt)]) assert.ok(nodes.some((node) => node.textContent === text), text);
  const rows = nodes.filter((node) => node.tag === 'tbody')[0].children;
  assert.deepEqual(rows.map(row => row.children[1].textContent), ['1,200', '—', '12.35']);
  assert.ok(nodes.every(node => !['派送异常率', 'DNR 率', '安全等级'].includes(node.textContent)));
  assert.equal(rows[2].children[3].textContent, '—'); assert.equal(rows[2].children[3].children.length, 0);
  assert.equal(rows[0].children[3].children[0].className, 'difficulty system-difficulty');
  assert.ok(!nodes.some((node) => node.textContent === 'postal_code_tag'));
  elements['detail-close'].listeners.click(); assert.equal(elements['route-detail'].open, false); assert.equal(button.focused, true);
  assert.equal(requests.length, 2);
});

test('RD1b modal stably sorts ZIP strings, puts invalid values last and preserves frozen input', async (t) => {
  const elements = documentDouble(t);
  const zips = Object.freeze(['94005', null, '00987', '', '00123', undefined, '94005', 123, false, '10', '2']
    .map((postal_code, index) => Object.freeze({ postal_code, experienced_pph: index })));
  const detail = Object.freeze({ route_name: 'MOCK-001', zip_count: zips.length, zips });
  const original = structuredClone(detail);
  globalThis.fetch = async () => ({ status: 200, json: async () => detail });
  await openRouteDetail({ route_id: 900101, route_name: 'MOCK-001' }, new Element('button'));
  const nodes = descendants(elements['detail-content']);
  const rows = nodes.find((node) => node.tag === 'tbody').children;
  assert.equal(rows.length, zips.length);
  assert.deepEqual(rows.slice(0, 6).map((row) => row.children[0].textContent),
    ['00123', '00987', '10', '2', '94005', '94005']);
  assert.deepEqual(rows.map((row) => row.children[2].textContent),
    [4, 2, 9, 10, 0, 6, 1, 3, 5, 7, 8].map((index) => index.toFixed(2)));
  assert.deepEqual(detail, original);
  assert.equal(detail.zips, zips);
  assert.equal(nodes.find((node) => node.tag === 'caption').textContent, '按 ZIP 升序显示的 ZIP 画像');
});

test('RD1 modal handles missing detail, sanitized errors, backdrop, Esc and stale responses', async (t) => {
  const elements = documentDouble(t), source = new Element('button'), row = { route_id: 900101, route_name: 'MOCK-001', dsp_name: 'Mock Fleet' };
  let reply = { status: 404, json: async () => ({ error: 'route_detail_not_found' }) };
  globalThis.fetch = async () => { if (reply instanceof Error) throw reply; return reply; };
  await openRouteDetail(row, source);
  assert.equal(elements['detail-content'].children[1].textContent, '该线路暂无详细数据');
  assert.equal(elements['detail-content'].children[2].textContent, '可运行 npm run dms:scrape-route-details -- --station SFO01 获取。');
  assert.equal(elements['detail-content'].children[0].children[0].children[1].textContent, 'MOCK-001');
  const dialog = elements['route-detail'];
  dialog.listeners.click({ target: dialog, clientX: 20, clientY: 20 }); assert.equal(dialog.open, true);
  dialog.listeners.click({ target: dialog, clientX: 0, clientY: 0 }); assert.equal(dialog.open, false); assert.equal(source.focused, true);
  for (const failure of [{ status: 500, json: async () => ({ error: 'route_detail_invalid' }) }, { status: 500, json: async () => ({ error: 'secret/path stack' }) }, new Error('secret/path'), { status: 200, json: async () => { throw new Error('private'); } }]) {
    reply = failure; await openRouteDetail(row, source);
    assert.doesNotMatch(elements['detail-content'].children[1].textContent, /secret|stack|private/);
    assert.match(elements['detail-content'].children[1].textContent, /无法.*(route_detail_invalid|internal_error|server_unreachable)/);
  }
  let release;
  reply = { status: 200, json: async () => new Promise((resolve) => { release = resolve; }) };
  const pending = openRouteDetail(row, source); await new Promise((resolve) => setImmediate(resolve));
  let prevented = false; dialog.listeners.cancel({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true); assert.equal(dialog.open, false);
  reply = { status: 404, json: async () => ({ error: 'route_detail_not_found' }) };
  await openRouteDetail({ ...row, route_name: 'MOCK-002' }, source);
  release(transform().route); await pending;
  assert.equal(elements['detail-content'].children[0].children[0].children[1].textContent, 'MOCK-002');
  assert.equal(elements['detail-content'].children[1].textContent, '该线路暂无详细数据');
});

test('RD1 frontend contains no HTML injection or external resources; modal scroll is bounded', async () => {
  for (const name of await fs.readdir(new URL('../../web/', import.meta.url))) {
    const source = await fs.readFile(new URL(`../../web/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /innerHTML|https?:\/\//, name);
  }
  const css = await fs.readFile(new URL('../../web/styles.css', import.meta.url), 'utf8');
  assert.match(css, /max-height: 85vh/); assert.match(css, /\.detail-table-scroll \{ overflow: auto/);
  assert.match(css, /max-width: calc\(100% - 24px\)/); assert.match(css, /position: sticky/);
});

test('RM5 modal uses shared five colors for system route and ZIP difficulties and preserves manual tones', async t => {
  const e = documentDouble(t), time = '2026-10-05T00:00:00Z';
  const words = ['S级 极难', 'A级 难', 'B级 中', 'C级 易', 'D级 极易', 'unknown'];
  for (const word of words) {
    const row = { route_id: 1, route_name: 'Mock', route_difficulty: word, route_difficulty_manual: 'C级 易' };
    const data = { zip_count: words.length, fetched_at: time, zips: words.map(postal_code_difficulty => ({ postal_code: '00123', postal_code_difficulty })) };
    globalThis.fetch = async () => ({ status: 200, json: async () => data });
    await openRouteDetail(row, new Element('button'), time);
    const info = Object.fromEntries(e['detail-content'].children[0].children.map(item => [item.children[0].textContent, item.children[1]]));
    assert.equal(info['线路难度'].children[0].textContent, word);
    assert.equal(info['线路难度'].children[0].style.backgroundColor, difficultyColor(difficultyLevel(word)));
    assert.equal(info['人工难度'].children[0].className, 'difficulty tone-easy');
    assert.deepEqual(info['人工难度'].children[0].style, {});
    const rows = descendants(e['detail-content']).find(node => node.tag === 'tbody').children;
    rows.forEach((row, i) => {
      assert.equal(row.children[3].children[0].textContent, words[i]);
      assert.equal(row.children[3].children[0].style.backgroundColor, difficultyColor(difficultyLevel(words[i])));
    });
  }
});
