import { formatUpdated } from './format.js';

const notice = '数据来自 DMS 抓取，非实时';
const loginNotice = 'DMS 登录已过期，请在公用电脑打开终端执行 npm run dms:login，登录完成后重新刷新。';
const reasons = { not_in_dms_menu: 'DMS 中无此站点', no_permission: '无权限', disabled: '已停用' };
const states = { idle: '空闲', running: '更新中', completed: '已完成', stopped: '已停止' };
const runStates = { completed: '完成', stopped: '已停止', running: '进行中', abandoned: '已放弃' };
const triggers = { ui: '刷新按钮', cli: '命令行', json_import: 'JSON 导入' };

export function createDataStatus({ document: doc = globalThis.document, fetch: request = globalThis.fetch,
  setTimeout: later = globalThis.setTimeout, clearTimeout: cancel = globalThis.clearTimeout,
  reload = () => globalThis.location.reload() } = {}) {
  const root = doc.getElementById('data-status');
  const node = (tag, text, parent) => {
    const el = doc.createElement(tag);
    if (text !== undefined) el.textContent = String(text);
    parent?.append(el); return el;
  };
  const button = (text, parent, action) => {
    const el = node('button', text, parent); el.type = 'button';
    el.addEventListener('click', action); return el;
  };
  const time = (value, parent) => {
    const el = node('time', value ? formatUpdated(value) : '暂无数据', parent);
    if (value) el.title = value; return el;
  };
  const text = node('div', undefined, root), actions = node('div', undefined, root);
  actions.className = 'data-status-actions';
  const runMessage = node('p', undefined, root), brief = node('p', undefined, root);
  const login = node('p', undefined, root), error = node('p', undefined, root);
  const conflict = node('p', undefined, root);
  const updated = node('div', undefined, root);
  for (const el of [runMessage, brief, login, error]) el.setAttribute('role', 'status');
  let districts = [], freshness, refreshButton, progressButton, statusData, pollTimer, freshTimer, disposed = false;
  let polling = false, statusBusy = false, freshBusy = false, completedKey, previewSequence = 0;
  const districtName = id => districts.find(d => d.id === id)?.name_zh || id || '—';
  const scopeName = scope => scope?.type === 'district' ? districtName(scope.district) : '全部';
  const get = async url => {
    const response = await request(url);
    if (!response.ok) throw new Error('request_failed');
    return response.json();
  };
  function dialog(title) {
    const el = node('dialog', undefined, root); el.className = 'data-dialog';
    const heading = node('div', undefined, el); heading.className = 'detail-heading';
    const h = node('h2', title, heading); h.id = `data-${title === '更新记录' ? 'runs' : 'refresh'}-title`;
    el.setAttribute('aria-labelledby', h.id);
    button('关闭', heading, () => el.close());
    const content = node('div', undefined, el); content.setAttribute('aria-live', 'polite');
    let opener;
    el.addEventListener('close', () => { previewSequence++; (opener?.disabled ? progressButton : opener)?.focus(); });
    return { el, content, open(from) { opener = from; if (!el.open) el.showModal(); } };
  }
  const history = dialog('更新记录'), refresh = dialog('刷新数据');
  function renderFreshness() {
    text.replaceChildren();
    node('span', freshness?.notice || notice, text);
    node('span', ' · Last Updated：', text); time(freshness?.global?.newest_fetched_at, text);
    const details = node('details', undefined, text); node('summary', '数据时间明细', details);
    for (const d of freshness?.districts ?? []) {
      const group = node('details', undefined, details);
      const summary = node('summary', `${districtName(d.id)} · 有数据 / 总数：${d.stations_with_data} / ${d.station_count} · 最新：`, group);
      time(d.newest_fetched_at, summary); node('span', ' · 最旧：', summary); time(d.oldest_fetched_at, summary);
      const list = node('ul', undefined, group);
      for (const s of freshness.stations.filter(s => s.district === d.id)) {
        const li = node('li', `${s.code}：`, list); time(s.fetched_at, li);
        if (s.scrape_disabled) node('span', ` · ${reasons[s.scrape_disabled] || s.scrape_disabled}`, li);
      }
    }
    const run = freshness?.source === 'json' ? null : freshness?.run;
    runMessage.textContent = run?.running ? '公用电脑正在更新数据，当前显示的是上次成功的数据'
      : ['stopped', 'abandoned'].includes(run?.last?.status)
        ? `最近一次更新失败（${formatUpdated(run.last.finished_at || run.last.started_at)}），当前显示的是上一次成功的数据` : '';
    renderLogin();
  }
  function renderLogin() {
    login.textContent = statusData?.needs_login || (freshness?.source !== 'json' && freshness?.run?.last?.needs_login) ? loginNotice : '';
  }
  async function loadFreshness() {
    if (freshBusy || disposed) return;
    freshBusy = true;
    try { freshness = await get('/api/freshness'); renderFreshness(); error.textContent = ''; }
    catch { error.textContent = '状态获取失败'; }
    finally { freshBusy = false; }
  }
  const historyButton = button('更新记录', actions, async () => {
    history.open(historyButton); history.content.replaceChildren(); node('p', '加载中…', history.content);
    try {
      const data = await get('/api/runs?limit=20'); history.content.replaceChildren();
      if (!data.runs.length) node('p', data.source === 'json' ? '暂无记录（当前为 JSON 后备模式）' : '暂无记录', history.content);
      for (const run of data.runs) {
        const item = node('section', undefined, history.content); item.className = 'data-run';
        node('p', `状态：${runStates[run.status] || run.status} · 来源：${triggers[run.trigger] || run.trigger} · 范围：${scopeName(run.scope)}`, item);
        node('span', '开始：', item); time(run.started_at, item); node('span', ' · 结束：', item); time(run.finished_at, item);
        node('p', `Station 完成 / 跳过 / 停止：${run.counts?.completed ?? 0} / ${run.counts?.skipped ?? 0} / ${run.counts?.stopped ?? 0} · 请求数：${run.prod_api_requests ?? '—'}`, item);
        node('p', `最后错误：${run.stop_reason || '—'}`, item);
      }
    } catch { history.content.replaceChildren(); node('p', '更新记录获取失败', history.content); }
  });
  function chooseScope() {
    previewSequence++; refresh.content.replaceChildren();
    const label = node('label', '选择范围 ', refresh.content), select = node('select', undefined, label);
    const all = node('option', '刷新全部', select); all.value = 'all'; select.value = 'all';
    for (const d of districts.filter(d => d.id !== 'unassigned')) {
      const option = node('option', d.name_zh, select); option.value = `district:${d.id}`;
    }
    const message = node('p', undefined, refresh.content);
    const next = button('下一步', refresh.content, async () => {
      next.disabled = true; const sequence = ++previewSequence;
      try {
        const scope = select.value, plan = await get(`/api/refresh/preview?scope=${encodeURIComponent(scope)}`);
        if (sequence === previewSequence && !disposed) confirmScope(scope, plan);
      } catch { if (sequence === previewSequence) message.textContent = '刷新范围获取失败'; }
      finally { next.disabled = false; }
    });
  }
  function confirmScope(scope, plan) {
    refresh.content.replaceChildren(); node('p', `本次范围：${scopeName(plan.scope)}`, refresh.content);
    for (const id of new Set(plan.stations.map(s => s.district))) {
      const stations = plan.stations.filter(s => s.district === id);
      node('p', `${districtName(id)} · 要处理的 Station（${stations.length}）：${stations.map(s => s.code).join('、')}`, refresh.content);
    }
    node('p', `要跳过的 Station（${plan.skipped.length}）`, refresh.content);
    for (const s of plan.skipped) node('p', `${districtName(s.district)} · ${s.code}：${reasons[s.reason] || s.reason}`, refresh.content);
    node('p', '正式刷新统一走 dms:scrape-stations，不要用旧的单 Station 命令。刷新期间请不要关闭公用电脑或弹出的浏览器窗口。', refresh.content);
    const message = node('p', undefined, refresh.content);
    let submitting = false;
    const start = button('确认开始', refresh.content, async () => {
      if (submitting) return;
      submitting = true; start.disabled = true; back.disabled = true;
      try {
        const response = await request('/api/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-NC-Refresh': '1' }, body: JSON.stringify({ scope }) });
        if (response.status === 202 || response.status === 409) {
          conflict.textContent = response.status === 409 ? '已有刷新进行中' : '';
          brief.textContent = '正在获取更新进度';
          polling = true; refresh.content.replaceChildren();
          node('p', brief.textContent, refresh.content);
          await loadStatus(); schedulePoll();
        } else message.textContent = response.status === 403 ? '无法开始刷新：请求未获授权。' : response.status === 400 ? '无法开始刷新：请求无效。' : '无法开始刷新，请检查本机服务。';
      } catch { message.textContent = '无法连接刷新服务'; }
      finally { submitting = false; start.disabled = false; back.disabled = false; }
    });
    const back = button('返回', refresh.content, chooseScope);
  }
  function renderProgress(data) {
    const p = data.progress || data.last_run || {};
    const station = `${p.station_index ?? '—'} / ${p.station_total ?? '—'}`;
    const route = `${p.route_index ?? '—'} / ${p.route_total ?? '—'}`;
    brief.textContent = `${states[data.state] || data.state} · ${districtName(p.district)} · ${p.station || '—'} · Station ${station} · Route ${route}`;
    refreshButton.disabled = data.state === 'running'; renderLogin();
    progressButton.hidden = data.state === 'idle';
    refresh.content.replaceChildren();
    if (conflict.textContent) node('p', conflict.textContent, refresh.content);
    node('p', brief.textContent, refresh.content);
    node('p', `当前阶段：${p.phase || '—'}`, refresh.content);
    node('span', '开始：', refresh.content); time(p.started_at, refresh.content);
    node('span', ' · 结束：', refresh.content); time(p.finished_at, refresh.content);
    const skipped = new Map([...(p.scope?.skipped || []), ...(freshness?.stations || []).filter(s => s.scrape_disabled).map(s => ({ code: s.code, reason: s.scrape_disabled }))].map(s => [s.code, s.reason]));
    for (const [key, name] of [['completed', '已完成'], ['skipped', '跳过'], ['failed', '失败']]) {
      const values = Array.isArray(p[key]) ? p[key] : [];
      node('p', `${name}的 Station：${values.map(s => {
        const code = typeof s === 'string' ? s : s.code;
        const reason = typeof s === 'object' ? s.reason : skipped.get(code);
        return key === 'skipped' && reason ? `${code}（${reasons[reason] || reason}）` : code;
      }).join('、') || '—'}`, refresh.content);
    }
    node('p', `最后错误：${p.stop_reason || '—'}`, refresh.content);
    if (data.needs_login) node('p', loginNotice, refresh.content);
  }
  function schedulePoll() {
    cancel(pollTimer);
    if (polling && !disposed) pollTimer = later(async () => { await loadStatus(); schedulePoll(); }, 2000);
  }
  async function loadStatus() {
    if (statusBusy || disposed) return;
    statusBusy = true;
    try {
      const data = await get('/api/refresh/status'); if (disposed) return;
      const wasRunning = statusData?.state === 'running', wasPolling = polling;
      statusData = data; renderProgress(data);
      if (data.state === 'running') { polling = true; if (!wasRunning) refresh.open(refreshButton); }
      else if (['completed', 'stopped'].includes(data.state)) {
        const key = `${data.progress?.run_id || data.last_run?.id || ''}:${data.progress?.finished_at || data.last_run?.finished_at || ''}:${data.state}`;
        polling = false; cancel(pollTimer);
        if (wasPolling && completedKey !== key) {
          completedKey = key; await loadFreshness();
          updated.replaceChildren(); button('数据已更新，点击重新加载', updated, reload);
        }
      } else { polling = false; cancel(pollTimer); }
    } catch { brief.textContent = '更新进度获取失败'; }
    finally { statusBusy = false; }
  }
  async function start() {
    renderFreshness();
    await Promise.all([
      loadFreshness(),
      (async () => { try { districts = (await get('/api/districts')).districts; renderFreshness(); } catch { districts = []; } })(),
    ]);
    try {
      if ((await get('/api/capabilities')).refresh === true) {
        refreshButton = button('刷新数据', actions, () => {
          chooseScope(); refresh.open(refreshButton);
        });
        progressButton = button('查看更新进度', actions, () => {
          if (statusData) renderProgress(statusData);
          refresh.open(progressButton);
        });
        progressButton.hidden = true;
        await loadStatus(); schedulePoll();
      }
    } catch { /* A failed capability check must never grant refresh controls. */ }
    const scheduleFresh = () => {
      if (!disposed) freshTimer = later(async () => { await loadFreshness(); scheduleFresh(); }, 60000);
    };
    scheduleFresh();
  }
  return { start, loadFreshness, loadStatus, dispose() { disposed = true; polling = false; cancel(pollTimer); cancel(freshTimer); } };
}

if (globalThis.document?.getElementById('data-status')) {
  const status = createDataStatus(); status.start();
  globalThis.addEventListener('pagehide', () => status.dispose(), { once: true });
}
