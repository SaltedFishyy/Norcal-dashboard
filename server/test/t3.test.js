import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { transformRoutePortrait, SchemaError } from '../src/transform/route-profile.js';
import { saveStationSnapshot, writeLastFailure, StoreError } from '../src/store/route-profiles-file.js';
import { captureRoutePortrait, NeedsLoginError, LoadLimitError, CircuitBreakerError, SelectorError, CaptureError } from '../src/dms/route-profile-page.js';
import { resolveRuntimeDir, checkRuntimeDir, parseMaxListRequests } from '../src/config.js';
import { runScrape } from '../bin/dms-scrape.js';

const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/route-portrait-pagination.json', import.meta.url), 'utf8'));
const options = { station: 'SFO01', fetchedAt: '2026-09-30T12:00:00Z' };
const transform = (body = structuredClone(fixture)) => transformRoutePortrait(body, options);

test('T3 fixture maps all fields, types, raw values and separate manual difficulty without mutation', () => {
  const input = structuredClone(fixture);
  const { stationSnapshot: snapshot, warnings } = transform(input);
  assert.deepEqual(input, fixture);
  assert.equal(snapshot.rows.length, 3);
  assert.equal(snapshot.source_as_of, null);
  assert.equal(snapshot.source, 'dms-playwright');
  assert.equal(snapshot.fetched_at, options.fetchedAt);
  assert.equal(snapshot.total, 3);
  assert.deepEqual(warnings, []);
  const keys = ['postal_codes','route_id','station','route_name','dsp_name','pickup_volume','pph','first_mile_distance','address_type_distribution','route_difficulty','route_difficulty_code','route_difficulty_manual','route_difficulty_manual_code','raw','parse_errors'].sort();
  snapshot.rows.forEach((row, i) => {
    assert.deepEqual(Object.keys(row).sort(), keys);
    assert.equal(row.route_id, fixture.data.records[i].roadAreaId);
    for (const field of ['route_id', 'pickup_volume', 'pph', 'first_mile_distance']) assert.equal(typeof row[field], 'number');
    for (const field of ['station','route_name','dsp_name','route_difficulty','route_difficulty_code']) assert.equal(typeof row[field], 'string');
    assert.deepEqual(row.address_type_distribution[0], { type_code: '0', type_name: '独栋住宅 / 别墅', share: 0.5 });
    assert.equal(row.raw.actualPph, fixture.data.records[i].actualPph);
    assert.deepEqual(row.raw.receiveAddressType, fixture.data.records[i].receiveAddressType);
    assert.deepEqual(row.parse_errors, []);
  });
  assert.deepEqual(snapshot.rows.map(r => r.route_difficulty_manual), [null, 'B级 中', null]);
  assert.deepEqual(snapshot.rows.map(r => r.route_difficulty_manual_code), [null, '2', null]);
  const visit = (value) => { if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { assert.doesNotMatch(key, /daily/i); visit(child); } };
  visit(snapshot);
});

