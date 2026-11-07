export function readLarkQuotationConfig(env = process.env) {
  const required = ['LARK_APP_ID', 'LARK_APP_SECRET', 'LARK_QUOTATION_SPREADSHEET_TOKEN'];
  const missing = required.filter(key => !env[key]?.trim());
  if (missing.length) throw new Error(`Missing: ${missing.join(', ')}`);
  const single = env.LARK_QUOTATION_SHEET_ID?.trim();
  const sheetIds = [...new Set((env.LARK_QUOTATION_SHEET_IDS ?? single ?? '').split(',').map(id => id.trim()).filter(Boolean))];
  if (!sheetIds.length || sheetIds.length > 60 || sheetIds.some(id => !/^[A-Za-z0-9]+$/.test(id))
    || (single && !sheetIds.includes(single))) throw new Error('Invalid LARK_QUOTATION_SHEET_IDS');
  let url;
  try {
    url = new URL(env.LARK_OPEN_API_BASE || 'https://open.larkenterprise.com');
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error();
  } catch { throw new Error('Invalid LARK_OPEN_API_BASE'); }
  const maxRemovalRatio = Number(env.LARK_QUOTATION_MAX_REMOVAL_RATIO ?? 0.2);
  const syncMinutes = Number(env.LARK_QUOTATION_SYNC_MINUTES ?? 0);
  if (!Number.isFinite(maxRemovalRatio) || maxRemovalRatio <= 0 || maxRemovalRatio > 1)
    throw new Error('Invalid LARK_QUOTATION_MAX_REMOVAL_RATIO');
  if (!Number.isSafeInteger(syncMinutes) || syncMinutes < 0 || env.LARK_QUOTATION_SYNC_MINUTES?.trim() === '')
    throw new Error('Invalid LARK_QUOTATION_SYNC_MINUTES');
  const base = url.href.replace(/\/+$/, '').replace(/\/open-apis$/, '');
  const config = { apiBase: base + '/open-apis', appId: env.LARK_APP_ID.trim(),
    spreadsheetToken: env.LARK_QUOTATION_SPREADSHEET_TOKEN.trim(), sheetId: sheetIds[0], sheetIds,
    maxRemovalRatio, syncMinutes };
  Object.defineProperty(config, 'appSecret', { value: env.LARK_APP_SECRET.trim() });
  return config;
}
