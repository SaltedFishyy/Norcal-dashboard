import { buildPaintRules, buildLabelRules } from './basemap-rules.js';

// The default 16 can cause label eviction/redraw loops and freeze the main thread
// when a viewport spans more than 16 data tiles. Recheck this internal property
// on library upgrades; see docs/features/map-visual-refresh.md MVR-BF1.
export const LABEL_TILE_CAP = 128;

// Based on @protomaps/basemaps 5.7.2 LIGHT; BSD-3-Clause, © Protomaps.
// Google daytime style overrides follow map-visual-refresh.md P4-1.
export const BASEMAP_FLAVOR = {
  "background": "#aadaff",
  "earth": "#f5f3f0",
  "park_a": "#c3eccb",
  "park_b": "#b5e3bd",
  "hospital": "#fbe3e3",
  "industrial": "#ebe9ee",
  "school": "#efe9de",
  "wood_a": "#cfe8cf",
  "wood_b": "#b9dfb9",
  "pedestrian": "#f1efec",
  "scrub_a": "#e4efdc",
  "scrub_b": "#dcebd2",
  "glacier": "#ffffff",
  "sand": "#f3eedf",
  "beach": "#f3eedf",
  "aerodrome": "#e9eaf0",
  "runway": "#d9dbe2",
  "water": "#aadaff",
  "zoo": "#c3eccb",
  "military": "#eceae6",
  "tunnel_other_casing": "#dadce0",
  "tunnel_minor_casing": "#dadce0",
  "tunnel_link_casing": "#dadce0",
  "tunnel_major_casing": "#dadce0",
  "tunnel_highway_casing": "#dadce0",
  "tunnel_other": "#f1f3f4",
  "tunnel_minor": "#f1f3f4",
  "tunnel_link": "#f1f3f4",
  "tunnel_major": "#f1f3f4",
  "tunnel_highway": "#f1f3f4",
  "pier": "#ffffff",
  "buildings": "#e8e9ed",
  "minor_service_casing": "#e2e3e6",
  "minor_casing": "#dadce0",
  "link_casing": "#e9bc62",
  "major_casing_late": "#dadce0",
  "highway_casing_late": "#e9bc62",
  "other": "#ffffff",
  "minor_service": "#ffffff",
  "minor_a": "#ffffff",
  "minor_b": "#ffffff",
  "link": "#fde293",
  "major_casing_early": "#dadce0",
  "major": "#ffffff",
  "highway_casing_early": "#e9bc62",
  "highway": "#fdd774",
  "railway": "#c4c7cc",
  "boundaries": "#9aa0a6",
  "bridges_other_casing": "#dadce0",
  "bridges_minor_casing": "#dadce0",
  "bridges_link_casing": "#e9bc62",
  "bridges_major_casing": "#dadce0",
  "bridges_highway_casing": "#e9bc62",
  "bridges_other": "#ffffff",
  "bridges_minor": "#ffffff",
  "bridges_link": "#fde293",
  "bridges_major": "#ffffff",
  "bridges_highway": "#fdd774",
  "roads_label_minor": "#70757a",
  "roads_label_minor_halo": "#ffffff",
  "roads_label_major": "#5f6368",
  "roads_label_major_halo": "#ffffff",
  "ocean_label": "#4c7fae",
  "subplace_label": "#70757a",
  "subplace_label_halo": "#ffffff",
  "city_label": "#3c4043",
  "city_label_halo": "#ffffff",
  "state_label": "#80868b",
  "state_label_halo": "#ffffff",
  "country_label": "#5f6368",
  "address_label": "#80868b",
  "address_label_halo": "#ffffff",
  "pois": {
    "blue": "#1A8CBD",
    "green": "#20834D",
    "lapis": "#315BCF",
    "pink": "#EF56BA",
    "red": "#F2567A",
    "slategray": "#6A5B8F",
    "tangerine": "#CB6704",
    "turquoise": "#00C3D4"
  },
  "landcover": {
    "grassland": "rgba(212, 238, 205, 1)",
    "barren": "rgba(240, 236, 226, 1)",
    "urban_area": "rgba(240, 238, 235, 1)",
    "farmland": "rgba(232, 240, 220, 1)",
    "glacier": "rgba(255, 255, 255, 1)",
    "scrub": "rgba(222, 238, 212, 1)",
    "forest": "rgba(197, 230, 197, 1)"
  }
};

