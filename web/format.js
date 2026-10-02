export function formatValue(value) {
  return value === null || value === undefined || value === '' ? '—' : String(value);
}

export function formatNumber(value, maximumFractionDigits = 2, minimumFractionDigits = 0) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits, minimumFractionDigits }).format(value);
}

export function formatUpdated(value) {
  if (typeof value !== 'string' || value === '') return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23', timeZoneName: 'short',
  }).formatToParts(date);
  const fields = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${fields.year}-${fields.month}-${fields.day} ${fields.hour}:${fields.minute} ${fields.timeZoneName}`;
}

// Only stable API codes are shown; unexpected response text may contain private paths.
const errorCodes = new Set(['invalid_station', 'snapshot_invalid', 'internal_error', 'not_found', 'method_not_allowed']);
export function pageState({ loading = false, status, data, failed = false } = {}) {
  if (loading) return { state: 'loading', message: 'Loading route profiles…' };
  if (failed) return { state: 'error', message: 'Cannot reach the local server.' };
  if ((status === 404 && ['snapshot_not_found', 'station_not_found'].includes(data?.error)) ||
      (status === 200 && Array.isArray(data?.rows) && data.rows.length === 0)) {
    return { state: 'empty', message: 'No data yet for SFO01. Run npm run dms:scrape to create a snapshot.' };
  }
  if (status === 200 && Array.isArray(data?.rows)) return { state: 'success', message: '' };
  const code = errorCodes.has(data?.error) ? data.error : 'internal_error';
  return { state: 'error', message: `Could not load route profiles (${code}).` };
}
