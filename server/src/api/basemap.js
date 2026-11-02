import { pipeline } from 'node:stream/promises';

export const basemapPaths = new Map(['us', 'norcal', 'socal', 'mountain', 'pnw', 'az', 'hawaii', 'ops'].map(name => [`/basemap/${name}.pmtiles`, name]));

export function parseRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  const first = Number(match[1]), last = Number(match[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return null;
  const start = match[1] ? first : Math.max(0, size - last);
  const end = match[1] && match[2] ? Math.min(last, size - 1) : size - 1;
  if ((!match[1] && last === 0) || start >= size || start > end) return null;
  return { start, end };
}

export function createBasemapHandler(read, csp, record) {
  return async ({ rawPath, req, res }) => {
    const file = await read(basemapPaths.get(rawPath));
    try {
      const range = req.headers.range === undefined ? { start: 0, end: file.size - 1 }
        : parseRange(req.headers.range, file.size);
      const headers = { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes',
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': csp,
        'Cache-Control': 'private, max-age=3600' };
      if (!range) {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${file.size}`, 'Content-Length': 0 });
        res.end(); record(416); return;
      }
      const status = req.headers.range === undefined ? 200 : 206;
      if (status === 206) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${file.size}`;
      headers['Content-Length'] = range.end - range.start + 1;
      res.writeHead(status, headers);
      await pipeline(file.stream(range.start, range.end), res);
      record(status);
    } finally { await file.close(); }
  };
}
