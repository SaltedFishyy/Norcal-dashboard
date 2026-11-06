export const quotationBands = ['0_1', '1_5', '5_10', '10_20', '20_30', '30_40', '40_plus'];
const text = value => value == null ? null : String(value).trim() || null;
const normalize = value => (text(value) ?? '').replace(/\s/g, '').toLowerCase().replaceAll('(ib)', '(lb)');
const priceCodes = ['first', 'additional'].flatMap(type => quotationBands.map(band => `${type}.${band}`));
const required = ['route', 'postal_code', ...priceCodes, 'effective_from', 'end_date'];

function columnCode(value) {
  const label = normalize(value);
  if (!label) return null;
  const type = /续票|second/.test(label) ? 'additional' : /首票|first/.test(label) ? 'first' : null;
  if (type) {
    for (const band of quotationBands.slice(0, -1)) {
      if (new RegExp(`(^|[^0-9])${band.replace('_', '-')}(?![0-9])`).test(label)) return `${type}.${band}`;
    }
    if (/(^|[^0-9-])40\(lb\)以上|above40(?!\d)/.test(label)) return `${type}.40_plus`;
  }
  if (label.includes('参考邮编')) return 'reference_postal_code';
  if (label.includes('按重量段')) return null;
  if (/线路名称|route/.test(label)) return 'route';
  if (/^邮编|zipcode/.test(label)) return 'postal_code';
  for (const [pattern, code] of [['站点名称', 'station_label'], ['转运中心', 'fleet'],
    ['生效日期', 'effective_from'], ['结束日期', 'end_date'], ['第二票半价', 'half_price']]) {
    if (label.includes(pattern)) return code;
  }
  return /备注|remarks/.test(label) ? 'remarks' : null;
}

function date(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
  if (!match) return null;
  const [, month, day, year] = match.map(Number);
  const check = new Date(0);
  check.setUTCFullYear(year, month - 1, day);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function price(value) {
  if (text(value) === null) return { reason: 'price_missing' };
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value.trim())))
    return { reason: 'price_invalid' };
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return { reason: 'price_invalid' };
  if (number === 0) return { reason: 'price_zero' };
  const rounded = Math.round(number * 100) / 100;
  if (Math.abs(number - rounded) > 1e-6) return { reason: 'price_precision' };
  return { value: rounded };
}

export function parseQuotationSheet(cells, { headerScanRows = 5 } = {}) {
  const columns = new Map();
  let headerRowIndex = -1;
  // Stop at the price header so data within the scan window cannot become headers.
  for (let row = 0; row < Math.min(cells.length, headerScanRows); row++) {
    let hasPrices = false;
    (cells[row] ?? []).forEach((value, index) => {
      const code = columnCode(value);
      if (!code) return;
      if (!columns.has(code)) columns.set(code, new Set());
      columns.get(code).add(index);
      if (priceCodes.includes(code)) hasPrices = true;
    });
    if (hasPrices) { headerRowIndex = row; break; }
  }
  const detail = required.filter(code => columns.get(code)?.size !== 1);
  if (detail.length || headerRowIndex < 0) return { ok: false, error: 'header_invalid', detail };
  const rows = [], rejected = [], warnings = [];
  let blankRowCount = 0, dataRowCount = 0;
  for (let index = headerRowIndex + 1; index < cells.length; index++) {
    const raw = cells[index] ?? [];
    const get = code => raw[[...(columns.get(code) ?? [])][0]];
    if (required.every(code => text(get(code)) === null)) { blankRowCount++; continue; }
    dataRowCount++;
    const identity = { sheetRow: index + 1, routeName: text(get('route')), postalCode: text(get('postal_code')) };
    let reason = !identity.routeName ? 'route_missing' : !/^\d{5}$/.test(identity.postalCode ?? '') ? 'postal_code_invalid' : null;
    const prices = { first: {}, additional: {} };
    if (!reason) for (const code of priceCodes) {
      const parsed = price(get(code));
      if (parsed.reason) { reason = parsed.reason; break; }
      const [type, band] = code.split('.');
      prices[type][band] = parsed.value;
    }
    const effectiveFrom = date(get('effective_from'));
    const endDate = text(get('end_date')) === null ? null : date(get('end_date'));
    if (!reason && (!effectiveFrom || (text(get('end_date')) !== null && !endDate))) reason = 'date_invalid';
    if (!reason && endDate && endDate < effectiveFrom) reason = 'end_before_effective';
    if (reason) { rejected.push({ ...identity, reason }); continue; }
    const secondParcelHalfPriceRaw = text(get('half_price'));
    if (secondParcelHalfPriceRaw && !['是', '否'].includes(secondParcelHalfPriceRaw))
      warnings.push({ ...identity, code: 'half_price_flag_unexpected' });
    rows.push({ ...identity, stationLabelRaw: text(get('station_label')), fleetName: text(get('fleet')),
      referencePostalCode: text(get('reference_postal_code')), effectiveFrom, endDate, ...prices,
      secondParcelHalfPriceRaw, remarks: text(get('remarks')) });
  }
  return { ok: true, headerRowIndex, dataStartRow: headerRowIndex + 2, rows, rejected, warnings, blankRowCount, dataRowCount };
}
