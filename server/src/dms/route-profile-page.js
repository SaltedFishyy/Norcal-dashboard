export class NeedsLoginError extends Error { constructor() { super('请重新运行 dms:login'); this.name = 'NeedsLoginError'; } }
export class SelectorError extends Error { constructor(step) { super(`页面控件不可用：${step}`); this.name = 'SelectorError'; } }
export class LoadLimitError extends Error { constructor() { super('路区画像请求数超过上限'); this.name = 'LoadLimitError'; } }
export class CircuitBreakerError extends Error { constructor() { super('接口返回限流或服务错误'); this.name = 'CircuitBreakerError'; } }
export class CaptureError extends Error { constructor() { super('页面捕获失败'); this.name = 'CaptureError'; } }

const listPath = '/dlvs-dataApi/roadAreaPortrait/home/frontPage/queryList/pagination';
const pathname = (url) => new URL(url).pathname;

export async function captureRoutePortrait({ browserType, statePath, baseUrl, station, pageSize = 100,
  maxListRequests = 3, headless = false, log = () => {} }) {
  let browser, page, failure, requestCount = 0, listRequestCount = 0;
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
    return Promise.race([stopped, Promise.resolve().then(action)]);
  };
  const control = async (step, action) => {
    log(`阶段：${step}`);
    try { return await guarded(action); }
    catch { throw failure || new SelectorError(step); }
  };
  const onRequest = (request) => {
    const route = pathname(request.url());
    requestCount++;
    if (route.includes('/roadAreaPortrait/')) {
      listRequestCount++;
      log(`阶段：request；pathname：${route}；计数：${listRequestCount}`);
      if (listRequestCount > maxListRequests) stop(new LoadLimitError());
    }
  };
  const onResponse = (response) => {
    const route = pathname(response.url());
    if (route.includes('/prod-api/') && (response.status() === 429 || response.status() >= 500 && response.status() <= 599)) {
      stop(new CircuitBreakerError());
    }
  };
  try {
    if (station !== 'SFO01' || !Number.isSafeInteger(maxListRequests) || maxListRequests < 1) throw new CaptureError();
    if (!browserType) ({ chromium: browserType } = await import('playwright'));
    browser = await browserType.launch({ headless });
    const context = await browser.newContext({ storageState: statePath });
    page = await context.newPage();
    page.on('request', onRequest);
    page.on('response', onResponse);
    log('阶段：open');
    await guarded(() => page.goto(baseUrl, { waitUntil: 'networkidle' }));
    if (!pathname(page.url()).includes('/areaDepiction') || await guarded(() => page.locator('input[type=password]').count()) > 0) {
      throw new NeedsLoginError();
    }
    await control('展开', () => page.getByText('展开', { exact: true }).first().click());
    await control('转运站点', async () => {
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
          return Array.isArray(body?.transitStationCodeList) && body.pageSize === pageSize;
        } catch { return false; }
      }),
      page.getByRole('button', { name: /查\s*询/ }).click(),
    ]));
    const body = await guarded(() => response.json());
    if (failure) throw failure;
    return { body, requestCount, listRequestCount };
  } catch (error) {
    if (failure) throw failure;
    if ([NeedsLoginError, SelectorError, LoadLimitError, CircuitBreakerError, CaptureError].some((type) => error instanceof type)) throw error;
    throw new CaptureError();
  } finally {
    if (page) { page.off('request', onRequest); page.off('response', onResponse); }
    if (browser) await browser.close().catch(() => {});
  }
}
