export class NeedsLoginError extends Error { constructor() { super('请重新运行 dms:login'); this.name = 'NeedsLoginError'; } }
export class SelectorError extends Error { constructor(step, options) { super(`页面控件不可用：${step}`, options); this.name = 'SelectorError'; } }
export class LoadLimitError extends Error { constructor() { super('路区画像请求数超过上限'); this.name = 'LoadLimitError'; } }
export class CircuitBreakerError extends Error { constructor() { super('接口返回限流或服务错误'); this.name = 'CircuitBreakerError'; } }
export class CaptureError extends Error { constructor() { super('页面捕获失败'); this.name = 'CaptureError'; } }
export class InterruptedError extends Error { constructor() { super('SIGINT'); this.name = 'InterruptedError'; } }

const listPath = '/dlvs-dataApi/roadAreaPortrait/home/frontPage/queryList/pagination';
const pathname = (url) => new URL(url).pathname;

export async function withPortraitPage({ browserType, statePath, baseUrl, station, pageSize = 100,
  maxListRequests = 3, headless = false, log = () => {},
  listRequestPath = '/roadAreaPortrait/', needsLoginOn401 = false, maxDetailRequests, validate = () => {},
  maxBatchDetailRequests, maxProdApiRequests, signal, onCounts = () => {}, batch = false,
  onPageFailure, pageFailureTimeout = 5000, globalStationMode = false }, capture) {
  let browser, page, failure, requestCount = 0, listRequestCount = 0, detailRequestCount = 0;
  let prodApiRequestCount = 0, routeDetailRequestCount = 0, maxRouteDetailRequestCount = 0;
  let loginChecksActive = false, listLoaded = false;
  let stationBudget, batchBudget = 0;
  const counts = () => ({ requestCount, listRequestCount, detailRequestCount,
    prodApiRequestCount, routeDetailRequestCount, maxRouteDetailRequestCount });
  let rejectStop;
  const stopped = new Promise((_, reject) => { rejectStop = reject; });
  // Observe rejection even when an event fires between awaited operations.
  stopped.catch(() => {});
  const stop = (error) => {
    if (failure) return;
    failure = error;
    rejectStop(error);
    if (browser) void browser.close().catch(() => {});
  };
  const guarded = async (action) => {
    if (failure) throw failure;
    if (batch && loginChecksActive && (!pathname(page.url()).includes('/areaDepiction')
      || await Promise.race([stopped, page.locator('input[type=password]').count()]) > 0)) {
      stop(new NeedsLoginError());
      throw failure;
    }
    return Promise.race([stopped, Promise.resolve().then(() => {
      if (failure) throw failure;
      return action();
    })]);
  };
  const control = async (step, action) => {
    log(`阶段：${step}`);
    try { return await guarded(action); }
    catch (error) { throw failure || (error instanceof SelectorError ? error : new SelectorError(step, { cause: error })); }
  };
  const onRequest = (request) => {
    const route = pathname(request.url());
    requestCount++;
    if (route.includes('/prod-api/')) {
      prodApiRequestCount++;
      if (maxProdApiRequests !== undefined && prodApiRequestCount > maxProdApiRequests) stop(new LoadLimitError());
      if (stationBudget && (prodApiRequestCount - stationBudget.prodStart > stationBudget.cap
        || prodApiRequestCount > batchBudget)) stop(new LoadLimitError());
    }
    if (route.includes(listRequestPath)) {
      listRequestCount++;
      log(batch ? `阶段：列表请求；计数：${listRequestCount}` : `阶段：request；pathname：${route}；计数：${listRequestCount}`);
      if (stationBudget ? listRequestCount - stationBudget.listStart > stationBudget.listCap : listRequestCount > maxListRequests) stop(new LoadLimitError());
    }
    if (maxDetailRequests !== undefined && route.includes('/roadAreaPortraitDetails/')) {
      detailRequestCount++;
      routeDetailRequestCount++;
      maxRouteDetailRequestCount = Math.max(maxRouteDetailRequestCount, routeDetailRequestCount);
      log(batch ? `阶段：详情请求；计数：${routeDetailRequestCount}` : `阶段：detail request；pathname：${route}；计数：${detailRequestCount}`);
      if ((batch ? routeDetailRequestCount : detailRequestCount) > maxDetailRequests
        || maxBatchDetailRequests !== undefined && detailRequestCount > maxBatchDetailRequests) stop(new LoadLimitError());
    }
  };
  const onResponse = (response) => {
    const route = pathname(response.url());
    if (needsLoginOn401 && route.includes('/prod-api/') && response.status() === 401) stop(new NeedsLoginError());
    if (route.includes('/prod-api/') && (response.status() === 429 || response.status() >= 500 && response.status() <= 599)) {
      stop(new CircuitBreakerError());
    }
  };
  const onAbort = () => stop(new InterruptedError());
  const onNavigation = frame => {
    if (frame === page.mainFrame() && !pathname(frame.url()).includes('/areaDepiction')) stop(new NeedsLoginError());
  };
  try {
    if ((!globalStationMode && !/^[A-Z]{3}\d{2}$/.test(station || '')) || !Number.isSafeInteger(maxListRequests) || maxListRequests < 1) throw new CaptureError();
    validate();
    for (const limit of [maxBatchDetailRequests, maxProdApiRequests]) {
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new CaptureError();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) throw new InterruptedError();
    if (!browserType) ({ chromium: browserType } = await import('playwright'));
    browser = await browserType.launch({ headless });
    const context = await guarded(() => browser.newContext({ storageState: statePath }));
    page = await guarded(() => context.newPage());
    page.on('request', onRequest);
    page.on('response', onResponse);
    if (batch) page.on('framenavigated', onNavigation);
    log('阶段：open');
    await guarded(() => page.goto(baseUrl, { waitUntil: 'networkidle' }));
    loginChecksActive = true;
    if (!pathname(page.url()).includes('/areaDepiction') || await guarded(() => page.locator('input[type=password]').count()) > 0) {
      throw new NeedsLoginError();
    }
    if (batch) {
      // Observe login forms even while a detail response or the inter-route delay is pending.
      void page.locator('input[type=password]').first().waitFor({ state: 'attached', timeout: 0 })
        .then(() => stop(new NeedsLoginError())).catch(() => {});
    }
    const queryStation = async () => {
    if (globalStationMode) {
      await control('展开', async () => {
        const expand = page.getByText('展开', { exact: true });
        if (await guarded(() => expand.count()) > 1) throw new SelectorError('展开不唯一');
        if (await guarded(() => expand.count()) === 1) await guarded(() => expand.click({ timeout: 30000 }));
      });
    } else await control('展开', () => page.getByText('展开', { exact: true }).first().click());
    if (!globalStationMode) await control('转运站点', async () => {
      const items = page.locator('.dbuMicroSysApp-form-item');
      let target;
      for (let i = 0; i < await guarded(() => items.count()); i++) {
        const item = items.nth(i);
        if ((await guarded(() => item.locator('.dbuMicroSysApp-form-item-label').innerText())).trim() === '转运站点') {
          if (target) throw new SelectorError('转运站点');
          target = item;
        }
      }
      if (!target) throw new SelectorError('转运站点');
      await guarded(() => target.locator('.dbuMicroSysApp-select-selector').click());
      await guarded(() => page.locator('.dbuMicroSysApp-select-dropdown:visible').getByText(station, { exact: true }).click());
      await guarded(() => page.keyboard.press('Escape'));
    });
    await control('每页条数', async () => {
      await guarded(() => page.locator('.vxe-pager--sizes').click());
      await guarded(() => page.locator('.vxe-select-option:visible').filter({ hasText: new RegExp(`^${pageSize}条/页$`) }).click());
    });
    const [response] = await control('查询', () => Promise.all([
      page.waitForResponse((response) => {
        if (!pathname(response.url()).endsWith(listPath) || response.request().method() !== 'POST') return false;
        try {
          const body = response.request().postDataJSON();
          return (globalStationMode ? !Object.hasOwn(body || {}, 'transitStationCodeList') && body?.pageNum === 1 : Array.isArray(body?.transitStationCodeList)) && body.pageSize === pageSize;
        } catch { return false; }
      }),
      page.getByRole('button', { name: /查\s*询/ }).click(),
    ]));
    if (globalStationMode && response.status() !== 200) throw new CaptureError();
    const body = await guarded(() => response.json());
    if (failure) throw failure;
    listLoaded = true;
    let nextPage;
    if (batch) {
      const total = body?.data?.total;
      if (!Number.isSafeInteger(total) || total < 0) throw new CaptureError();
      const pages = Math.max(1, Math.ceil(total / pageSize));
      if (pages > 10) throw new LoadLimitError();
      // A next-page click sends one pagination request; retain the initial-load budget.
      if (stationBudget) stationBudget.listCap += pages - 1;
      else maxListRequests += pages - 1;
      const initialFilter = response.request().postDataJSON().transitStationCodeList;
      nextPage = previous => control('下一页', async () => {
        const visible = await guarded(() => page.locator('.dbuMicroSysApp-modal, .dbuMicroSysApp-modal-content, [role="dialog"]')
          .evaluateAll(elements => elements.some(element => element.getClientRects().length > 0
            && getComputedStyle(element).visibility !== 'hidden' && /路区画像详情|标签详情/.test(element.textContent))));
        if (visible) throw new SelectorError('画像弹窗未关闭');
        const buttons = page.locator('.vxe-pager .vxe-pager--next-btn:visible'), available = [];
        for (let i = 0; i < await guarded(() => buttons.count()); i++) {
          const button = buttons.nth(i);
          if (await guarded(() => button.isEnabled())
            && await guarded(() => button.getAttribute('aria-disabled')) !== 'true'
            && !/(^|\s)is--disabled(\s|$)/.test(await guarded(() => button.getAttribute('class')) || '')) available.push(button);
        }
        if (available.length !== 1) throw new SelectorError('下一页按钮不唯一或缺失');
        const [reply] = await guarded(() => Promise.all([
          page.waitForResponse(item => pathname(item.url()).endsWith(listPath) && item.request().method() === 'POST'),
          available[0].click(),
        ]));
        const query = reply.request().postDataJSON();
        if (globalStationMode && (reply.status() !== 200 || Object.hasOwn(query || {}, 'transitStationCodeList'))) throw new CaptureError();
        if (JSON.stringify(query?.transitStationCodeList) !== JSON.stringify(initialFilter)
          || query.pageSize !== pageSize || query.pageNum !== previous + 1) throw new CaptureError();
        const nextBody = await guarded(() => reply.json());
        if (nextBody?.data?.current !== previous + 1 || nextBody.data.size !== pageSize) throw new CaptureError();
        return nextBody;
      });
    }
    const initialFilter = response.request().postDataJSON().transitStationCodeList;
    const queryRouteName = (input, name, timeout) => control(name ? '按路区名称查询' : '恢复路区列表', async () => {
      const deadline = Date.now() + timeout;
      const remaining = () => {
        const value = deadline - Date.now();
        if (value <= 0) throw new SelectorError(name ? '按路区名称查询超时' : '恢复路区列表超时');
        return value;
      };
      await guarded(() => input.fill(name, { timeout: remaining() }));
      const [reply] = await guarded(() => Promise.all([
        page.waitForResponse(item => pathname(item.url()).endsWith(listPath) && item.request().method() === 'POST', { timeout: remaining() }),
        page.getByRole('button', { name: /查\s*询/ }).click({ timeout: remaining() }),
      ]));
      const query = reply.request().postDataJSON();
      if (globalStationMode && (reply.status() !== 200 || Object.hasOwn(query || {}, 'transitStationCodeList') || query.pageNum !== 1)) throw new CaptureError();
      if (JSON.stringify(query?.transitStationCodeList) !== JSON.stringify(initialFilter) || query.pageSize !== pageSize) throw new CaptureError();
      const value = await guarded(() => reply.json());
      if (!Array.isArray(value?.data?.records)) throw new CaptureError();
      return value;
    });
    return { page, body, guarded, control, counts,
      allowNameFilter: () => { if (stationBudget) stationBudget.listCap += 2; else maxListRequests += 2; }, queryRouteName,
      nextPage,
      beginRoute: () => { routeDetailRequestCount = 0; } };
    };
    const beginStation = base => {
      if (!Number.isSafeInteger(base) || base < 1) throw new CaptureError();
      stationBudget = { cap: base, finalized: false, prodStart: prodApiRequestCount, listStart: listRequestCount, listCap: maxListRequests + 1 };
      batchBudget += base;
    };
    const setStationCap = cap => {
      if (!stationBudget || stationBudget.finalized || !Number.isSafeInteger(cap) || cap < stationBudget.cap) throw new CaptureError();
      batchBudget += cap - stationBudget.cap;
      stationBudget.cap = cap;
      stationBudget.finalized = true;
      if (prodApiRequestCount - stationBudget.prodStart > cap || prodApiRequestCount > batchBudget) throw new LoadLimitError();
    };
    const result = await capture(globalStationMode ? { page, guarded, control, counts, queryStation, beginStation, setStationCap,
      batchCap: () => Math.min(batchBudget, maxProdApiRequests ?? batchBudget) } : await queryStation());
    if (failure) throw failure;
    return result;
  } catch (error) {
    if (batch && listLoaded && onPageFailure) {
      let timer;
      try {
        await Promise.race([
          Promise.resolve().then(() => onPageFailure({ page, error: failure || error })),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error()), pageFailureTimeout); }),
        ]);
      } catch { /* Diagnostics must never replace the original failure. */ }
      finally { clearTimeout(timer); }
    }
    if (failure) throw failure;
    if (batch || [NeedsLoginError, SelectorError, LoadLimitError, CircuitBreakerError, CaptureError].some((type) => error instanceof type)) throw error;
    throw new CaptureError();
  } finally {
    if (page) { page.off('request', onRequest); page.off('response', onResponse); }
    if (page && batch) page.off('framenavigated', onNavigation);
    signal?.removeEventListener('abort', onAbort);
    if (browser) await browser.close().catch(() => {});
    onCounts(counts());
  }
}
