import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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
    && object(zip.raw) && errors(zip.parse_errors));
const validFile = (data) => object(data) && data.schema_version === 1 && object(data.routes)
  && Object.entries(data.routes).every(([key, route]) => validRoute(route, key));

export async function saveRouteDetail({ runtimeDir, route, fileOps = fs }) {
  const filename = path.join(runtimeDir, 'route-details.json');
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    let data;
    try { data = JSON.parse(await fileOps.readFile(filename, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; data = { schema_version: 1, routes: {} }; }
    if (!validFile(data) || !validRoute(route, String(route?.route_id))) throw new StoreError();
    await fileOps.mkdir(runtimeDir, { recursive: true });
    await fileOps.writeFile(temporary, JSON.stringify({ ...data, routes: { ...data.routes, [String(route.route_id)]: route } }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await fileOps.rename(temporary, filename);
    return filename;
  } catch { throw new StoreError(); }
  finally { await fileOps.rm(temporary, { force: true }).catch(() => {}); }
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
  const { route_id, station, route_name, route_difficulty, fetched_at, zip_count, zips, parse_errors } = data.routes[String(routeId)];
  // Explicit field selection keeps source records and future private metadata off the API.
  return { route_id, station, route_name, route_difficulty, fetched_at, zip_count, parse_errors,
    zips: zips.map(({ postal_code, postal_code_tag, postal_code_difficulty, first_mile_distance, experienced_pph, delivery_fail_rate, dnr_rate, safety_level, parse_errors }) =>
      ({ postal_code, postal_code_tag, postal_code_difficulty, first_mile_distance, experienced_pph, delivery_fail_rate, dnr_rate, safety_level, parse_errors })) };
}