// Generated from config/basemap-service-region.json; [west, south, east, north].
export const SERVICE_BOUNDS = [
  [-122.57,36.53,-121.16,37.92], // SFO01
  [-122.03,35.9,-120.79,36.87], // OAR01
  [-122.27,38.07,-120.92,39.45], // SMF01
  [-122.01,37.61,-120.86,38.89], // SCK01
  [-120.3,38.68,-118.7,39.99], // RNO01
  [-122.83,39.89,-121.86,40.82], // RDG01
  [-122.73,39.33,-121.57,40.25], // RDG02
  [-121.54,36.96,-120.39,37.98], // MOD01
  [-123.69,41.95,-122.24,42.82], // MFR01
  [-123.06,37.74,-121.48,38.91], // SFO02
  [-105.57,37.87,-104.24,40.89], // DEN01
  [-105.33,40.95,-104.27,41.71], // CYS01
  [-107.25,34.39,-106.35,35.53], // ABQ01
  [-108.36,36.06,-107.59,37.05], // FMN01
  [-106.38,35.33,-105.67,36.11], // SAF01
  [-114.09,39.76,-110.85,41.42], // SLC01
  [-113,42.5,-112.05,43.6], // PIH01
  [-114.75,42.16,-113.56,42.93], // TWF01
  [-112.46,43.32,-111.51,43.99], // IDA01
  [-112.5,41.29,-111.38,42.05], // LGU01
  [-108.97,45.38,-108.02,45.99], // BIL01
  [-117.84,33.38,-116.62,35.32], // CNO01
  [-118.29,33.72,-117.47,34.39], // LAX01
  [-118.57,33.66,-117.91,34.3], // LAX02
  [-118.32,33.21,-117.37,33.97], // LAX03
  [-119.07,34.01,-118.05,34.67], // SFV01
  [-118.76,34.18,-117.62,34.91], // SFV02
  [-120.47,34.04,-118.65,34.84], // VTC01
  [-121.24,34.39,-119.97,35.84], // SMX01
  [-119.7,34.86,-118.54,36.19], // BKD01
  [-121.17,35.74,-118.8,37.59], // FAT01
  [-116.82,33.53,-115.75,34.08], // PLM01
  [-117.45,32.48,-116.73,33.37], // SAN01
  [-114.87,32.39,-113.63,33.51], // YUM02
  [-116.01,32.6,-114.88,33.27], // YUM01
  [-158.33,21.21,-157.6,21.76], // HNL01
  [-122.98,46.85,-121.25,48.04], // SEA01
  [-122.87,47.66,-121.58,49.05], // PAE01
  [-117.59,47.44,-116.46,48.01], // GEG01
  [-120.97,46.5,-120.08,46.96], // YKM01
  [-119.49,45.88,-118.48,46.69], // TRC01
  [-116.81,43.31,-116.01,43.92], // BOI01
  [-123.17,45.07,-122.19,45.92], // PDX01
  [-123.42,43.79,-122.57,45.16], // EUG01
  [-112.82,32.9,-111.33,34.06], // PHX01
  [-111.39,31.64,-110.6,32.67], // TUC01
  [-112.56,32.57,-111.47,33.2], // CGZ01
  [-113.27,34.33,-111.88,35.08], // PRC01
  [-115.7,35.73,-114.67,36.53], // LAS01
  [-114.1,36.95,-112.87,38.08], // STG01
  [-114.7,34.2,-113.28,35.77], // IFP01
  [-112,34.89,-110.99,35.77], // FLG01
];

// Match the actual service data tile (including overzoom), not a continent-sized envelope.
export function serviceTile(coords) {
  if (coords.z < 11) return null;
  const z = Math.min(coords.z, 14), scale = 2 ** (coords.z - z);
  const x = Math.floor(coords.x / scale), y = Math.floor(coords.y / scale);
  // Admission follows display tiles; using only an overzoom parent would suppress
  // fallback beyond the outer bounds where GridLayer never creates service tiles.
  const displayN = 2 ** coords.z;
  const displayLat = row => Math.atan(Math.sinh(Math.PI * (1 - 2 * row / displayN))) * 180 / Math.PI;
  const west = coords.x / displayN * 360 - 180, east = (coords.x + 1) / displayN * 360 - 180;
  const north = displayLat(coords.y), south = displayLat(coords.y + 1);
  return SERVICE_BOUNDS.some(([w, s, e, n]) => west < e && east > w && south < n && north > s)
    ? { z, x, y, key: z + '/' + x + '/' + y } : null;
}
export const basemaps = [
  { name: 'us', maxZoom: 6, maxDataZoom: 6, bounds: [[24.0, -125.0], [49.5, -66.5]] },
  { name: 'norcal', minZoom: 7, maxDataZoom: 10, bounds: [[35.5, -124.6], [42.5, -119.0]] },
  { name: 'socal', minZoom: 7, maxDataZoom: 10, bounds: [[32.4, -121.5], [35.6, -114.0]] },
  { name: 'mountain', minZoom: 7, maxDataZoom: 10, bounds: [[34.0, -116.5], [47.0, -103.0]] },
  { name: 'pnw', minZoom: 7, maxDataZoom: 10, bounds: [[42.0, -124.9], [49.1, -116.4]] },
  { name: 'az', minZoom: 7, maxDataZoom: 10, bounds: [[31.2, -115.0], [37.4, -108.8]] },
  { name: 'hawaii', minZoom: 7, maxDataZoom: 10, bounds: [[18.8, -160.6], [22.4, -154.7]] },
  { name: 'ops', minZoom: 10, maxDataZoom: 14, bounds: [[36.43, -123.16], [39.01, -121.06]] },
  { name: 'service', minZoom: 11, maxDataZoom: 14, levelDiff: 0, bounds: [[21.21, -158.33], [49.05, -104.24]] },
];