test('numeric strings convert while raw values remain unchanged', () => {
  const body = structuredClone(fixture); const r = body.data.records[0];
  r.roadAreaId = '900001'; r.receiptQty = '800'; r.actualPph = '20.5'; r.firstOrderMileage = '12.5'; r.receiveAddressType[0].typeValue = '0.5';
  const row = transform(body).stationSnapshot.rows[0];
  assert.equal(row.route_id, 900001); assert.equal(row.pickup_volume, 800); assert.equal(row.pph, 20.5);
  assert.equal(row.first_mile_distance, 12.5); assert.equal(row.address_type_distribution[0].share, 0.5);
  assert.equal(row.raw.actualPph, '20.5');
});
for (const invalid of ['unknown', '', true, {}, Infinity]) test(`invalid number ${JSON.stringify(invalid)} produces parse error`, () => {
  const body = structuredClone(fixture); body.data.records[0].actualPph = invalid;
  const row = transform(body).stationSnapshot.rows[0];
  assert.equal(row.pph, null); assert.equal(row.parse_errors[0].field, 'pph'); assert.deepEqual(row.parse_errors[0].raw, invalid);
});
test('missing optional keys produce errors; explicit null numeric values do not', () => {
  const body = structuredClone(fixture); delete body.data.records[0].fleetName; body.data.records[0].actualPph = null;
  const row = transform(body).stationSnapshot.rows[0];
  assert.equal(row.dsp_name, null); assert.equal(row.pph, null); assert.equal(row.parse_errors.length, 1);
});
for (const key of ['roadAreaId','roadAreaName','transitStationName']) test(`missing required ${key} rejects response`, () => {
  const body = structuredClone(fixture); delete body.data.records[0][key]; assert.throws(() => transform(body), SchemaError);
});
for (const [name, mutate] of [
  ['station mismatch', b => b.data.records[0].transitStationName = 'MFR01'],
  ['pagination', b => b.data.total = 4],
  ['duplicate ID', b => b.data.records[1].roadAreaId = b.data.records[0].roadAreaId],
  ['fractional ID', b => b.data.records[0].roadAreaId = 1.5],
  ['null ID', b => b.data.records[0].roadAreaId = null],
  ['non-string name', b => b.data.records[0].roadAreaName = null],
  ['records shape', b => b.data.records = {}],
  ['unsuccessful', b => { b.code = 500; b.success = false; }],
  ['string total', b => b.data.total = '3'],
]) test(`schema rejects ${name}`, () => { const body = structuredClone(fixture); mutate(body); assert.throws(() => transform(body), SchemaError); });
test('empty successful response is a valid snapshot', () => {
  assert.deepEqual(transform({ success: true, data: { records: [], total: 0 } }).stationSnapshot.rows, []);
});
test('address distribution malformed values yield null and parse errors', () => {
  for (const value of [null, {}, [{ typeCode: '0', typeName: '住宅', typeValue: 'unknown' }], [{ typeCode: '0', typeName: '住宅', typeValue: null }], [{}]]) {
    const body = structuredClone(fixture); body.data.records[0].receiveAddressType = value;
    const row = transform(body).stationSnapshot.rows[0]; assert.equal(row.address_type_distribution, null); assert.ok(row.parse_errors.length);
  }
});

async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'nc-t3-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir;
}
test('store writes versioned snapshot atomically and preserves other stations', async t => {
  const runtimeDir = await temporary(t); const events = [];
  await fs.writeFile(path.join(runtimeDir,'route-profiles.json'), JSON.stringify({ schema_version: 1, stations: { MFR01: { rows: ['synthetic'] } } }));
  const fileOps = { ...fs, writeFile: async (...args) => { events.push(['write', args[0]]); return fs.writeFile(...args); }, rename: async (...args) => { events.push(['rename', ...args]); return fs.rename(...args); } };
  const filename = await saveStationSnapshot({ runtimeDir, station:'SFO01', stationSnapshot: transform().stationSnapshot, fileOps });
  const data = JSON.parse(await fs.readFile(filename,'utf8'));
  assert.equal(data.schema_version,1); assert.deepEqual(data.stations.MFR01,{ rows:['synthetic'] }); assert.equal(data.stations.SFO01.rows.length,3);
  assert.equal(events[0][0],'write'); assert.notEqual(events[0][1],filename); assert.equal(path.dirname(events[0][1]),runtimeDir);
  assert.deepEqual(events[1],['rename',events[0][1],filename]); assert.deepEqual(await fs.readdir(runtimeDir),['route-profiles.json']);
});
test('failed atomic write preserves main file, cleans temporary file and records safe failure', async t => {
  const runtimeDir = await temporary(t); const filename = path.join(runtimeDir,'route-profiles.json');
  const previous = JSON.stringify({ schema_version:1,stations:{ SFO01:{ rows:['old'] } } }); await fs.writeFile(filename,previous);
  await assert.rejects(saveStationSnapshot({runtimeDir,station:'SFO01',stationSnapshot:transform().stationSnapshot,
    fileOps:{...fs,rename:async () => { throw new Error('private raw failure'); }} }),StoreError);
  assert.equal(await fs.readFile(filename,'utf8'),previous);
  await writeLastFailure({runtimeDir,station:'SFO01',step:'store',errorType:'StoreError'});
  const failure = JSON.parse(await fs.readFile(path.join(runtimeDir,'last-failure.json'),'utf8'));
  assert.deepEqual(Object.keys(failure).sort(),['at','station','step','error_type','message','detail'].sort());
  assert.equal(failure.error_type,'StoreError'); assert.equal(failure.step,'store');
  assert.doesNotMatch(JSON.stringify(failure), /private raw failure|https?:/);
  assert.deepEqual((await fs.readdir(runtimeDir)).sort(),['last-failure.json','route-profiles.json']);
});
test('malformed existing store is never overwritten', async t => {
  const runtimeDir = await temporary(t); const filename = path.join(runtimeDir,'route-profiles.json'); await fs.writeFile(filename,'invalid');
  await assert.rejects(saveStationSnapshot({runtimeDir,station:'SFO01',stationSnapshot:transform().stationSnapshot}),StoreError);
  assert.equal(await fs.readFile(filename,'utf8'),'invalid');
});

