import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class StoreError extends Error {
  constructor() { super('本地 snapshot 读取或写入失败，旧数据保留。'); this.name = 'StoreError'; }
}

export class SnapshotNotFoundError extends Error {
  constructor() { super('Snapshot 不存在。'); this.name = 'SnapshotNotFoundError'; }
}
export class SnapshotInvalidError extends Error {
  constructor() { super('Snapshot 无法读取或结构不合法。'); this.name = 'SnapshotInvalidError'; }
}
export class StationNotFoundError extends Error {
  constructor() { super('Station 不存在。'); this.name = 'StationNotFoundError'; }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;

export async function getStationSnapshot({ runtimeDir, station, fileOps = fs }) {
  let text;
  try { text = await fileOps.readFile(path.join(runtimeDir, 'route-profiles.json'), 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') throw new SnapshotNotFoundError();
    throw new SnapshotInvalidError();
  }
  let data;
  try { data = JSON.parse(text); } catch { throw new SnapshotInvalidError(); }
  if (!isObject(data) || data.schema_version !== 1 || !isObject(data.stations)) throw new SnapshotInvalidError();
  if (!Object.hasOwn(data.stations, station)) throw new StationNotFoundError();
  const snapshot = data.stations[station];
  if (!isObject(snapshot) || typeof snapshot.fetched_at !== 'string' || !Number.isFinite(snapshot.total)
    || !Array.isArray(snapshot.rows) || !(snapshot.source_as_of === null || typeof snapshot.source_as_of === 'string')) {
    throw new SnapshotInvalidError();
  }
  return snapshot;
}

async function atomicWrite(filename, value, fileOps) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await fileOps.mkdir(path.dirname(filename), { recursive: true });
    await fileOps.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await fileOps.rename(temporary, filename);
  } finally {
    await fileOps.rm(temporary, { force: true }).catch(() => {});
  }
}

export async function saveStationSnapshot({ runtimeDir, station, stationSnapshot, fileOps = fs }) {
  const filename = path.join(runtimeDir, 'route-profiles.json');
  try {
    let data;
    try { data = JSON.parse(await fileOps.readFile(filename, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; data = { schema_version: 1, stations: {} }; }
    if (data.schema_version !== 1 || !data.stations || typeof data.stations !== 'object' || Array.isArray(data.stations)) throw new StoreError();
    await atomicWrite(filename, { ...data, stations: { ...data.stations, [station]: stationSnapshot } }, fileOps);
    return filename;
  } catch { throw new StoreError(); }
}

const steps = new Set(['config', 'session', 'capture', 'transform', 'store']);
const types = new Set(['NeedsLoginError', 'SelectorError', 'LoadLimitError', 'CircuitBreakerError', 'CaptureError', 'SchemaError', 'StoreError', 'Error']);
export async function writeLastFailure({ runtimeDir, station, step, errorType, detail = null, at = new Date().toISOString(), fileOps = fs }) {
  await atomicWrite(path.join(runtimeDir, 'last-failure.json'), {
    at, station: station === 'SFO01' ? station : null,
    step: steps.has(step) ? step : 'config', error_type: types.has(errorType) ? errorType : 'Error',
    message: '本次抓取失败，未更新 snapshot；请检查对应阶段并重新运行。',
    detail: types.has(errorType) && errorType !== 'Error' ? detail : null,
  }, fileOps);
}
