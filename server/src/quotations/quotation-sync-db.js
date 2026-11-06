import { readActiveRouteProfiles } from '../db/active-route-profiles.js';
import { quotationBands } from './lark-sheet-parse.js';
import { planQuotationSync } from './quotation-sync-plan.js';

export async function readActiveRoutes(client) {
  return (await readActiveRouteProfiles(client)).map(row => ({ route_id: Number(row.route_id),
    route_name: row.route_name, station_code: row.station_code, postal_codes: row.profile.postal_codes ?? [] }));
}

export async function readScopeLines(client, sourceRef) {
  const lines = await client.query(`SELECT l.*, l.id AS line_id,
    l.effective_from::text AS effective_from, l.end_date::text AS end_date
    FROM route_quotation_lines l JOIN route_quotation_imports i ON i.id=l.import_id
    WHERE i.source='lark_sheet' AND i.source_ref=$1 AND l.voided_at IS NULL ORDER BY l.id`, [sourceRef]);
  const prices = await client.query(`SELECT p.* FROM route_quotation_prices p
    JOIN route_quotation_lines l ON l.id=p.line_id JOIN route_quotation_imports i ON i.id=l.import_id
    WHERE i.source='lark_sheet' AND i.source_ref=$1 AND l.voided_at IS NULL`, [sourceRef]);
  const byLine = new Map(lines.rows.map(row => [String(row.line_id), {
    ...row, route_id: Number(row.route_id), first: {}, additional: {} }]));
  for (const price of prices.rows) byLine.get(String(price.line_id))[price.parcel_type][price.weight_band] = Number(price.price);
  return [...byLine.values()];
}

export async function readOtherSourceKeys(client, sourceRef) {
  return (await client.query(`SELECT l.route_id,l.postal_code,l.effective_from::text AS effective_from
    FROM route_quotation_lines l JOIN route_quotation_imports i ON i.id=l.import_id
    WHERE (i.source <> 'lark_sheet' OR i.source_ref IS DISTINCT FROM $1) AND l.voided_at IS NULL`,
  [sourceRef])).rows.map(row => ({ ...row, route_id: Number(row.route_id) }));
}

export async function applyQuotationSync({ client, sourceRef, parsed, maxRemovalRatio = 0.2,
  importedBy = 'lark-sync', dryRun = false }) {
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['nc:quotation-sync:' + sourceRef]);
    const activeRoutes = await readActiveRoutes(client);
    const scopeLines = await readScopeLines(client, sourceRef);
    const otherSourceKeys = await readOtherSourceKeys(client, sourceRef);
    const plan = planQuotationSync({ parsed, activeRoutes, scopeLines, otherSourceKeys, maxRemovalRatio });
    const { result, counts } = plan;
    if (dryRun || ['rejected', 'aborted_mass_removal', 'unchanged'].includes(result)) {
      await client.query('ROLLBACK');
      return { result, plan, importId: null };
    }
    const importId = (await client.query(`INSERT INTO route_quotation_imports
      (source,source_ref,status,row_count,accepted_count,duplicate_count,rejected_count,errors,warnings,imported_by)
      VALUES ('lark_sheet',$1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [sourceRef, result, counts.dataRows, counts.inserted + counts.replaced, counts.unchanged,
      counts.rejected, JSON.stringify(plan.rejected), JSON.stringify(plan.warnings), importedBy])).rows[0].id;
    // All voids precede inserts so the active key/day unique index permits replacements.
    for (const row of [...plan.replacements.map(row => ({ line_id: row.voidLineId, voidReason: row.voidReason })), ...plan.removals]) {
      const updated = await client.query(`UPDATE route_quotation_lines SET voided_at=now(),void_reason=$2
        WHERE id=$1 AND voided_at IS NULL`, [row.line_id, row.voidReason]);
      if (updated.rowCount !== 1) throw new Error('quotation_sync_concurrent_modification');
    }
    for (const row of [...plan.inserts, ...plan.replacements.map(row => row.insert)]) {
      const lineId = (await client.query(`INSERT INTO route_quotation_lines
        (import_id,source_row,station_code,route_id,route_name,postal_code,station_label_raw,fleet_name,
         reference_postal_code,effective_from,end_date,remarks,second_parcel_half_price_raw)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [importId, row.sheetRow, row.station_code, row.route_id, row.route_name, row.postal_code,
        row.station_label_raw, row.fleet_name, row.reference_postal_code, row.effective_from,
        row.end_date, row.remarks, row.second_parcel_half_price_raw])).rows[0].id;
      for (const type of ['first', 'additional']) for (const band of quotationBands)
        await client.query(`INSERT INTO route_quotation_prices (line_id,weight_band,parcel_type,price)
          VALUES ($1,$2,$3,$4)`, [lineId, band, type, row[type][band]]);
    }
    await client.query('COMMIT');
    return { result, plan, importId };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    // Driver messages/details can contain prices or connection information.
    const sanitized = new Error(error.message === 'quotation_sync_concurrent_modification'
      ? 'quotation_sync_concurrent_modification' : 'quotation_sync_failed');
    if (typeof error.code === 'string' && /^[A-Z0-9]{5}$/.test(error.code)) sanitized.code = error.code;
    throw sanitized;
  }
}