test('runtime default, fallback, relative override and warning policy', () => {
  const options = { platform:'win32',homedir:'C:\\Users\\test',repoRoot:'C:\\repo',env:{ LOCALAPPDATA:'C:\\Local' } };
  assert.equal(resolveRuntimeDir(options),'C:\\Local\\nc-ops-console\\runtime-data');
  assert.equal(resolveRuntimeDir({...options,env:{}}),'C:\\Users\\test\\.nc-ops-console\\runtime-data');
  assert.equal(resolveRuntimeDir({...options,env:{RUNTIME_DATA_DIR:'runtime-data'}}),'C:\\repo\\runtime-data');
  assert.ok(checkRuntimeDir('C:\\REPO\\runtime-data',options.repoRoot,'win32').warnings.length);
  for (const name of ['OneDrive','Dropbox','Google Drive','iCloud']) assert.ok(checkRuntimeDir(`C:\\${name}\\data`,options.repoRoot,'win32').warnings.length);
  assert.deepEqual(checkRuntimeDir('C:\\Local\\runtime',options.repoRoot,'win32').warnings,[]);
  assert.equal(resolveRuntimeDir({env:{},platform:'linux',homedir:'/home/test',repoRoot:'/repo'}),'/home/test/.nc-ops-console/runtime-data');
  assert.equal(parseMaxListRequests(''),3); assert.equal(parseMaxListRequests('5'),5);
  for (const value of ['0','-1','x','1.5']) assert.throws(() => parseMaxListRequests(value));
});

function pageHarness({ login = false, password = false, requests = 1, status, triggerAt = 'goto', failSelector = false, pending = false, rawFailure = false, precedingBodies = [] } = {}) {
  const page = new EventEmitter(), events = [], logs = []; let closes = 0;
  const url = 'https://example.invalid/areaDepiction';
  const request = () => ({url:()=>'https://example.invalid/prod-api/dlvs-dataApi/roadAreaPortrait/home/frontPage/queryList/pagination?ignored=1',method:()=>'POST',postDataJSON:()=>({ transitStationCodeList: ['synthetic-station'], pageSize: 100 })});
  const response = {url:()=>request().url(),request,status:()=>200,json:async()=>fixture};
  const trigger = () => {
    for (let i=0;i<requests;i++) page.emit('request',request());
    if (status) page.emit('response',{url:()=>'https://example.invalid/prod-api/test',status:()=>status});
  };
  const locator = (selector) => ({
    count:async()=>selector === 'input[type=password]' ? Number(password) : 1,
    nth:()=>locator('item'),first:()=>locator(selector), filter:()=>locator(selector),getByText:()=>locator('station-option'),
    locator:(value)=>locator(value),innerText:async()=>'转运站点',
    click:async()=>{ events.push(selector); if(failSelector && selector==='station-option') throw new Error('private selector error'); },
  });
  page.locator=locator; page.getByText=()=>locator('展开'); page.getByRole=()=>({click:async()=>{events.push('查询'); if(triggerAt==='query')trigger();}});
  page.keyboard={press:async key=>events.push(key)};
  page.goto=async()=>{if(rawFailure)throw new Error('private navigation error'); if(triggerAt==='goto')trigger(); if(pending)await new Promise(()=>{});};
  page.url=()=>login?'https://example.invalid/login':url;
  page.waitForResponse=async predicate=>{
    assert.equal(predicate({...response,request:()=>({...request(),method:()=> 'GET'})}),false);
    for (const body of precedingBodies) {
      const earlier = {...response,request:()=>({...request(),postDataJSON:()=>{if(body instanceof Error)throw body;return body;}}),json:async()=>({unfiltered:true})};
      if (predicate(earlier)) return earlier;
    }
    assert.equal(predicate(response),true); return response;
  };
  const browserType={launch:async({headless})=>{assert.equal(headless,false);return {newContext:async options=>{assert.deepEqual(options,{storageState:'/outside/state.json'});return {newPage:async()=>page};},close:async()=>{closes++;}};}};
  return {events,logs,get closes(){return closes;},run:()=>captureRoutePortrait({browserType,statePath:'/outside/state.json',baseUrl:url,station:'SFO01',log:s=>logs.push(s)})};
}
test('page capture returns original body, follows permitted controls and closes browser', async()=>{
  const h=pageHarness();const result=await h.run();assert.equal(result.body,fixture);assert.equal(result.listRequestCount,1);assert.equal(result.requestCount,1);
  assert.deepEqual(h.events,['展开','.dbuMicroSysApp-select-selector','station-option','Escape','.vxe-pager--sizes','.vxe-select-option:visible','查询']);assert.ok(h.closes);
  assert.doesNotMatch(h.logs.join('\n'),/example.invalid|ignored|DSP-ALPHA/);
});

