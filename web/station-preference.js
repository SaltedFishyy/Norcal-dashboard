export const STATION_STORAGE_KEY = 'nc-ops-console.station';

export function readSavedStation(storage) {
  try {
    return (storage === undefined ? globalThis.localStorage : storage)?.getItem(STATION_STORAGE_KEY) ?? null;
  } catch { return null; }
}

export function saveStation(storage, code) {
  try {
    (storage === undefined ? globalThis.localStorage : storage)?.setItem(STATION_STORAGE_KEY, code);
  } catch { /* Storage may be unavailable; selection still works. */ }
}

export function chooseStation({ urlStation, savedStation, stations }) {
  return [urlStation, savedStation, 'SFO01'].find(code => stations.includes(code)) ?? stations[0];
}
