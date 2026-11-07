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

export async function fetchQuotationSheet({ config, larkClient, sheets }) {
  const sheet = (sheets ?? await larkClient.querySheets(config.spreadsheetToken)).find(item => item.sheetId === config.sheetId);
  if (!sheet) throw new LarkError('sheet_query', 'not_found');
  if (sheet.rowCount > 5000) throw new LarkError('sheet_query', 'sheet_too_large');
  if (!Number.isSafeInteger(sheet.rowCount) || sheet.rowCount < 1) throw new LarkError('sheet_query', 'unexpected');
  const { values, revision } = await larkClient.readValues(config.spreadsheetToken,
    `${config.sheetId}!A1:${columnLetters(sheet.columnCount)}${sheet.rowCount}`);
  return { sheet: { sheetId: sheet.sheetId, title: sheet.title, rowCount: sheet.rowCount, columnCount: sheet.columnCount },
    revision, parsed: parseQuotationSheet(values) };
}

export async function runLarkQuotationSync({ config, larkClient, readerClient, writeClient, dryRun = false, sheets }) {
  const summary = { result: null, dryRun, stage: null, errorKind: null, larkCode: null, httpStatus: null,
    sheet: null, revision: null, counts: {}, rejected: [], warnings: [], notes: [], importId: null,
    startedAt: new Date().toISOString(), finishedAt: null };
  try {
    const { sheet, revision, parsed } = await fetchQuotationSheet({ config, larkClient, sheets });
    Object.assign(summary, { sheet, revision });
    if (!parsed.ok) return Object.assign(summary, { result: 'header_invalid', stage: 'parse', missingColumns: parsed.detail });
    summary.notes.push(...(parsed.notes ?? []));
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

export const quotationSyncSucceeded = result => ['completed', 'partial', 'unchanged'].includes(result);
export async function runLarkQuotationSheets(options) {
  const { config, larkClient } = options;
  let catalog, catalogError;
  try { catalog = await larkClient.querySheets(config.spreadsheetToken); }
  catch (error) { catalogError = error; }
  const sheets = [];
  for (const sheetId of config.sheetIds ?? [config.sheetId]) {
    let summary;
    try {
      if (catalogError) throw catalogError;
      summary = await runLarkQuotationSync({ ...options, config: { ...config, sheetId }, sheets: catalog });
    } catch (error) {
      summary = error instanceof LarkError
        ? { result: 'fetch_failed', stage: error.stage, errorKind: error.kind }
        : { result: 'db_failed', stage: 'database', db_code: /^[A-Z0-9]{5}$/.test(error?.code ?? '') ? error.code : null };
    }
    sheets.push({ ...summary, sheet: summary.sheet ?? catalog?.find(sheet => sheet.sheetId === sheetId) ?? { sheetId } });
  }
  const successful = sheets.filter(sheet => quotationSyncSucceeded(sheet.result));
  const result = !successful.length ? 'failed' : successful.length < sheets.length ? 'partial_failure'
    : sheets.some(sheet => sheet.result === 'partial') ? 'partial'
    : sheets.every(sheet => sheet.result === 'unchanged') ? 'unchanged' : 'completed';
  const totals = {};
  for (const sheet of sheets) for (const [key, value] of Object.entries(sheet.counts ?? {})) totals[key] = (totals[key] ?? 0) + value;
  return { result, sheets, totals };
}
