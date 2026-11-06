import { LarkError } from './lark-client.js';
import { parseQuotationSheet } from './lark-sheet-parse.js';
import { planQuotationSync } from './quotation-sync-plan.js';
import { readActiveRoutes, readScopeLines, readOtherSourceKeys, applyQuotationSync } from './quotation-sync-db.js';

export function columnLetters(count) {
  if (!Number.isSafeInteger(count) || count < 1) throw new LarkError('sheet_query', 'unexpected');
  let result = '';
  for (; count; count = Math.floor((count - 1) / 26)) result = String.fromCharCode(65 + (count - 1) % 26) + result;
  return result;
}

export async function fetchQuotationSheet({ config, larkClient }) {
  const sheet = (await larkClient.querySheets(config.spreadsheetToken)).find(item => item.sheetId === config.sheetId);
  if (!sheet) throw new LarkError('sheet_query', 'not_found');
  if (sheet.rowCount > 5000) throw new LarkError('sheet_query', 'sheet_too_large');
  if (!Number.isSafeInteger(sheet.rowCount) || sheet.rowCount < 1) throw new LarkError('sheet_query', 'unexpected');
  const { values, revision } = await larkClient.readValues(config.spreadsheetToken,
    `${config.sheetId}!A1:${columnLetters(sheet.columnCount)}${sheet.rowCount}`);
  return { sheet: { sheetId: sheet.sheetId, title: sheet.title, rowCount: sheet.rowCount, columnCount: sheet.columnCount },
    revision, parsed: parseQuotationSheet(values) };
}

export async function runLarkQuotationSync({ config, larkClient, readerClient, writeClient, dryRun = false }) {
  const summary = { result: null, dryRun, stage: null, errorKind: null, larkCode: null, httpStatus: null,
    sheet: null, revision: null, counts: {}, rejected: [], warnings: [], notes: [], importId: null,
    startedAt: new Date().toISOString(), finishedAt: null };
  try {
    const { sheet, revision, parsed } = await fetchQuotationSheet({ config, larkClient });
    Object.assign(summary, { sheet, revision });
    if (!parsed.ok) return Object.assign(summary, { result: 'header_invalid', stage: 'parse', missingColumns: parsed.detail });
    const sourceRef = `lark:${config.spreadsheetToken}/${config.sheetId}`;
    let plan;
    if (dryRun) {
      const activeRoutes = await readActiveRoutes(readerClient);
      let scopeLines = [], otherSourceKeys = [];
      try {
        scopeLines = await readScopeLines(writeClient ?? readerClient, sourceRef);
        otherSourceKeys = await readOtherSourceKeys(writeClient ?? readerClient, sourceRef);
      } catch (error) {
        if (!['42501', '42P01'].includes(error.code)) throw error;
        scopeLines = []; otherSourceKeys = []; summary.notes.push('scope_unavailable');
      }
      plan = planQuotationSync({ parsed, activeRoutes, scopeLines, otherSourceKeys, maxRemovalRatio: config.maxRemovalRatio });
    } else {
      if (!writeClient) throw new Error('NC_DB_QUOTATION_URL required');
      const applied = await applyQuotationSync({ client: writeClient, sourceRef, parsed, maxRemovalRatio: config.maxRemovalRatio });
      plan = applied.plan; summary.importId = applied.importId;
    }
    Object.assign(summary, { result: plan.result, counts: plan.counts, rejected: plan.rejected, warnings: plan.warnings });
    return summary;
  } catch (error) {
    if (!(error instanceof LarkError)) throw error;
    return Object.assign(summary, { result: 'fetch_failed', stage: error.stage, errorKind: error.kind,
      larkCode: error.larkCode ?? null, httpStatus: error.httpStatus ?? null });
  } finally { summary.finishedAt = new Date().toISOString(); }
}
