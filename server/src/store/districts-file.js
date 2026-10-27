import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const defaultDistrictsPath = fileURLToPath(new URL('../../../config/districts.json', import.meta.url));
export class DistrictConfigInvalidError extends Error {
  constructor() { super('District configuration is invalid.'); this.name = 'DistrictConfigInvalidError'; }
}
export class DistrictNotFoundError extends Error {
  constructor() { super('District does not exist.'); this.name = 'DistrictNotFoundError'; }
}

export function validateDistricts(data) {
  const ids = new Set(), stations = new Set();
  if (data?.schema_version !== 1 || !Array.isArray(data.districts) || !data.districts.length) throw new DistrictConfigInvalidError();
  for (const district of data.districts) {
    if (!district || typeof district.id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(district.id)
      || ids.has(district.id) || district.id === 'unassigned'
      || !['name_zh', 'name_en'].every(key => typeof district[key] === 'string' && district[key].trim())
      || !Array.isArray(district.stations)) throw new DistrictConfigInvalidError();
    if (Object.hasOwn(district, 'scrape_disabled')) {
      const disabled = district.scrape_disabled;
      if (!disabled || typeof disabled !== 'object' || Array.isArray(disabled)
        || Object.entries(disabled).some(([code, reason]) => !district.stations.includes(code)
          || !['not_in_dms_menu', 'no_permission', 'disabled'].includes(reason))) throw new DistrictConfigInvalidError();
    }
    ids.add(district.id);
    for (const code of district.stations) {
      if (typeof code !== 'string' || !/^[A-Z]{3}\d{2}$/.test(code) || stations.has(code)) throw new DistrictConfigInvalidError();
      stations.add(code);
    }
  }
  return data;
}

export async function readDistrictConfig({ districtsPath = defaultDistrictsPath } = {}) {
  try { return validateDistricts(JSON.parse(await readFile(districtsPath, 'utf8'))); }
  catch { throw new DistrictConfigInvalidError(); }
}

export async function readDistricts({ districtsPath, profiles = { stations: {} } } = {}) {
  const config = await readDistrictConfig({ districtsPath });
  const configured = new Set(config.districts.flatMap(district => district.stations));
  const districts = config.districts.map(({ id, name_zh, name_en, stations }) => ({ id, name_zh, name_en,
    stations: stations.map(code => ({ code, has_snapshot: Object.hasOwn(profiles.stations, code) })) }));
  const extra = Object.keys(profiles.stations).filter(code => !configured.has(code)).sort();
  if (extra.length) districts.push({ id: 'unassigned', name_zh: '未分配站点', name_en: 'Unassigned Stations',
    stations: extra.map(code => ({ code, has_snapshot: true })) });
  return districts;
}
