export class RouteNotFoundError extends Error {
  constructor() { super('Route not found.'); this.name = 'RouteNotFoundError'; }
}

const key = (routeId, zip) => `${routeId}:${zip}`;
export const quotationFields = ['current_first_0_1lb_price', 'current_first_0_1lb_price_min',
  'current_first_0_1lb_price_max', 'quoted_zip_count', 'unquoted_zip_count'];

export function buildPriceIndex(rows) {
  return new Map(rows.map(row => [key(row.route_id, row.postal_code), row.price]));
}
export function zipFirstPrice(index, routeId, postalCode) {
  return index?.get(key(routeId, postalCode)) ?? null;
}
export function routePriceSummary(index, row) {
  if (index == null || !Array.isArray(row.postal_codes))
    return Object.fromEntries(quotationFields.map(field => [field, null]));
  const prices = row.postal_codes.map(zip => zipFirstPrice(index, row.route_id, zip)).filter(price => price !== null);
  const min = prices.length ? Math.min(...prices) : null;
  const max = prices.length ? Math.max(...prices) : null;
  return { current_first_0_1lb_price: min === max ? min : null,
    current_first_0_1lb_price_min: min, current_first_0_1lb_price_max: max,
    quoted_zip_count: prices.length, unquoted_zip_count: row.postal_codes.length - prices.length };
}

export function buildRouteQuotation({ route, station, current, upcoming, weightBands }) {
  const zips = new Set(route.postal_codes ?? []), quoted = new Set(current.map(row => row.postal_code));
  const groups = new Map(), future = new Map();
  const bands = [...weightBands].sort((a, b) => a.ordinal - b.ordinal);
  for (const row of current) {
    if (!zips.has(row.postal_code)) continue;
    const group = { fleet_name: row.fleet_name ?? null, effective_from: row.effective_from,
      end_date: row.end_date ?? null, remarks: row.remarks ?? null,
      first: Object.fromEntries(bands.map(({ code }) => [code, row.first_prices[code]])),
      additional: Object.fromEntries(bands.map(({ code }) => [code, row.additional_prices[code]])) };
    const groupKey = JSON.stringify(group);
    if (!groups.has(groupKey)) groups.set(groupKey, { postal_codes: [], ...group });
    groups.get(groupKey).postal_codes.push(row.postal_code);
  }
  for (const row of upcoming) {
    if (!future.has(row.effective_from)) future.set(row.effective_from, new Set());
    future.get(row.effective_from).add(row.postal_code);
  }
  // Only current rows (including extra ZIPs) contribute to price freshness.
  const times = current.filter(row => row.imported_at != null).map(row => new Date(row.imported_at).getTime());
  return { route_id: route.route_id, route_name: route.route_name, station,
    weight_bands: bands.map(({ code, label_zh, label_en }) => ({ code, label_zh, label_en })),
    groups: [...groups.values()].map(group => ({ ...group, postal_codes: group.postal_codes.sort() }))
      .sort((a, b) => a.postal_codes[0].localeCompare(b.postal_codes[0])),
    unquoted_postal_codes: [...zips].filter(zip => !quoted.has(zip)).sort(),
    extra_quoted_postal_codes: [...quoted].filter(zip => !zips.has(zip)).sort(),
    upcoming: [...future].sort(([a], [b]) => a.localeCompare(b))
      .map(([effective_from, codes]) => ({ effective_from, postal_codes: [...codes].sort() })),
    updated_at: times.length ? new Date(Math.max(...times)).toISOString() : null };
}