test('page capture ignores late unfiltered, wrong-size and malformed list responses', async () => {
  const h = pageHarness({ precedingBodies: [
    { pageSize: 100 },
    { transitStationCodeList: 'synthetic-station', pageSize: 100 },
    { transitStationCodeList: ['synthetic-station'], pageSize: 20 },
    null, new Error('synthetic JSON parse failure'),
  ] });
  assert.equal((await h.run()).body, fixture);
  assert.equal(h.events.filter(event => event === '查询').length, 1);
});
for(const options of [{login:true},{password:true}])test('login detection stops without UI operations',async()=>{
  const h=pageHarness(options);await assert.rejects(h.run(),NeedsLoginError);assert.deepEqual(h.events,[]);assert.ok(h.closes);
});
for(const triggerAt of ['goto','query'])test(`request ceiling stops during ${triggerAt}`,async()=>{
  const h=pageHarness({requests:4,triggerAt,pending:triggerAt==='goto'});await assert.rejects(h.run(),LoadLimitError);assert.ok(h.closes);
});
for(const status of [429,500,503,599])test(`circuit breaker stops on ${status} during pending navigation`,async()=>{
  const h=pageHarness({status,pending:true});await assert.rejects(h.run(),CircuitBreakerError);assert.deepEqual(h.events,[]);assert.ok(h.closes);
});
test('missing station control fails at explicit selector stage',async()=>{const h=pageHarness({failSelector:true});await assert.rejects(h.run(),e=>e instanceof SelectorError && /转运站点/.test(e.message));assert.ok(h.closes);});
test('raw browser errors are sanitized',async()=>{const h=pageHarness({rawFailure:true});await assert.rejects(h.run(),e=>e instanceof CaptureError && !/private/.test(e.message));assert.ok(h.closes);});

const cliEnv = { DMS_BASE_URL:'https://example.invalid/areaDepiction', DMS_STATE_PATH:path.join(tmpdir(),'outside-nc-state.json'), RUNTIME_DATA_DIR:path.join(tmpdir(),'nc-runtime-mock') };
test('CLI rejects unsupported station before session check or browser loading',async()=>{
  let touched=false;const logs=[];
  assert.equal(await runScrape({args:['--station','MFR01'],env:cliEnv,errorLog:s=>logs.push(s),sessionExists:async()=>{touched=true;},capture:async()=>{touched=true;}}),1);
  assert.equal(touched,false);assert.match(logs.join(''),/T3 只支持 SFO01/);
});
test('CLI missing session gives login guidance without browser loading',async()=>{
  let touched=false;const logs=[];
  assert.equal(await runScrape({args:['--station','SFO01'],env:cliEnv,errorLog:s=>logs.push(s),sessionExists:async()=>{const e=new Error();e.code='ENOENT';throw e;},capture:async()=>{touched=true;}}),1);
  assert.equal(touched,false);assert.match(logs.join(''),/npm run dms:login/);
});
test('CLI entry runs from other working directory and refuses unsupported station',()=>{
  const entry=fileURLToPath(new URL('../bin/dms-scrape.js',import.meta.url));
  const result=spawnSync(process.execPath,[entry,'--station','MFR01'],{cwd:tmpdir(),encoding:'utf8',timeout:10000,env:{...process.env,DMS_BASE_URL:''}});
  assert.equal(result.status,1);assert.match(result.stderr,/T3 只支持 SFO01/);
});
test('CLI successful mock chain saves snapshot and reports summary',async t=>{
  const runtimeDir=await temporary(t);const logs=[];
  const code=await runScrape({args:['--station','SFO01','--headless'],env:{...cliEnv,RUNTIME_DATA_DIR:runtimeDir},log:s=>logs.push(s),sessionExists:async()=>{},capture:async options=>{assert.equal(options.headless,true);return {body:fixture,listRequestCount:2};}});
  assert.equal(code,0);assert.equal(JSON.parse(await fs.readFile(path.join(runtimeDir,'route-profiles.json'),'utf8')).stations.SFO01.rows.length,3);assert.match(logs.join(''),/list 请求数：2/);
});
test('CLI transform failure preserves snapshot and records only safe metadata',async t=>{
  const runtimeDir=await temporary(t);const filename=path.join(runtimeDir,'route-profiles.json');await fs.writeFile(filename,'old');
  const logs=[];const body=structuredClone(fixture);body.data.total=4;
  assert.equal(await runScrape({args:['--station','SFO01'],env:{...cliEnv,RUNTIME_DATA_DIR:runtimeDir},errorLog:s=>logs.push(s),sessionExists:async()=>{},capture:async()=>({body})}),1);
  assert.equal(await fs.readFile(filename,'utf8'),'old');const failure=JSON.parse(await fs.readFile(path.join(runtimeDir,'last-failure.json'),'utf8'));assert.equal(failure.step,'transform');assert.equal(failure.error_type,'SchemaError');assert.match(logs.join(''),/SchemaError/);
  assert.equal(failure.detail, '需要翻页，超出 T3 范围');
  assert.ok(logs.join('').includes(failure.detail));
});

