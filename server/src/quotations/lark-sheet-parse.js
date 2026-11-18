// Undated quotations use a stable baseline so dated quotations take precedence (LQ-D24/D25).
export const UNDATED_EFFECTIVE_FROM = '2000-01-01';
export const quotationBands = ['0_1', '1_5', '5_10', '10_20', '20_30', '30_40', '40_plus'];
const text = value => value == null ? null : (Array.isArray(value)
  ? value.map(segment => typeof segment?.text === 'string' ? segment.text : '').join('')
  : String(value)).trim() || null;
const normalize = value => (text(value) ?? '').replace(/\s/g, '').toLowerCase().replaceAll('(ib)', '(lb)');
const priceCodes = ['first', 'additional'].flatMap(type => quotationBands.map(band => `${type}.${band}`));
const required = ['route', 'postal_code', ...priceCodes, 'effective_from'];

function columnCode(value, grouped) {
  const label = normalize(value);
  if (!label) return null;
  const type = /续票|second/.test(label) ? 'additional' : /首票|first/.test(label) ? 'first' : grouped && /^(?:\d+-\d+\(lb\)|40\(lb\)\u4ee5\u4e0a)(?:\/.*)?$/.test(label) ? 'first' : null;
  if (type) {
    for (const band of quotationBands.slice(0, -1)) {
      if (new RegExp(`(^|[^0-9])${band.replace('_', '-')}(?![0-9])`).test(label)) return `${type}.${band}`;
    }
    if (/(^|[^0-9-])40\(lb\)以上|above40(?!\d)/.test(label)) return `${type}.40_plus`;
    const upperRange = /(^|[^0-9-])40-(\d+)\(lb\)/.exec(label);
    if (upperRange && Number(upperRange[2]) >= 1000) return `${type}.40_plus`;
  }
  if (label.includes('参考邮编')) return 'reference_postal_code';
  if (label.includes('按重量段')) return null;
  if (/线路名称|线路编号|格口对应|route/.test(label)) return 'route';
  if (label === '邮编' || label.includes('zipcode')) return 'postal_code';
  if (label.includes('报价生效日期')) return 'quotation_effective_from';
  for (const [pattern, code] of [['站点名称', 'station_label'], ['转运中心', 'fleet'],
    ['生效日期', 'effective_from'], ['生效时间', 'effective_from'], ['结束日期', 'end_date'], ['第二票半价', 'half_price']]) {
    if (label.includes(pattern)) return code;
  }
  return /备注|remarks/.test(label) ? 'remarks' : null;
}