// Preflight the local archives: the renderer logs archive failures rather than firing tileerror.
// Missing archives must not prevent operational polygons from rendering.
export async function loadBasemapLayers({ protomaps, map, request, onBasemapError, grid }) {
  const baseLayers = [], missing = new Set();
  let serviceAvailable = false, refreshPending = false;
  const refreshCoverage = () => {
    if (refreshPending) return;
    refreshPending = true;
    queueMicrotask(() => {
      refreshPending = false;
      baseLayers.forEach(layer => layer.redraw?.());
    });
  };
  const hasService = coords => {
    const tile = serviceTile(coords);
    return serviceAvailable && tile && !missing.has(tile.key);
  };
  for (const { name, ...options } of basemaps) {
    try {
      const url = `/basemap/${name}.pmtiles`;
      const validate = async () => {
        const response = await request(url, { headers: { Range: 'bytes=0-7' } });
        if (response.status !== 206) throw new Error('Basemap unavailable');
        const header = new Uint8Array(await response.arrayBuffer());
        if (header.length !== 8 || new TextDecoder().decode(header.subarray(0, 7)) !== 'PMTiles' || header[7] !== 3) {
          throw new Error('Basemap invalid');
        }
      };
      // The service union is sparse. Defer even its header Range until an admitted tile.
      let validated;
      if (name !== 'service') await validate();
      // Use the exported source's PMTiles instance to report later Range failures too.
      // Returning an empty tile on failure lets the renderer preserve polygons without logging private errors.
      const archive = new protomaps.PmtilesSource(url, true).p;
      const getTile = archive.getZxy.bind(archive);
      archive.getZxy = async (...args) => {
        // Defense in depth: no tile Range requests in gaps between service bboxes.
        if (name === 'service' && !serviceTile({ z: args[0], x: args[1], y: args[2] })) return undefined;
        try {
          if (name === 'service') await (validated ??= validate());
          const tile = await getTile(...args);
          if (name === 'service' && !tile) {
            const key = args.slice(0, 3).join('/');
            if (!missing.has(key)) { missing.add(key); refreshCoverage(); }
          }
          return tile;
        }
        catch (error) {
          if (error?.name === 'AbortError') throw error;
          if (name === 'service') { serviceAvailable = false; refreshCoverage(); }
          onBasemapError(); return undefined;
        }
      };
      const layer = protomaps.leafletLayer({ url: archive, ...options, paintRules: buildPaintRules(protomaps, BASEMAP_FLAVOR), labelRules: buildLabelRules(protomaps, BASEMAP_FLAVOR, "en"), backgroundColor: BASEMAP_FLAVOR.background, ...grid });
      if (typeof layer.labelers?.maxLabeledTiles === 'number') {
        layer.labelers.maxLabeledTiles = LABEL_TILE_CAP;
      }
      // GridLayer bounds only understands one rectangle. Refine admission to the union
      // and give each display tile exactly one owner; regional overzoom fills the rest.
      const validTile = layer._isValidTile?.bind(layer) ?? (() => true);
      layer._isValidTile = coords => validTile(coords) &&
        (name === 'service' ? Boolean(hasService(coords)) : !hasService(coords));
      if (name === 'service') serviceAvailable = true;
      baseLayers.push(layer);
      layer.on('tileerror', onBasemapError); layer.addTo(map);
    } catch { onBasemapError(); }
  }
  refreshCoverage();
}
