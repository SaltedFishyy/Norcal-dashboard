import { readFile } from 'node:fs/promises';
import path from 'node:path';

const results = new Set(['completed', 'partial', 'rejected', 'unchanged', 'header_invalid',
  'fetch_failed', 'aborted_mass_removal', 'config_invalid', 'write_role_missing', 'db_failed']);
const stages = new Set(['config', 'database', 'client', 'parse', 'token', 'sheet_query', 'values']);
const kinds = new Set(['timeout', 'network', 'unexpected', 'rate_limited', 'permission', 'not_found', 'credentials', 'sheet_too_large']);
const countKeys = ['dataRows', 'blank', 'inserted', 'replaced', 'unchanged', 'removed', 'plannedRemovals', 'protected', 'rejected', 'warnings'];
const configKeys = new Set(['LARK_APP_ID', 'LARK_APP_SECRET', 'LARK_QUOTATION_SPREADSHEET_TOKEN',
  'LARK_QUOTATION_SHEET_ID', 'LARK_OPEN_API_BASE', 'LARK_QUOTATION_MAX_REMOVAL_RATIO', 'LARK_QUOTATION_SYNC_MINUTES']);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value)
  && Number.isFinite(Date.parse(value)) ? value : null;
const id = value => (typeof value === 'string' && /^\d+$/.test(value)) || count(value) !== null ? value : null;
function project(row, success = false) {
  if (!row || typeof row !== 'object') return null;
  const base = { finished_at: timestamp(row.finished_at), result: results.has(row.result) ? row.result : null,
    counts: Object.fromEntries(countKeys.filter(key => count(row.counts?.[key]) !== null).map(key => [key, row.counts[key]])),
    import_id: id(row.import_id) };
  if (success) return ['completed', 'partial', 'unchanged'].includes(base.result) ? base : null;
  return { started_at: timestamp(row.started_at), ...base,
    stage: stages.has(row.stage) ? row.stage : null, error_kind: kinds.has(row.error_kind) ? row.error_kind : null,
    lark_code: count(row.lark_code), http_status: count(row.http_status),
    db_code: typeof row.db_code === 'string' && /^[A-Z0-9]{5}$/.test(row.db_code) ? row.db_code : null,
    rejected_count: count(row.rejected_count) ?? 0, warning_count: count(row.warning_count) ?? 0,
    notes: Array.isArray(row.notes) ? row.notes.filter(note => configKeys.has(note) || note === 'scope_unavailable') : [] };
}
export function projectQuotationSyncStatus(raw) {
  if (!raw || raw.schema_version !== 1) return null;
  return { schema_version: 1, last_attempt: project(raw.last_attempt), last_success: project(raw.last_success, true) };
}
export async function readQuotationSyncStatus(runtimeDir) {
  try { return projectQuotationSyncStatus(JSON.parse(await readFile(path.join(runtimeDir, 'quotation-sync-status.json'), 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
