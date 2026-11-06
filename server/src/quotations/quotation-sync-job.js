import path from 'node:path';
import { connectDb } from '../db/connection.js';
import { writeFileAtomic } from '../store/atomic-file.js';
import { readLarkQuotationConfig } from './lark-config.js';
import { createLarkClient } from './lark-client.js';
import { runLarkQuotationSync } from './lark-sync.js';
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
      summary = await runLarkQuotationSync({ config, larkClient, writeClient: client, dryRun: false });
    } catch (error) {
      summary = { result: 'db_failed', stage: 'database', db_code: error?.code };
    } finally { await client?.end().catch(() => {}); }
  }
  const previous = await readQuotationSyncStatus(runtimeDir);
  const attempt = { started_at, finished_at: new Date(now()).toISOString(), result: summary.result,
    stage: summary.stage, error_kind: summary.errorKind, lark_code: summary.larkCode,
    http_status: summary.httpStatus, db_code: summary.db_code, counts: summary.counts,
    rejected_count: summary.rejected?.length ?? 0, warning_count: summary.warnings?.length ?? 0,
    notes: summary.notes, import_id: summary.importId };
  const status = projectQuotationSyncStatus({ schema_version: 1, last_attempt: attempt,
    last_success: ['completed', 'partial', 'unchanged'].includes(attempt.result) ? attempt : previous?.last_success });
  await writeFileAtomic(path.join(runtimeDir, 'quotation-sync-status.json'), JSON.stringify(status));
  return status;
}
