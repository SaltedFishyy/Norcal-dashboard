import { validPoint, greatCircleKm } from './warehouse-rules.js';

const MAX_BYTES = 256 * 1024;
export function createCensusGeocoder({ fetch = globalThis.fetch, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  let queue = Promise.resolve(), lastStart = -Infinity;
  async function request(address) {
    const delay = Math.max(0, 1000 - (now() - lastStart));
    if (delay) await sleep(delay);
    lastStart = now();
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]);
    let reader;
    try {
      const url = new URL('https://geocoding.geo.census.gov/geocoder/locations/onelineaddress');
      url.search = new URLSearchParams({ address, benchmark: 'Public_AR_Current', format: 'json' });
      const response = await fetch(url, { signal, credentials: 'omit', redirect: 'error' });
      if (!response.ok || Number(response.headers.get('content-length')) > MAX_BYTES) {
        controller.abort(); return { status: 'unavailable' };
      }
      reader = response.body.getReader();
      const chunks = []; let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) { controller.abort(); await reader.cancel(); return { status: 'unavailable' }; }
        chunks.push(value);
      }
      const matches = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.result?.addressMatches;
      if (!Array.isArray(matches)) return { status: 'unavailable' };
      if (!matches.length) return { status: 'failed' };
      const points = matches.map(m => ({ latitude: m?.coordinates?.y, longitude: m?.coordinates?.x }));
      if (matches.some((m, i) => !validPoint(points[i]) || typeof m.matchedAddress !== 'string')) return { status: 'unavailable' };
      if (points.some((a, i) => points.slice(i + 1).some(b => greatCircleKm(a, b) > 0.1))) return { status: 'ambiguous' };
      return { status: 'ok', ...points[0], matched_address: matches[0].matchedAddress };
    } catch { return { status: 'unavailable' }; }
    finally { reader?.releaseLock(); }
  }
  return { geocode(address) {
    const result = queue.then(() => request(address));
    queue = result.catch(() => {});
    return result;
  } };
}
