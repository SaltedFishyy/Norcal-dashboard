import { readDistrictConfig } from '../store/districts-file.js';
import { DataSourceUnavailableError } from '../store/data-source.js';
import { createCensusGeocoder } from './geocoder.js';
import { validateWarehouse, validateAssignment, addressKey, projectWarehouse,
  distanceToExtentKm, FAR_FROM_DISTRICT_KM } from './warehouse-rules.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function createWarehouseHandlers({ dataSource, store, geocoder = createCensusGeocoder(), districtsPath,
  getDistrictExtent = async () => null, allowedHosts = () => [], writeEnabled = false }) {
  const handler = async ({ req, url, respond }) => {
    const fail = (status, error, extra = {}) => respond(status, { error, ...extra });
    if (req.method === 'GET') {
      const ids = url.searchParams.getAll('district');
      if ([...url.searchParams.keys()].some(k => k !== 'district') || ids.length > 1) return fail(400, 'invalid_district');
      const config = await readDistrictConfig({ districtsPath });
      if (ids.length && !config.districts.some(d => d.id === ids[0])) return fail(404, 'district_not_found');
      if (!dataSource.readWarehouses) throw new DataSourceUnavailableError();
      const rows = await dataSource.readWarehouses({ districtId: ids[0] });
      const warehouses = rows.map(row => projectWarehouse(row, config))
        .filter(row => !ids.length || row.district_known && row.district_id === ids[0])
        .sort((a, b) => a.warehouse_name.localeCompare(b.warehouse_name));
      return respond(200, { warehouses });
    }
    const host = req.headers.host?.toLowerCase();
    if (!allowedHosts().includes(host)) return fail(403, 'forbidden_host');
    if (req.headers.origin?.toLowerCase() !== `http://${host}`) return fail(403, 'forbidden_origin');
    if (req.headers['x-nc-warehouse'] !== '1') return fail(403, 'forbidden_header');
    if (req.method !== 'DELETE' && req.headers['content-type'] !== 'application/json') return fail(400, 'invalid_content_type');
    let body;
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4096) return fail(400, 'invalid_body');
        chunks.push(chunk);
      }
      if (req.method !== 'DELETE') {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'invalid_body');
      }
    } catch { return fail(400, 'invalid_body'); }
    const ids = url.searchParams.getAll('id'), id = ids[0];
    if (req.method !== 'POST' && (ids.length !== 1 || !uuid.test(id))) return fail(400, 'invalid_warehouse_id');
    if ([...url.searchParams.keys()].some(k => k !== (req.method === 'POST' ? '' : 'id'))) return fail(400, 'invalid_body');
    if (req.method === 'DELETE') {
      if (!await store.remove(id)) return fail(404, 'warehouse_not_found');
      return respond(204);
    }
    const patch = req.method === 'PATCH';
    const validation = validateWarehouse(body, { patch });
    if (validation.error) return fail(400, validation.error, { fields: validation.fields });
    const { values } = validation;
    const config = await readDistrictConfig({ districtsPath });
    const assignmentError = validateAssignment(values, config);
    if (assignmentError) return fail(400, assignmentError);
    const original = patch ? await store.get(id) : null;
    if (patch && !original) return fail(404, 'warehouse_not_found');
    if (patch && new Date(original.updated_at).getTime() !== Date.parse(values.expected_updated_at)) return fail(409, 'warehouse_changed');
    const key = addressKey(values.address);
    const duplicates = !patch || key !== original.address_key ? await store.findByAddressKey(key, { excludeId: id }) : [];
    let geocode = null, point;
    if (values.manual_coordinates) point = values.manual_coordinates;
    else if (!patch || values.address !== original.address.trim()) {
      const result = await geocoder.geocode(values.address);
      if (result.status !== 'ok') return fail(result.status === 'unavailable' ? 503 : 422,
        { unavailable: 'geocode_unavailable', ambiguous: 'geocode_ambiguous', failed: 'geocode_failed' }[result.status] ?? 'geocode_unavailable');
      geocode = { matched_address: result.matched_address, latitude: result.latitude, longitude: result.longitude };
      point = geocode;
    } else point = original;
    let distance = null;
    if (!patch || point.latitude !== original.latitude || point.longitude !== original.longitude || values.district_id !== original.district_id) {
      const extent = await getDistrictExtent(values.district_id);
      if (extent) distance = distanceToExtentKm(point, extent);
    }
    const reasons = [];
    if (duplicates.length && !values.confirm?.includes('duplicate_address')) reasons.push('duplicate_address');
    if (distance > FAR_FROM_DISTRICT_KM && !values.confirm?.includes('far_from_district')) reasons.push('far_from_district');
    if (reasons.length) return fail(409, 'confirmation_required', { reasons,
      duplicates: duplicates.map(({ warehouse_name, address, district_id }) => ({ warehouse_name, address, district_id })),
      geocode: geocode ?? { matched_address: null, latitude: point.latitude, longitude: point.longitude }, distance_km: distance });
    const names = await store.findByName(values.warehouse_name, { excludeId: id });
    const saved = { ...values, address_key: key, latitude: point.latitude, longitude: point.longitude };
    const result = patch ? await store.update(id, saved, values.expected_updated_at) : { row: await store.insert(saved) };
    if (result.error) return fail(result.error === 'warehouse_changed' ? 409 : 404, result.error);
    return respond(patch ? 200 : 201, { warehouse: projectWarehouse(result.row, config), geocode,
      warnings: names.length ? ['duplicate_name'] : [] });
  };
  handler.methods = writeEnabled ? ['GET', 'POST', 'PATCH', 'DELETE'] : ['GET'];
  return new Map([['/api/warehouses', handler]]);
}
