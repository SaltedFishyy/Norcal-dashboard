import * as fs from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from './atomic-file.js';
import { StoreError } from './route-profiles-file.js';

export class RouteDetailNotFoundError extends Error {
  constructor() { super('Route detail 不存在。'); this.name = 'RouteDetailNotFoundError'; }
}
export class RouteDetailInvalidError extends Error {
  constructor() { super('Route detail 结构无效。'); this.name = 'RouteDetailInvalidError'; }
}

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string';
const nullableText = (value) => value === null || text(value);
const nullableNumber = (value) => value === null || typeof value === 'number' && Number.isFinite(value);
const errors = (value) => Array.isArray(value) && value.every((item) => object(item) && text(item.field));
const validRoute = (route, key) => object(route) && Number.isSafeInteger(route.route_id) && route.route_id > 0
  && String(route.route_id) === key && text(route.station) && !!route.station.trim()
  && text(route.route_name) && !!route.route_name.trim() && nullableText(route.route_difficulty)
  && nullableText(route.route_difficulty_code) && text(route.fetched_at) && Number.isFinite(Date.parse(route.fetched_at))
  && route.source === 'dms-playwright' && nullableNumber(route.zip_count) && errors(route.parse_errors)
  && Array.isArray(route.zips) && route.zips.every((zip) => object(zip)
    && ['postal_code', 'postal_code_tag', 'postal_code_difficulty', 'safety_level'].every((field) => nullableText(zip[field]))
    && ['first_mile_distance', 'experienced_pph', 'delivery_fail_rate', 'dnr_rate'].every((field) => nullableNumber(zip[field]))
    && (!Object.hasOwn(zip, 'pickup_volume_daily') || nullableNumber(zip.pickup_volume_daily))
    && object(zip.raw) && errors(zip.parse_errors))
  && (!Object.hasOwn(route, 'capacity_raw') || Array.isArray(route.capacity_raw));
const validFile = (data) => object(data) && data.schema_version === 1 && object(data.routes)
  && Object.entries(data.routes).every(([key, route]) => validRoute(route, key));

// Map enrichment is optional: an unavailable cache must not break the map.
export async function readRouteDetailsForMap({ runtimeDir, fileOps = fs }) {
  try {
    const data = JSON.parse(await fileOps.readFile(path.join(runtimeDir, 'route-details.json'), 'utf8'));
    return validFile(data) ? { status: 'ok', routes: data.routes } : { status: 'invalid', routes: {} };
  } catch (error) {
    return { status: error.code === 'ENOENT' ? 'none' : 'invalid', routes: {} };
  }
}

export async function saveRouteDetail({ runtimeDir, route, fileOps = fs }) {
  const filename = path.join(runtimeDir, 'route-details.json');
  try {
    let data;
    try { data = JSON.parse(await fileOps.readFile(filename, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; data = { schema_version: 1, routes: {} }; }
    if (!validFile(data) || !validRoute(route, String(route?.route_id))) throw new StoreError();
    await writeFileAtomic(filename, JSON.stringify({ ...data, routes: { ...data.routes, [String(route.route_id)]: route } }, null, 2) + '\n', { fileOps });
    return filename;
  } catch { throw new StoreError(); }
}

export async function getRouteDetail({ runtimeDir, routeId, fileOps = fs }) {
  let data;
  try { data = JSON.parse(await fileOps.readFile(path.join(runtimeDir, 'route-details.json'), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new RouteDetailNotFoundError();
    throw new RouteDetailInvalidError();
  }
  if (!validFile(data)) throw new RouteDetailInvalidError();
  if (!Object.hasOwn(data.routes, String(routeId))) throw new RouteDetailNotFoundError();
  return projectRouteDetail(data.routes[String(routeId)]);
}

export function projectRouteDetail({ route_id, station, route_name, route_difficulty, fetched_at, zip_count, zips, parse_errors }) {
  // Explicit field selection keeps source records and future private metadata off the API.
  return { route_id, station, route_name, route_difficulty, fetched_at, zip_count, parse_errors,
    zips: zips.map(({ postal_code, postal_code_tag, postal_code_difficulty, first_mile_distance, experienced_pph, delivery_fail_rate, dnr_rate, safety_level, pickup_volume_daily = null, parse_errors }) =>
      ({ postal_code, postal_code_tag, postal_code_difficulty, first_mile_distance, experienced_pph, delivery_fail_rate, dnr_rate, safety_level, pickup_volume_daily, parse_errors })) };
}

export async function listCachedRouteIds({ runtimeDir, fileOps = fs }) {
  let data;
  try { data = JSON.parse(await fileOps.readFile(path.join(runtimeDir, 'route-details.json'), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return new Set();
    throw new RouteDetailInvalidError();
  }
  if (!validFile(data)) throw new RouteDetailInvalidError();
  const ids = new Set(Object.values(data.routes).map(route => route.route_id));
  // Inspect raw stored keys: the API normalizes absent values to null for compatibility.
  Object.defineProperty(ids, 'missingPickup', { value: new Set(Object.values(data.routes)
    .filter(route => route.zips.some(zip => !Object.hasOwn(zip, 'pickup_volume_daily'))).map(route => route.route_id)) });
  return ids;
}

// Batch completeness needs the original keys, unlike the API's null defaults.
export async function readRouteDetailsForBatch({ runtimeDir, fileOps = fs }) {
  try {
    const data = JSON.parse(await fileOps.readFile(path.join(runtimeDir, 'route-details.json'), 'utf8'));
    if (!validFile(data)) throw new RouteDetailInvalidError();
    return data.routes;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new RouteDetailInvalidError();
  }
}

export async function writeRouteDetailsBatchRun({ runtimeDir, record, fileOps = fs }) {
  try {
    await writeFileAtomic(path.join(runtimeDir, 'route-details-batch-last-run.json'), JSON.stringify(record, null, 2) + '\n', { fileOps });
  } catch { throw new StoreError(); }
}
