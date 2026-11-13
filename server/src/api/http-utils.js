import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);

function acceptsGzip(value = '') {
  return value.split(',').some(entry => {
    const [coding, ...parameters] = entry.trim().split(';');
    if (coding.trim().toLowerCase() !== 'gzip') return false;
    const quality = parameters.find(parameter => /^\s*q\s*=/i.test(parameter));
    return quality === undefined || Number(quality.split('=')[1].trim()) > 0;
  });
}

// Shared by read-only JSON and static assets; PMTiles bypasses this sender.
export async function sendBody(req, res, status, body, headers) {
  let payload = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(body);
  const encoded = res.hasHeader('Content-Encoding')
    || Object.keys(headers).some(key => key.toLowerCase() === 'content-encoding');
  if (req.method !== 'HEAD' && !encoded && payload.length > 1024
    && acceptsGzip(req.headers['accept-encoding'])) {
    payload = await gzipAsync(payload);
    const vary = res.getHeader('Vary') ?? headers.Vary;
    headers = { ...headers, 'Content-Encoding': 'gzip',
      Vary: vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding' };
  }
  res.writeHead(status, headers);
  res.end(payload);
}

export function sendJsonCompressed(req, res, status, body) {
  return sendBody(req, res, status, JSON.stringify(body), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
}

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}
