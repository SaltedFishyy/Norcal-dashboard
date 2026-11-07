import { formatPrice, formatUpdated, formatValue } from './format.js';

const text = {
  title: name => `${formatValue(name)} · 价格详情`, close: '关闭', loading: '加载中…',
  empty: '该线路暂无报价', missing: '该线路不在当前 DMS 数据中', unavailable: '报价数据暂不可用',
  network: '无法连接本地服务器 (server_unreachable)。', error: code => `无法加载价格详情 (${code})。`,
  zip: '适用 ZIP', fleet: 'Fleet', effective: '生效日期 Effective Date', end: '结束日期',
  permanent: '长期有效', remarks: '备注', weight: '重量段',
  first: '首票 / First Parcel', additional: '续票 / Additional', retry: '重试',
  unquoted: zips => `无当前报价的 ZIP：${zips.join(', ')}`,
  extra: zips => `报价中有、DMS 当前不在此线路的 ZIP：${zips.join(', ')}`,
  upcoming: item => `下次生效：${item.effective_from}（${item.postal_codes.length} 个 ZIP）`,
  updated: value => `报价更新于 ${formatUpdated(value)}`,
};
const codes = new Set(['invalid_route_id', 'internal_error', 'not_found', 'method_not_allowed']);
let sequence = 0, trigger, dialog, content, title, station;
const element = (tag, value, className) => {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  if (className) node.className = className;
  return node;
};
function initialize() {
  if (dialog?.ownerDocument === document) return;
  dialog = element('dialog'); dialog.id = 'price-detail';
  dialog.setAttribute('aria-labelledby', 'price-detail-title');
  title = element('h2'); title.id = 'price-detail-title';
  station = element('p', '', 'detail-note');
  content = element('div'); content.setAttribute('aria-live', 'polite');
  const heading = element('div', undefined, 'detail-heading'), close = element('button', text.close);
  close.type = 'button'; close.setAttribute('aria-label', '关闭价格详情');
  heading.append(title, close); dialog.append(heading, station, content); document.body.append(dialog);
  const dismiss = () => { sequence++; dialog.close(); };
  close.addEventListener('click', dismiss);
  dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dismiss();
  });
  dialog.addEventListener('close', () => { sequence++; trigger?.focus(); trigger = undefined; });
}
function render(data, highlightZip) {
  content.replaceChildren();
  let target;
  if (!data.groups.length) content.append(element('p', text.empty, 'detail-status'));
  for (const group of data.groups) {
    const section = element('section', undefined, 'price-group');
    if (highlightZip !== undefined && group.postal_codes.includes(highlightZip)) {
      section.className += ' price-group-highlight'; target ??= section;
    }
    const info = element('dl', undefined, 'metrics detail-metrics');
    for (const [label, value] of [
      [text.zip, group.postal_codes.join(', ')], [text.fleet, group.fleet_name],
      [text.effective, group.effective_from], [text.end, group.end_date ?? text.permanent],
      ...(group.remarks == null ? [] : [[text.remarks, group.remarks]]),
    ]) {
      const item = element('div'); item.append(element('dt', label), element('dd', formatValue(value))); info.append(item);
    }
    const scroll = element('div', undefined, 'price-table-scroll'); scroll.tabIndex = 0;
    scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', `${text.title(data.route_name)} · ${group.postal_codes.join(', ')}`);
    const table = element('table'), head = element('thead'), header = element('tr'), body = element('tbody');
    for (const label of [text.weight, text.first, text.additional]) {
      const th = element('th', label); th.setAttribute('scope', 'col'); header.append(th);
    }
    head.append(header);
    for (const band of data.weight_bands) {
      const tr = element('tr'), th = element('th', band.label_zh); th.setAttribute('scope', 'row');
      tr.append(th, element('td', formatPrice(group.first[band.code]), 'numeric'), element('td', formatPrice(group.additional[band.code]), 'numeric'));
      body.append(tr);
    }
    table.append(head, body); scroll.append(table); section.append(info, scroll); content.append(section);
  }
  for (const [values, label] of [[data.unquoted_postal_codes, text.unquoted], [data.extra_quoted_postal_codes, text.extra]]) {
    if (values?.length) content.append(element('p', label(values), 'detail-note'));
  }
  for (const item of data.upcoming || []) content.append(element('p', text.upcoming(item), 'detail-note'));
  if (data.updated_at) content.append(element('p', text.updated(data.updated_at), 'detail-note'));
  target?.scrollIntoView({ block: 'center' });
}

export async function openPriceDetail(row, source = document.activeElement, options = {}) {
  initialize(); trigger = source;
  const current = ++sequence;
  title.textContent = text.title(row.route_name); station.textContent = formatValue(row.station);
  content.replaceChildren(element('p', text.loading, 'detail-status'));
  content.setAttribute('aria-busy', 'true');
  if (!dialog.open) dialog.showModal();
  const error = message => {
    const retry = element('button', text.retry); retry.type = 'button';
    retry.addEventListener('click', () => openPriceDetail(row, source, options));
    content.replaceChildren(element('p', message, 'detail-status'), retry);
  };
  try {
    const response = await fetch(`/api/route-quotations?route_id=${encodeURIComponent(row.route_id)}`, { cache: 'no-store' });
    const data = await response.json();
    if (current !== sequence) return;
    if (response.status === 200 && Array.isArray(data?.groups) && Array.isArray(data?.weight_bands)) render(data, options.highlightZip);
    else if (response.status === 404) error(text.missing);
    else if (response.status === 503) error(text.unavailable);
    else error(text.error(codes.has(data?.error) ? data.error : 'internal_error'));
  } catch {
    if (current === sequence) error(text.network);
  } finally {
    if (current === sequence) content.setAttribute('aria-busy', 'false');
  }
}
