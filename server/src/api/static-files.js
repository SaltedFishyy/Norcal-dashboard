import { readFile } from 'node:fs/promises';
import path from 'node:path';

const files = new Map([
  ['/', ['index.html', 'text/html']],
  ['/styles.css', ['styles.css', 'text/css']],
  ['/date-view.js', ['date-view.js', 'text/javascript']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/data-status.js', ['data-status.js', 'text/javascript']],
  ['/quotation-sync-status.js', ['quotation-sync-status.js', 'text/javascript']],
  ['/station-preference.js', ['station-preference.js', 'text/javascript']],
  ['/format.js', ['format.js', 'text/javascript']],
  ['/difficulty.js', ['difficulty.js', 'text/javascript']],
  ['/route-detail.js', ['route-detail.js', 'text/javascript']],
  ['/price-detail.js', ['price-detail.js', 'text/javascript']],
  ['/map', ['map.html', 'text/html']],
  ['/map.js', ['map.js', 'text/javascript']],
  ['/route-colors.js', ['route-colors.js', 'text/javascript']],
  ['/vendor/leaflet/leaflet.js', ['leaflet.js', 'text/javascript', 'leaflet']],
  ['/vendor/protomaps-leaflet/protomaps-leaflet.js', ['protomaps-leaflet.js', 'text/javascript', 'protomaps']],
  ...['basemap-rules', 'map-view', 'map-panel', 'map-state', 'map-text', 'warehouse-layer', 'warehouse-panel'].map(name => [`/${name}.js`, [`${name}.js`, 'text/javascript']]),
  ['/vendor/leaflet/leaflet.css', ['leaflet.css', 'text/css', 'leaflet']],
]);

export function isStaticPath(pathname) {
  return files.has(pathname);
}

export function createStaticReader(webDir, leafletDir, protomapsDir) {
  return async (pathname) => {
    const entry = files.get(pathname);
    if (!entry) throw new Error('Unknown static asset');
    const [filename, type, source = 'web'] = entry;
    return { body: await readFile(path.join(source === 'leaflet' ? leafletDir : source === 'protomaps' ? protomapsDir : webDir, filename)), contentType: `${type}; charset=utf-8` };
  };
}
