import { connectDb } from '../db/connection.js';
import { readLarkQuotationConfig } from './lark-config.js';
import { createLarkClient, LarkError } from './lark-client.js';
import { fetchQuotationSheet, runLarkQuotationSync } from './lark-sync.js';

const tally = (rows, key) => rows.reduce((counts, row) => {
  counts[row[key]] = (counts[row[key]] ?? 0) + 1;
  return counts;
}, {});
const sqlstate = error => /^[A-Z0-9]{5}$/.test(error?.code ?? '') ? error.code : null;

export async function runLarkCommand({ check = false, args = [], env = process.env, log = console.log,
  connect = connectDb, makeClient = createLarkClient } = {}) {
  const clients = [];
  let stage = 'config';
  try {
    if (args.some(arg => arg !== '--dry-run') || (check && args.length)) { log('invalid_arguments'); return 1; }
    const dryRun = args.includes('--dry-run');
    // Check the dedicated writer before reading Lark or opening any database connection.
    if (!check && !dryRun && !env.NC_DB_QUOTATION_URL) { log('NC_DB_QUOTATION_URL required'); return 1; }
    const config = readLarkQuotationConfig(env);
    stage = 'client';
    const larkClient = makeClient({ apiBase: config.apiBase, appId: config.appId, appSecret: config.appSecret });
    if (check) {
      stage = 'fetch';
      const { sheet, parsed } = await fetchQuotationSheet({ config, larkClient });
      log(JSON.stringify({ connected: true, sheet, headerValid: parsed.ok, missingColumns: parsed.detail ?? [],
        dataRows: parsed.dataRowCount ?? 0, blankRows: parsed.blankRowCount ?? 0,
        rejectedByReason: tally(parsed.rejected ?? [], 'reason'), warningsByCode: tally(parsed.warnings ?? [], 'code') }));
      return parsed.ok ? 0 : 1;
    }
    stage = 'database';
    let readerClient, writeClient;
    if (dryRun) { readerClient = await connect('NC_DB_READER_URL', { env }); clients.push(readerClient); }
    if (env.NC_DB_QUOTATION_URL) { writeClient = await connect('NC_DB_QUOTATION_URL', { env }); clients.push(writeClient); }
    const summary = await runLarkQuotationSync({ config, larkClient, readerClient, writeClient, dryRun });
    log(JSON.stringify({ ...summary, warningsByCode: tally(summary.warnings, 'code'), warnings: summary.warnings.slice(0, 20) }));
    return ['completed', 'partial', 'unchanged'].includes(summary.result) ? 0 : 1;
  } catch (error) {
    if (error instanceof LarkError) log(JSON.stringify({ connected: false, stage: error.stage,
      errorKind: error.kind, httpStatus: error.httpStatus ?? null, larkCode: error.larkCode ?? null }));
    else if (stage === 'config') log(error.message);
    else log(JSON.stringify({ result: 'quotation_sync_failed', sqlstate: sqlstate(error) }));
    return 1;
  } finally { for (const client of clients) await client.end().catch(() => {}); }
}
