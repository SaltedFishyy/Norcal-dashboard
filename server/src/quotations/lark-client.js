export class LarkError extends Error {
  constructor(stage, kind, httpStatus, larkCode) {
    super(`Lark ${stage}: ${kind}${httpStatus == null ? '' : ` HTTP ${httpStatus}`}${larkCode == null ? '' : ` code ${larkCode}`}`);
    this.name = 'LarkError';
    Object.assign(this, { stage, kind, httpStatus, larkCode });
  }
}

export function createLarkClient({ apiBase, appId, appSecret, fetchImpl = fetch, timeoutMs = 15000, now = Date.now }) {
  let token, expiresAt = 0;
  async function request(stage, path, options) {
    const signal = AbortSignal.timeout(timeoutMs);
    let response, body;
    try {
      response = await fetchImpl(apiBase + path, { ...options, signal });
      body = await response.json();
    } catch (error) {
      throw new LarkError(stage, signal.aborted || ['TimeoutError', 'AbortError'].includes(error?.name)
        ? 'timeout' : response ? 'unexpected' : 'network', response?.status);
    }
    const status = response.status, code = typeof body?.code === 'number' ? body.code : undefined;
    const kind = status === 429 ? 'rate_limited' : [401, 403].includes(status) ? 'permission'
      : status === 404 ? 'not_found' : stage === 'token' && code != null && code !== 0 ? 'credentials' : 'unexpected';
    if (!response.ok || code !== 0) throw new LarkError(stage, kind, status, code);
    return body;
  }
  async function getTenantToken() {
    if (token && now() < expiresAt) return token;
    const body = await request('token', '/auth/v3/tenant_access_token/internal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app_id: appId, app_secret: appSecret }) });
    if (typeof body.tenant_access_token !== 'string' || !Number.isFinite(body.expire) || body.expire <= 0)
      throw new LarkError('token', 'unexpected');
    token = body.tenant_access_token;
    expiresAt = now() + Math.max(0, body.expire - 300) * 1000;
    return token;
  }
  async function authorized(stage, path) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const access = await getTenantToken();
      try { return await request(stage, path, { method: 'GET', headers: { Authorization: `Bearer ${access}` } }); }
      catch (error) {
        if (attempt === 0 && [99991661, 99991663, 99991668].includes(error.larkCode)) { token = undefined; expiresAt = 0; }
        else throw error;
      }
    }
  }
  return { getTenantToken,
    async querySheets(spreadsheetToken) {
      const body = await authorized('sheet_query', `/sheets/v3/spreadsheets/${encodeURIComponent(spreadsheetToken)}/sheets/query`);
      if (!Array.isArray(body.data?.sheets)) throw new LarkError('sheet_query', 'unexpected');
      return body.data.sheets.map(sheet => ({ sheetId: sheet.sheet_id, title: sheet.title, index: sheet.index,
        hidden: sheet.hidden, rowCount: sheet.grid_properties?.row_count, columnCount: sheet.grid_properties?.column_count }));
    },
    async readValues(spreadsheetToken, range) {
      const body = await authorized('values', `/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values/${encodeURIComponent(range)}?valueRenderOption=UnformattedValue&dateTimeRenderOption=FormattedString`);
      if (!body.data?.valueRange) throw new LarkError('values', 'unexpected');
      return { values: body.data.valueRange.values ?? [], revision: body.data.revision };
    } };
}
