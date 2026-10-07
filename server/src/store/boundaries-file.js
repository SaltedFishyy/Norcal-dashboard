import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export class BoundaryInvalidError extends Error {
  constructor() { super('Boundary data is invalid.'); this.name = 'BoundaryInvalidError'; }
}
export class BoundaryNotFoundError extends Error {
  constructor() { super('Boundary data is unavailable.'); this.name = 'BoundaryNotFoundError'; }
}

const cache = new Map();

export function validateBoundaries(geojson, meta) {
  const fail = () => { throw new BoundaryInvalidError(); };
  if (geojson?.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) fail();
  const zips = new Set();
  for (const feature of geojson.features) {
    const zip = feature?.properties?.postal_code;
    if (feature?.type !== 'Feature' || !['Polygon', 'MultiPolygon'].includes(feature.geometry?.type)
      || typeof zip !== 'string' || !/^\d{5}$/.test(zip) || zips.has(zip)) fail();
    // Reject malformed coordinates before they reach Leaflet; preserve the source geometry.
    const polygonValid = polygon => Array.isArray(polygon) && polygon.length > 0 && polygon.every(ring =>
      Array.isArray(ring) && ring.length >= 4 && ring.every(point => Array.isArray(point) && point.length >= 2
        && point.every(Number.isFinite) && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90)
      && ring[0].length === ring.at(-1).length && ring[0].every((n, i) => n === ring.at(-1)[i]));
    const coordinates = feature.geometry.coordinates;
    if (feature.geometry.type === 'Polygon' ? !polygonValid(coordinates)
      : !Array.isArray(coordinates) || !coordinates.length || !coordinates.every(polygonValid)) fail();
    zips.add(zip);
  }
  if (!meta || typeof meta.dataset !== 'string' || !meta.dataset || !Number.isInteger(meta.vintage)
    || typeof meta.scope?.postal_code_pattern !== 'string' || !meta.scope.postal_code_pattern
    || meta.feature_count !== geojson.features.length) fail();
  let pattern;
  try { pattern = new RegExp(meta.scope.postal_code_pattern); } catch { fail(); }
  const inScope = zip => typeof zip === 'string' && /^\d{5}$/.test(zip) && pattern.test(zip);
  if ([...zips].some(zip => !inScope(zip))) fail();
  return { geojson, meta, byZip: new Map(geojson.features.map(feature => [feature.properties.postal_code, feature.geometry])), inScope };
}

export async function readBoundaries({ geoDir, fileOps }) {
  // Only successful default reads are cached; injected file operations stay isolated for tests.
  if (fileOps) return loadBoundaries(geoDir, fileOps);
  const key = path.resolve(geoDir);
  if (!cache.has(key)) {
    const pending = loadBoundaries(key, { readFile, readdir }).catch(error => { cache.delete(key); throw error; });
    cache.set(key, pending);
  }
  return cache.get(key);
}

async function loadBoundaries(geoDir, fileOps) {
  let filenames;
  try {
    filenames = (await fileOps.readdir(geoDir)).filter(name => name.endsWith('.meta.json')).sort();
  } catch (error) {
    if (error?.code === 'ENOENT') throw new BoundaryNotFoundError();
    throw new BoundaryInvalidError();
  }
  if (!filenames.length) throw new BoundaryNotFoundError();
  try {
    const regions = [];
    const byZip = new Map();
    for (const filename of filenames) {
      const meta = JSON.parse(await fileOps.readFile(path.join(geoDir, filename), 'utf8'));
      // Metadata may only reference a GeoJSON file in this boundary directory.
      if (typeof meta?.boundary_file !== 'string' || !/^[^/\\]+\.geojson$/.test(meta.boundary_file)
        || meta.boundary_file.includes(':')) throw new BoundaryInvalidError();
      const geojson = JSON.parse(await fileOps.readFile(path.join(geoDir, meta.boundary_file), 'utf8'));
      const region = validateBoundaries(geojson, meta);
      if (regions.length && (meta.dataset !== regions[0].meta.dataset || meta.vintage !== regions[0].meta.vintage)) {
        throw new BoundaryInvalidError();
      }
      for (const [zip, geometry] of region.byZip) {
        if (byZip.has(zip)) throw new BoundaryInvalidError();
        byZip.set(zip, geometry);
      }
      regions.push(region);
    }
    return { meta: regions[0].meta, byZip, inScope: zip => regions.some(region => region.inScope(zip)),
      geojson: { type: 'FeatureCollection', features: regions.flatMap(region => region.geojson.features) } };
  }
  catch { throw new BoundaryInvalidError(); }
}