function date(value) {
  if (Array.isArray(value)) value = text(value);
  if (typeof value === 'number') {
    const result = new Date(Date.UTC(1899, 11, 30) + Math.trunc(value) * 86400000);
    const year = result.getUTCFullYear();
    return year >= 2000 && year <= 2100 ? result.toISOString().slice(0, 10) : null;
  }
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})$/.exec(value.trim());
  const iso = /^(\d{4})([/-])(\d{1,2})\2(\d{1,2})$/.exec(value.trim());
  if (iso) return date(`${iso[3]}/${iso[4]}/${iso[1]}`);
  if (!match) return null;
  const month = Number(match[1]), day = Number(match[2]);
  const year = Number(match[3]) + (match[3].length === 2 ? 2000 : 0);
  const check = new Date(0);
  check.setUTCFullYear(year, month - 1, day);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function price(value) {
  if (Array.isArray(value)) value = text(value);
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
  const grouped = cells.slice(0, headerScanRows).some(row => row?.some(value => normalize(value).includes('\u6309\u91cd\u91cf\u6bb5') || normalize(value) === '价格'));
  let headerRowIndex = -1;
  // Stop at the price header so data within the scan window cannot become headers.
  for (let row = 0; row < Math.min(cells.length, headerScanRows); row++) {
    let hasPrices = false;
    (cells[row] ?? []).forEach((value, index) => {
      const code = columnCode(value, grouped);
      if (!code) return;
      if (!columns.has(code)) columns.set(code, new Set());
      columns.get(code).add(index);
      if (priceCodes.includes(code)) hasPrices = true;
    });
    if (hasPrices) { headerRowIndex = row; break; }
  }
  if (columns.has('quotation_effective_from')) columns.set('effective_from', columns.get('quotation_effective_from'));
  const additionalMissing = !priceCodes.filter(code => code.startsWith('additional.')).some(code => columns.has(code));
  const detail = required.filter(code => !(additionalMissing && code.startsWith('additional.')) && columns.get(code)?.size !== 1);
  if (columns.get('end_date')?.size > 1) detail.push('end_date');
  if (detail.length || headerRowIndex < 0) return { ok: false, error: 'header_invalid', detail };
  const rows = [], rejected = [], warnings = [];
  let blankRowCount = 0, dataRowCount = 0, undatedRowCount = 0;
  for (let index = headerRowIndex + 1; index < cells.length; index++) {
    const raw = cells[index] ?? [];
    const get = code => raw[[...(columns.get(code) ?? [])][0]];
    if ([...required, 'end_date'].every(code => text(get(code)) === null)) { blankRowCount++; continue; }
    dataRowCount++;
    const identity = { sheetRow: index + 1, routeName: text(get('route')), postalCode: text(get('postal_code')) };
    let reason = !identity.routeName ? 'route_missing' : !/^\d{5}$/.test(identity.postalCode ?? '') ? 'postal_code_invalid' : null;
    const prices = { first: {}, additional: {} };
    let skippedAdditionalPrecision = false;
    if (!reason) for (const code of priceCodes) {
      if (additionalMissing && code.startsWith('additional.')) continue;
      const parsed = price(get(code));
      const [type, band] = code.split('.');
      if (parsed.reason === 'price_precision' && type === 'additional') { skippedAdditionalPrecision = true; continue; }
      if (parsed.reason) { reason = parsed.reason; break; }
      prices[type][band] = parsed.value;
    }
    const emptyDate = value => text(value) === null || /^#+$/.test(text(value));
    const undatedEffective = emptyDate(get('effective_from'));
    const effectiveFrom = undatedEffective ? UNDATED_EFFECTIVE_FROM : date(get('effective_from'));
    const endDate = emptyDate(get('end_date')) ? null : date(get('end_date'));
    if (!reason && (!effectiveFrom || (!emptyDate(get('end_date')) && !endDate))) {
      const invalidDates = [[get('effective_from'), effectiveFrom], [get('end_date'), endDate]]
        .filter(([value, parsed]) => !emptyDate(value) && !parsed);
      reason = invalidDates.some(([value]) => typeof value === 'number') ? 'date_not_date_cell' : 'date_invalid';
    }
    if (!reason && endDate && endDate < effectiveFrom) reason = 'end_before_effective';
    if (reason) { rejected.push({ ...identity, reason }); continue; }
    if (undatedEffective) undatedRowCount++;
    if (skippedAdditionalPrecision) warnings.push({ ...identity, code: 'additional_price_precision_skipped' });
    const secondParcelHalfPriceRaw = text(get('half_price'));
    if (secondParcelHalfPriceRaw && !['是', '否'].includes(secondParcelHalfPriceRaw))
      warnings.push({ ...identity, code: 'half_price_flag_unexpected' });
    rows.push({ ...identity, stationLabelRaw: text(get('station_label')), fleetName: text(get('fleet')),
      referencePostalCode: text(get('reference_postal_code')), effectiveFrom, endDate, ...(undatedEffective ? { undatedEffective: true } : {}), ...prices,
      secondParcelHalfPriceRaw, remarks: text(get('remarks')) });
  }
  return { ok: true, notes: [...(columns.has('end_date') ? [] : ['end_date_column_missing']), ...(additionalMissing ? ['additional_columns_missing'] : [])], headerRowIndex, dataStartRow: headerRowIndex + 2, rows, rejected, warnings, blankRowCount, dataRowCount, undatedRowCount };
}
