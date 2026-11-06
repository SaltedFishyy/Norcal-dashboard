import { formatUpdated } from './format.js';

export const quotationSyncResults = {
  completed: '完成', partial: '部分完成', rejected: '全部拒绝', unchanged: '无变化',
  fetch_failed: '读取失败', header_invalid: '表头无效', aborted_mass_removal: '删除过多已中止',
  write_role_missing: '未配置写入账号', config_invalid: '配置无效', db_failed: '数据库错误',
};
export function createQuotationSyncStatus({ document: doc, root, get }) {
  let line, enabled = false, disposed = false, busy = false;
  async function load() {
    if (!enabled || disposed || busy) return;
    busy = true;
    try {
      const data = await get('/api/quotation-sync/status');
      if (disposed) return;
      const success = data.status?.last_success?.finished_at, attempt = data.status?.last_attempt;
      line.textContent = `报价同步 · 定时：${data.enabled ? `每 ${data.interval_minutes} 分钟` : '关闭'}`
        + ` · 最近成功：${success ? formatUpdated(success) : '—'}`
        + ` · 最近一次：${quotationSyncResults[attempt?.result] || '—'} · 拒绝行数：${attempt?.rejected_count ?? 0}`;
    } catch { if (!disposed) line.textContent = '报价同步 · 状态获取失败'; }
    finally { busy = false; }
  }
  return {
    async start(capabilities) {
      if (capabilities.quotation_sync !== true || disposed || enabled) return;
      enabled = true; line = doc.createElement('p'); line.setAttribute('role', 'status');
      root.append(line); line.textContent = '报价同步 · 加载中…'; await load();
    },
    load,
    dispose() { disposed = true; },
  };
}
