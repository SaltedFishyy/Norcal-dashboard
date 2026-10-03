import { validateBoundaries } from '../src/store/boundaries-file.js';
export const geometry = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
export const route = (route_id, route_name, postal_codes) => ({ route_id, route_name, postal_codes,
  station: 'MOCKA', dsp_name: null, pickup_volume: null, pph: null });
export const snapshot = rows => ({ fetched_at: '2026-10-02T00:00:00Z', source_as_of: null, source: 'mock', total: rows.length, rows });
export const profiles = () => ({ schema_version: 1, stations: {
  MOCKB: snapshot([{ ...route(3, 'Mock-C', ['00009']), station: 'MOCKB' }]),
  MOCKA: snapshot([route(2, 'Mock-B', ['00004', '00005']), route(1, 'Mock-A', ['00002', '00123'])]),
} });
export const rawBoundaries = () => ({
  geojson: { type: 'FeatureCollection', features: ['00123', '00002', '00009'].map(postal_code =>
    ({ type: 'Feature', properties: { postal_code }, geometry: structuredClone(geometry) })) },
  meta: { dataset: 'mock-census', vintage: 2020, source_url: 'mock', generated_at: '2026-10-02T00:00:00Z',
    boundary_file: 'zcta2020_ca_nv_or.geojson', scope: { postal_code_pattern: '^(0000[249]|00123)$' }, feature_count: 3 },
});

export const boundaries = () => { const data = rawBoundaries(); return validateBoundaries(data.geojson, data.meta); };