for (const error of [new SelectorError('转运站点'), new SchemaError('列表 Station 与选择的 Station 不一致'), new Error('synthetic private failure')]) {
  test(`CLI and failure record retain only allowed detail for ${error.name}`, async t => {
    const runtimeDir = await temporary(t); const logs = [];
    assert.equal(await runScrape({args:['--station','SFO01'],env:{...cliEnv,RUNTIME_DATA_DIR:runtimeDir},
      errorLog:s=>logs.push(s),sessionExists:async()=>{},capture:async()=>{throw error;}}),1);
    const failureText = await fs.readFile(path.join(runtimeDir,'last-failure.json'),'utf8');
    const failure = JSON.parse(failureText);
    if (error.name === 'Error') {
      assert.equal(failure.detail, null);
      assert.ok(!logs.join('').includes(error.message));
      assert.ok(!failureText.includes(error.message));
    } else {
      assert.equal(failure.detail, error.message);
      assert.ok(logs.join('').includes(error.message));
    }
  });
}

test('failure store discards detail for unknown error types', async t => {
  const runtimeDir = await temporary(t);
  for (const errorType of ['Error', 'UnknownError']) {
    await writeLastFailure({runtimeDir,station:'SFO01',step:'capture',errorType,detail:'synthetic private failure'});
    const text = await fs.readFile(path.join(runtimeDir,'last-failure.json'),'utf8');
    assert.equal(JSON.parse(text).detail,null);
    assert.ok(!text.includes('synthetic private failure'));
  }
});
test('CLI browser failure does not disclose raw error, needs-login gives guidance',async()=>{
  for(const error of [new Error('private error'),new NeedsLoginError()]) {
    const logs=[];const failures=[];
    assert.equal(await runScrape({args:['--station','SFO01'],env:cliEnv,errorLog:s=>logs.push(s),sessionExists:async()=>{},capture:async()=>{throw error;},failure:async value=>failures.push(value)}),1);
    assert.doesNotMatch(logs.join(''),/private error/);
    if(error instanceof NeedsLoginError){assert.match(logs.join(''),/dms:login/);assert.deepEqual(failures,[]);}else{assert.equal(failures[0].step,'capture');}
  }
});

test('request ceiling accepts exactly configured maximum and circuit ignores non-error responses', async () => {
  for (const status of [200, 404]) {
    const h = pageHarness({ requests: 3, status });
    assert.equal((await h.run()).listRequestCount, 3);
  }
});
test('CLI actual missing-session entry gives guidance without opening browser', async t => {
  const runtimeDir = await temporary(t);
  const entry = fileURLToPath(new URL('../bin/dms-scrape.js', import.meta.url));
  const result = spawnSync(process.execPath, [entry, '--station', 'SFO01'], {
    cwd: tmpdir(), encoding: 'utf8', timeout: 10000,
    env: { ...process.env, ...cliEnv, DMS_STATE_PATH: path.join(runtimeDir, 'missing.json'), RUNTIME_DATA_DIR: runtimeDir },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Session 文件不存在.*npm run dms:login/);
  assert.deepEqual(await fs.readdir(runtimeDir), []);
});
