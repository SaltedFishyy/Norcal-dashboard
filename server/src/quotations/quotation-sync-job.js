import path from 'node:path';
import { connectDb } from '../db/connection.js';
import { writeFileAtomic } from '../store/atomic-file.js';
import { readLarkQuotationConfig } from './lark-config.js';
import { createLarkClient } from './lark-client.js';
import { runLarkQuotationSheets } from './lark-sync.js';
import { readQuotationSyncStatus, projectQuotationSyncStatus } from './quotation-sync-status.js';

export async function runScheduledQuotationSync({ env = process.env, runtimeDir, connect = connectDb,
  larkClientFactory = createLarkClient, now = () => new Date() }) {
  const started_at = new Date(now()).toISOString();
  let config, client, summary;
  try { config = readLarkQuotationConfig(env); }
  catch (error) {
    summary = { result: 'config_invalid', stage: 'config',
      notes: error.message.match(/\b(?:LARK_[A-Z_]+)\b/g) ?? [] };
  }
  if (!summary && !env.NC_DB_QUOTATION_URL) summary = { result: 'write_role_missing', stage: 'config' };
  if (!summary) {
    try {
      // The writer reads routes and quotations in the same locked transaction.
      client = await connect('NC_DB_QUOTATION_URL', { env });
      const larkClient = larkClientFactory({ apiBase: config.apiBase, appId: config.appId, appSecret: config.appSecret });
      summary = await runLarkQuotationSheets({ config, larkClient, writeClient: client, dryRun: false });
    } catch (error) {
      summary = { result: 'db_failed', stage: 'database', db_code: error?.code };
    } finally { await client?.end().catch(() => {}); }
  }
  const previous = await readQuotationSyncStatus(runtimeDir);
  const attempt = { started_at, finished_at: new Date(now()).toISOString(), result: summary.result,
    stage: summary.stage, error_kind: summary.errorKind, lark_code: summary.larkCode,
    http_status: summary.httpStatus, db_code: summary.db_code, counts: summary.totals ?? summary.counts,
    rejected_count: summary.sheets?.reduce((n, sheet) => n + (sheet.rejected?.length ?? 0), 0) ?? 0, warning_count: summary.sheets?.reduce((n, sheet) => n + (sheet.warnings?.length ?? 0), 0) ?? 0,
    notes: summary.notes, import_id: summary.importId,
    sheets: summary.sheets?.map(sheet => ({ sheet_id: sheet.sheet.sheetId, title: sheet.sheet.title,
      result: sheet.result, stage: sheet.stage, error_kind: sheet.errorKind, counts: sheet.counts,
      rejected_count: sheet.rejected?.length ?? 0, warning_count: sheet.warnings?.length ?? 0,
      notes: sheet.notes, import_id: sheet.importId })) };
  const status = projectQuotationSyncStatus({ schema_version: 2, last_attempt: attempt,
    last_success: ['completed', 'partial', 'unchanged', 'partial_failure'].includes(attempt.result) ? attempt : previous?.last_success });
  await writeFileAtomic(path.join(runtimeDir, 'quotation-sync-status.json'), JSON.stringify(status));
  return status;
}
