import { readFile } from 'node:fs/promises';
import path from 'node:path';

const files = new Map([
  ['/', ['index.html', 'text/html']],
  ['/styles.css', ['styles.css', 'text/css']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/format.js', ['format.js', 'text/javascript']],
  ['/route-detail.js', ['route-detail.js', 'text/javascript']],
]);

export function isStaticPath(pathname) {
  return files.has(pathname);
}

export function createStaticReader(webDir) {
  return async (pathname) => {
    const entry = files.get(pathname);
    if (!entry) throw new Error('Unknown static asset');
    const [filename, type] = entry;
    return { body: await readFile(path.join(webDir, filename)), contentType: `${type}; charset=utf-8` };
  };
}
