import { parseRoutePostalCodes, findPostalCodeConflicts } from './postal-codes.js';

export class SchemaError extends Error {
  constructor(message) { super(message); this.name = 'SchemaError'; }
}

const fields = {
  dsp_name: 'fleetName', pickup_volume: 'receiptQty', pph: 'actualPph',
  first_mile_distance: 'firstOrderMileage', address_type_distribution: 'receiveAddressType',
  route_difficulty: 'roadAreaDifficulty', route_difficulty_code: 'roadAreaDifficultyCode',
  route_difficulty_manual: 'roadAreaDifficultyManualName', route_difficulty_manual_code: 'roadAreaDifficultyManual',
};
const numericFields = new Set(['pickup_volume', 'pph', 'first_mile_distance']);
const own = (obj, key) => Object.hasOwn(obj, key);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function transformRoutePortrait(body, { station, fetchedAt }) {
  if (typeof station !== 'string' || !station || typeof fetchedAt !== 'string' || !Number.isFinite(Date.parse(fetchedAt))) {
    throw new SchemaError('Station 或抓取时间无效');
  }
  if (!object(body) || !(body.success === true || body.code === 200) || !object(body.data)
    || !Array.isArray(body.data.records) || !Number.isFinite(body.data.total) || body.data.total < 0) {
    throw new SchemaError('列表响应结构或成功状态无效');
  }
  const { records, total } = body.data;
  if (total > records.length) throw new SchemaError('需要翻页，超出 T3 范围');
  const ids = new Set();
  const rows = records.map((record) => {
    if (!object(record) || ['roadAreaId', 'roadAreaName', 'transitStationName'].some((key) => !own(record, key))) {
      throw new SchemaError('缺少路区必需字段');
    }
    if (record.transitStationName !== station) throw new SchemaError('列表 Station 与选择的 Station 不一致');
    if (typeof record.roadAreaName !== 'string') throw new SchemaError('路区名称必须为字符串');
    const id = typeof record.roadAreaId === 'string' && record.roadAreaId.trim()
      ? Number(record.roadAreaId) : record.roadAreaId;
    if (!Number.isSafeInteger(id)) throw new SchemaError('路区 ID 必须为整数');
    if (ids.has(id)) throw new SchemaError('路区 ID 重复');
    ids.add(id);
    const row = { route_id: id, station, route_name: record.roadAreaName, postal_codes: parseRoutePostalCodes(record), raw: {}, parse_errors: [] };
    for (const key of ['roadAreaId', 'roadAreaName', 'transitStationName', 'postalCodeList', 'postalCodeNum', ...Object.values(fields)]) {
      row.raw[key] = own(record, key) ? structuredClone(record[key]) : null;
    }
    const error = (field, raw, reason) => row.parse_errors.push({ field, raw: raw === undefined ? null : structuredClone(raw), reason });
    const number = (value, field) => {
      if (value == null) return null;
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
      error(field, value, '不是有限数字');
      return null;
    };
    const string = (value, field) => {
      if (value == null) return null;
      if (typeof value === 'string') return value;
      error(field, value, '不是字符串');
      return null;
    };
    for (const [field, source] of Object.entries(fields)) {
      const value = record[source];
      if (!own(record, source)) {
        row[field] = null;
        error(field, null, '来源字段缺失');
      } else if (numericFields.has(field)) row[field] = number(value, field);
      else if (field === 'address_type_distribution') {
        if (!Array.isArray(value)) {
          row[field] = null;
          error(field, value, '来源不是数组');
        } else {
          let invalid = false;
          const distribution = value.map((entry, index) => {
            const prefix = `${field}[${index}]`;
            if (!object(entry) || !['typeCode', 'typeName', 'typeValue'].every((key) => own(entry, key))) {
              error(prefix, entry, '地址类型结构无效'); invalid = true; return null;
            }
            const code = string(entry.typeCode, `${prefix}.type_code`);
            const name = string(entry.typeName, `${prefix}.type_name`);
            const share = number(entry.typeValue, `${prefix}.share`);
            if (code === null || name === null || share === null) {
              invalid = true;
              if (entry.typeCode == null || entry.typeName == null || entry.typeValue == null) {
                error(prefix, entry, '地址类型字段不能为空');
              }
            }
            return { type_code: code, type_name: name, share };
          });
          row[field] = invalid ? null : distribution;
        }
      } else row[field] = string(value, field);
    }
    return row;
  });
  const conflicts = findPostalCodeConflicts(rows);
  if (conflicts.length) throw new SchemaError(`Station ${station} ZIP 冲突: ${JSON.stringify(conflicts)}`);
  return { stationSnapshot: { fetched_at: fetchedAt, source_as_of: null, source: 'dms-playwright', total, rows },
    warnings: rows.flatMap((row) => row.parse_errors.map(({ field, reason }) => ({ route_id: row.route_id, field, reason }))) };
}
