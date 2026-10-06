import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileAtomic } from './atomic-file.js';
import { StoreError } from './route-profiles-file.js';

const stationCode = value => /^[A-Z]{3}\d{2}$/.test(value);
export async function readStationBatchState({ runtimeDir, fileOps = fs }) {
  try {
    const value = JSON.parse(await fileOps.readFile(path.join(runtimeDir, 'station-batch-state.json'), 'utf8'));
    if (!/^[a-f0-9-]{36}$/.test(value.run_id) || !Array.isArray(value.station_order)
      || !value.station_order.every(stationCode) || new Set(value.station_order).size !== value.station_order.length
      || !value.stations || value.station_order.some(code => !['pending', 'in_progress', 'completed', 'limited', 'stopped'].includes(value.stations[code]?.status))
      || !Number.isFinite(Date.parse(value.started_at)) || !(value.finished_at === null || Number.isFinite(Date.parse(value.finished_at)))) throw new StoreError();
    return value;
  } catch (error) { if (error.code === 'ENOENT') return null; throw new StoreError(); }
}
export function prepareStationBatchState(previous, stations, { newRun = false, at }) {
  if (!newRun && previous && previous.finished_at === null && JSON.stringify(previous.station_order) === JSON.stringify(stations)) return previous;
  return { run_id: randomUUID(), started_at: at, finished_at: null, station_order: [...stations],
    stations: Object.fromEntries(stations.map(code => [code, { status: 'pending', summary_file: null, completed_at: null }])) };
}
export async function writeStationBatchFile({ runtimeDir, state, station, record, fileOps = fs }) {
  if (!/^[a-f0-9-]{36}$/.test(state.run_id) || station !== undefined && !stationCode(station)) throw new StoreError();
  const relative = record === undefined ? 'station-batch-state.json'
    : path.join('station-batch-runs', state.run_id, station === undefined ? 'batch-summary.json' : `${station}.json`);
  try { await writeFileAtomic(path.join(runtimeDir, relative), JSON.stringify(record ?? state, null, 2) + '\n', { fileOps }); }
  catch { throw new StoreError(); }
  return relative;
}
