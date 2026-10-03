import { open } from 'node:fs/promises';
import path from 'node:path';

const filenames = new Map([['us', 'us.pmtiles'], ['norcal', 'norcal.pmtiles'], ['ops', 'ops.pmtiles']]);
export class BasemapNotFoundError extends Error {
  constructor() { super('Basemap is unavailable.'); this.name = 'BasemapNotFoundError'; }
}
export class BasemapInvalidError extends Error {
  constructor() { super('Basemap is invalid.'); this.name = 'BasemapInvalidError'; }
}

// Keep the validated handle open until streaming completes, including client disconnects.
export async function readBasemap({ basemapDir, name }) {
  if (!filenames.has(name)) throw new BasemapNotFoundError();
  let handle;
  try {
    handle = await open(path.join(basemapDir, filenames.get(name)), 'r');
    const stat = await handle.stat(), header = Buffer.alloc(8);
    const { bytesRead } = await handle.read(header, 0, 8, 0);
    if (!stat.isFile() || bytesRead !== 8 || header.subarray(0, 7).toString() !== 'PMTiles' || header[7] !== 3) {
      throw new BasemapInvalidError();
    }
    return { size: stat.size, stream: (start = 0, end = stat.size - 1) => handle.createReadStream({ start, end }),
      close: () => handle.close() };
  } catch (error) {
    await handle?.close();
    if (error?.code === 'ENOENT') throw new BasemapNotFoundError();
    throw new BasemapInvalidError();
  }
}
