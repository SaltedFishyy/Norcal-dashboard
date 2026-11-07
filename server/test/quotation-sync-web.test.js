import test from 'node:test';
import assert from 'node:assert/strict';
import { createDataStatus } from '../../web/data-status.js';
import { createQuotationSyncStatus, quotationSyncResults } from '../../web/quotation-sync-status.js';
import { formatUpdated } from '../../web/format.js';

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.text = ''; }
  set textContent(value) { this.text = value; this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.text = ''; this.children = children; }
  setAttribute() {}
  addEventListener() {}
}
test('Worker page shows all quotation results, refreshes and disposes; readonly never fetches or shows row', async () => {
  const iso = '2026-11-06T12:00:00Z';
  for (const enabled of [false, true]) {
    const root = new Element('section'), calls = [], timers = new Map(); let id = 0, result = null, fail = false;
    const doc = { getElementById: key => key === 'data-status' ? root : null, createElement: tag => new Element(tag) };
    const page = createDataStatus({ document: doc, setTimeout: fn => { timers.set(++id, fn); return id; }, clearTimeout: key => timers.delete(key),
      fetch: async url => {
        calls.push(url);
        if (url === '/api/quotation-sync/status' && fail) throw new Error('SECRET-SENTINEL');
        const body = url === '/api/capabilities' ? { quotation_sync: enabled }
          : url === '/api/districts' ? { districts: [] } : url === '/api/freshness' ? {}
            : { enabled: !!result, interval_minutes: 5, status: result ? { last_success: { finished_at: iso },
              last_attempt: { result, rejected_count: 3 } } : null };
        return { ok: true, json: async () => body };
      } });
    await page.start();
    if (!enabled) {
      assert.doesNotMatch(root.textContent, /报价同步/); assert.ok(!calls.includes('/api/quotation-sync/status'));
    } else {
      assert.match(root.textContent, /报价同步 · 定时：关闭 · 最近成功：— · 最近一次：—/);
      const tick = async () => { const [key, fn] = timers.entries().next().value; timers.delete(key); await fn(); };
      const expected = { partial_failure: '\u90e8\u5206\u5de5\u4f5c\u8868\u5931\u8d25', failed: '\u5168\u90e8\u5931\u8d25', completed: '完成', partial: '部分完成', rejected: '全部拒绝', unchanged: '无变化', fetch_failed: '读取失败',
        header_invalid: '表头无效', aborted_mass_removal: '删除过多已中止', write_role_missing: '未配置写入账号', config_invalid: '配置无效', db_failed: '数据库错误' };
      assert.deepEqual(quotationSyncResults, expected);
      for (const [code, label] of Object.entries(expected)) {
        result = code; await tick();
        assert.ok(root.textContent.includes(`最近一次：${label}`));
        assert.ok(root.textContent.includes(formatUpdated(iso)));
        assert.match(root.textContent, /每 5 分钟/); assert.match(root.textContent, /拒绝行数：3/);
      }
      fail = true; await tick(); assert.match(root.textContent, /报价同步 · 状态获取失败/);
      assert.doesNotMatch(root.textContent, /SENTINEL/);
    }
    page.dispose(); assert.equal(timers.size, 0);
  }
});

test('multi sheet status displays totals, three failed names and remaining count', async () => {
  const root = new Element('section');
  const page = createQuotationSyncStatus({ root, document: { createElement: tag => new Element(tag) }, get: async () => ({
    enabled: true, interval_minutes: 60, status: { last_attempt: { result: 'partial_failure', rejected_count: 4,
      sheets: [{ result: 'completed', title: 'OK' }, ...['A', 'B', 'C', 'D'].map(title => ({ title, result: 'header_invalid' }))] } }
  }) });
  await page.start({ quotation_sync: true });
  assert.match(root.textContent, /\u5de5\u4f5c\u8868\uff1a1\/5/);
  assert.match(root.textContent, /A.*B.*C.*\u7b49 1 \u4e2a/);
  assert.doesNotMatch(root.textContent, /D/);
});
