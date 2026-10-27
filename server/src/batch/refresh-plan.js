import { validateDistricts, DistrictNotFoundError } from '../store/districts-file.js';

export function parseRefreshScope(value) {
  if (value === 'all') return { type: 'all' };
  if (typeof value === 'string' && /^district:[a-z0-9-]{1,32}$/.test(value))
    return { type: 'district', district: value.slice(9) };
  throw new Error('Invalid refresh scope');
}
export function planRefresh({ config, scope }) {
  validateDistricts(config);
  if (!scope || !['all', 'district'].includes(scope.type)) throw new Error('Invalid refresh scope');
  scope = parseRefreshScope(scope.type === 'all' ? 'all' : 'district:' + scope.district);
  const districts = config.districts.filter(d => scope.type === 'all' || d.id === scope.district);
  if (!districts.length) throw new DistrictNotFoundError();
  const stations = [], skipped = [];
  for (const district of districts) for (const code of district.stations) {
    const reason = district.scrape_disabled?.[code];
    if (reason) skipped.push({ code, district: district.id, reason });
    else stations.push({ code, district: district.id });
  }
  return { scope, stations, skipped };
}
