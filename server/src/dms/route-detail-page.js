import { NeedsLoginError, SelectorError, LoadLimitError, CircuitBreakerError, CaptureError } from './route-profile-page.js';

import { withPortraitPage, hasVisiblePortraitModal } from './portrait-page.js';
const pathname = (url) => new URL(url).pathname;

function inspectVisibleTableBody(elements, scroll) {
  const visible = elements.filter(element => element.getClientRects().length > 0);
  if (visible.length !== 1 || scroll === undefined) return { count: visible.length, moved: false };
  const element = visible[0], previous = element.scrollTop;
  element.scrollTop = scroll ? 0 : previous + Math.max(1, element.clientHeight * .8);
  return { count: 1, moved: scroll || element.scrollTop > previous };
}

const mainBodySelector = '.vxe-table--main-wrapper .vxe-table--body-wrapper';

async function locateL0({ page, guarded }) {
  for (let poll = 0; poll <= 50; poll++) {
    const ready = await guarded(() => page.locator(mainBodySelector).evaluateAll(elements => elements.some(body => {
      const table = body.closest('.vxe-table');
      return table && body.getClientRects().length > 0 && getComputedStyle(body).visibility !== 'hidden'
        && !table.classList.contains('is--loading') && body.querySelectorAll('tr[rowid]').length > 0;
    })));
    if (ready) return 'clicked';
    if (poll < 50) await guarded(() => page.waitForTimeout(200));
  }
  throw new SelectorError('表格未就绪');
}

async function inspectRouteRow({ page, guarded }, routeName, scroll = false) {
  const rows = await guarded(() => page.locator(`${mainBodySelector} tr[rowid]`).evaluateAll((elements, { name, scroll }) =>
    elements.filter(row => row.getClientRects().length > 0
      && [...row.querySelectorAll('td')].some(cell => cell.textContent.trim() === name)).map(row => {
      const wrapper = row.closest('.vxe-table--body-wrapper');
      const rect = row.getBoundingClientRect(), viewport = wrapper.getBoundingClientRect();
      const inView = rect.top >= viewport.top && rect.bottom <= viewport.bottom;
      if (scroll && !inView) wrapper.scrollTop = Math.max(0, wrapper.scrollTop + rect.top - viewport.top - 8);
      return { id: row.getAttribute('rowid'), inView };
    }), { name: routeName, scroll }));
  if (rows.length > 1) throw new SelectorError('Route 行不唯一');
  return rows[0];
}

async function inspectLocatedButton({ page, guarded }, routeName) {
  // Resolve again after every scroll: virtual rendering reassigns row IDs.
  const row = await inspectRouteRow({ page, guarded }, routeName);
  const selected = await guarded(() => page.locator('.vxe-table--fixed-right-wrapper .vxe-table--body-wrapper')
    .evaluateAll((elements, id) => {
      document.querySelectorAll('[data-rd1-row-action]').forEach(element => element.removeAttribute('data-rd1-row-action'));
      if (!id) return null;
      const visible = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
      const matches = elements.filter(visible).flatMap(wrapper => [...wrapper.querySelectorAll('tr[rowid]')]
        .filter(row => row.getAttribute('rowid') === id).map(row => ({ row, wrapper })));
      if (matches.length > 1) return 'duplicate-row';
      if (!matches.length) return null;
      const { row, wrapper } = matches[0];
      const links = [...row.querySelectorAll('*')].filter(element => visible(element) && element.textContent.trim() === '画像详情');
      const buttons = links.filter(element => !links.some(other => other !== element && element.contains(other)));
      if (buttons.length > 1) return false;
      if (!buttons.length) return null;
      const button = buttons[0], rect = button.getBoundingClientRect(), viewport = wrapper.getBoundingClientRect();
      const x = (rect.left + rect.right) / 2, y = (rect.top + rect.bottom) / 2;
      if (x < viewport.left || x >= viewport.right || y < viewport.top || y >= viewport.bottom
        || !button.contains(document.elementFromPoint(x, y))) return null;
      button.setAttribute('data-rd1-row-action', 'portrait');
      return { x, y };
    }, row?.id));
  if (selected === 'duplicate-row') throw new SelectorError('Route 行不唯一');
  if (selected === false) throw new SelectorError('画像详情按钮不唯一');
  return selected && row?.inView ? selected : null;
}

export function classifyClickWaitReason(message = '') {
  const patterns = [
    [/intercepts pointer events/i, 'intercepted'], [/not stable/i, 'not_stable'],
    [/not visible/i, 'not_visible'], [/not attached|detached/i, 'detached'],
    [/not enabled|disabled/i, 'not_enabled'],
    [/waiting for scheduled navigations/i, 'navigation_wait'],
    [/click action done|performing click action/i, 'click_dispatched'],
  ];
  let reason = 'unknown';
  for (const line of String(message).split(/\r?\n/)) {
    const match = patterns.find(([pattern]) => pattern.test(line));
    if (match) reason = match[1];
  }
  return reason;
}

async function clickLocatedRow(context, routeName) {
  const { page, guarded } = context;
  const first = await inspectLocatedButton(context, routeName);
  if (!first) return 'not_found';
  await guarded(() => page.waitForTimeout(150));
  const second = await inspectLocatedButton(context, routeName);
  if (!second || Math.abs(first.x - second.x) > 1 || Math.abs(first.y - second.y) > 1) return 'not_found';
  const before = context.counts().prodApiRequestCount;
  try { await guarded(() => page.locator('[data-rd1-row-action="portrait"]').click({ timeout: 3000 })); }
  catch (error) {
    error.portraitClickAttempted = true;
    error.click_wait_reason = classifyClickWaitReason(error.message);
    error.click_retry = context.location.click_retry ?? 0;
    context.location.click_wait_reason = error.click_wait_reason;
    context.location.click_retry = error.click_retry;
    error.prodApiBeforeClick = before;
    throw error;
  }
  return 'clicked';
}

async function locateL1(context, routeName, index, deadline) {
  for (let poll = 0; poll <= 25 && Date.now() <= deadline; poll++) {
    const row = await inspectRouteRow(context, routeName, true);
    if (!row) await context.guarded(() => context.page.locator(mainBodySelector).evaluateAll(inspectVisibleTableBody, poll === 0));
    if (await clickLocatedRow(context, routeName) === 'clicked') return 'clicked';
    if (poll < 25) await context.guarded(() => context.page.waitForTimeout(200));
  }
  return 'not_found';
}

async function locateL2(context, routeName, index, deadline) {
  for (let poll = 0; poll <= 25 && Date.now() <= deadline; poll++) {
    await context.guarded(() => context.page.locator(mainBodySelector).evaluateAll((elements, index) => {
      const body = elements.find(element => element.getClientRects().length > 0);
      const table = body?.closest('.vxe-table');
      const height = [...(body?.querySelectorAll('tr[rowid]') || [])]
        .map(row => row.getBoundingClientRect()).map(rect => rect.bottom - rect.top).find(height => height > 0);
      if (!table || !height || index < 0) return;
      const candidates = [table, ...table.querySelectorAll('*')].filter(element => element.getClientRects().length > 0
        && getComputedStyle(element).visibility !== 'hidden' && /^(auto|scroll)$/.test(getComputedStyle(element).overflowY)
        && element.scrollHeight > element.clientHeight);
      candidates.forEach(element => { element.scrollTop = index * height; });
    }, index));
    if (await clickLocatedRow(context, routeName) === 'clicked') return 'clicked';
    if (poll < 25) await context.guarded(() => context.page.waitForTimeout(200));
  }
  return 'not_found';
}

async function locateL3(context, routeName, index, deadline) {
  const geometry = await context.guarded(() => context.page.locator(mainBodySelector).evaluateAll(elements => {
    const body = elements.find(element => element.getClientRects().length > 0);
    const row = body?.querySelectorAll('tr[rowid]')[0];
    if (!body || !row) return null;
    const rect = body.getBoundingClientRect(), rowRect = row.getBoundingClientRect();
    return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2, height: rowRect.bottom - rowRect.top };
  }));
  if (!geometry || geometry.height <= 0 || index < 0) return 'not_found';
  await context.guarded(() => context.page.mouse.move(geometry.x, geometry.y));
  for (let step = 0; step < index + 2 && Date.now() < deadline; step++) {
    if (await clickLocatedRow(context, routeName) === 'clicked') return 'clicked';
    const direction = await context.guarded(() => context.page.locator(`${mainBodySelector} tr[rowid]`).evaluateAll((elements, name) => {
      const row = elements.find(row => [...row.querySelectorAll('td')].some(cell => cell.textContent.trim() === name));
      return row && row.getBoundingClientRect().top < row.closest('.vxe-table--body-wrapper').getBoundingClientRect().top ? -1 : 1;
    }, routeName));
    await context.guarded(() => context.page.mouse.wheel(0, direction * geometry.height));
    await context.guarded(() => context.page.waitForTimeout(150));
    if (await clickLocatedRow(context, routeName) === 'clicked') return 'clicked';
  }
  return 'not_found';
}

async function locateL5(context, routeName, routeId, deadline, state) {
  if (context.forbidNameFilter) {
    const error = new SelectorError('L5 不可用于第 2 页以后');
    error.noFallback = true;
    throw error;
  }
  const selected = await context.guarded(() => context.page.locator('.dbuMicroSysApp-form-item').evaluateAll(elements => {
    document.querySelectorAll('[data-rd1-name-filter]').forEach(element => element.removeAttribute('data-rd1-name-filter'));
    const visible = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
    const items = elements.filter(visible).filter(item => [...item.querySelectorAll('.dbuMicroSysApp-form-item-label')]
      .some(label => label.textContent.trim() === '路区名称'));
    if (!items.length) return null;
    if (items.length !== 1) return false;
    const inputs = [...items[0].querySelectorAll('input')].filter(visible);
    if (inputs.length !== 1) return false;
    inputs[0].setAttribute('data-rd1-name-filter', 'route');
    return true;
  }));
  if (selected !== true) { state.unavailable = selected === null; return 'not_found'; }
  if (Date.now() >= deadline) return 'not_found';
  const input = context.page.locator('[data-rd1-name-filter="route"]');
  context.allowNameFilter();
  const filtered = await context.queryRouteName(input, routeName, Math.max(1, deadline - Date.now()));
  const records = filtered?.data?.records;
  if (!Array.isArray(records) || records.length !== 1 || filtered.data.total !== 1 || records[0].roadAreaName !== routeName
    || Number(records[0].roadAreaId) !== routeId) throw new CaptureError();
  state.restoreList = () => context.queryRouteName(input, '', 10000);
  return locateL1(context, routeName, 0, Math.min(deadline, Date.now() + 5000));
}

async function locatePortraitRow(context, { routeName, routeId }) {
  const attempts = [], deadline = Date.now() + 30000;
  context.location = { ...context.location, locateMethod: null, attempts };
  try {
    await locateL0(context);
    const index = context.body.data.records.findIndex(row => row.roadAreaName === routeName);
    for (const [method, locate] of [['L1', locateL1], ['L2', locateL2], ['L3', locateL3], ['L5', locateL5]]) {
      const state = {};
      const until = Math.min(deadline, Date.now() + (method === 'L1' || method === 'L2' ? 5000 : 10000));
      let outcome;
      try {
        outcome = method === 'L5'
          ? await locate(context, routeName, routeId, until, state)
          : await locate(context, routeName, index, until);
      } catch (error) {
        if (state.restoreList) error.restoreList = state.restoreList;
        attempts.push(method);
        if (error.portraitClickAttempted) error.locateMethod = method;
        if (error.portraitClickAttempted || error.noFallback || !(error instanceof SelectorError || error.name === 'TimeoutError')
          || /画像详情按钮不唯一|Route 行不唯一/.test(error.message)) throw error;
        outcome = 'not_found';
        attempts.pop();
      }
      if (outcome === 'clicked') {
        context.location.locateMethod = method;
        return { ...context.location, restoreList: state.restoreList };
      }
      attempts.push(state.unavailable ? 'L5:unavailable' : method);
    }
    throw new SelectorError('画像详情定位失败');
  } catch (error) {
    error.attempts = attempts;
    throw error;
  }
}

async function clickPortraitRow(context, target) {
  context.location = {};
  let restoreList;
  for (let retry = 0; retry <= 1; retry++) {
    try {
      const result = await locatePortraitRow(context, target);
      return { ...result, restoreList: result.restoreList ?? restoreList };
    }
    catch (error) {
      restoreList = error.restoreList ?? restoreList;
      if (context.location.click_retry !== undefined) error.click_retry = context.location.click_retry;
      if (!error.portraitClickAttempted) throw error;
      // Observe through the same safety guard: circuit breakers and login failures still stop immediately.
      for (let poll = 0; poll <= 10; poll++) {
        if (context.counts().prodApiRequestCount !== error.prodApiBeforeClick
          || await hasVisiblePortraitModal(context)
          || context.counts().prodApiRequestCount !== error.prodApiBeforeClick) {
          // The click reached DMS. Wait for its modal without dispatching another click.
          for (let latePoll = 0; latePoll <= 150; latePoll++) {
            if (await hasVisiblePortraitModal(context)) {
              context.location.locateMethod = error.locateMethod;
              context.location.click_late = true;
              return { ...context.location, restoreList };
            }
            if (latePoll < 150) await context.guarded(() => context.page.waitForTimeout(200));
          }
          throw error;
        }
        if (poll < 10) await context.guarded(() => context.page.waitForTimeout(150));
      }
      if (retry === 1) throw error;
      context.location.click_retry = 1;
    }
  }
}

async function clickSectionDetail(page, guarded, section = '路区难易度', target = 'difficulty') {
  const modals = page.locator('.dbuMicroSysApp-modal, .dbuMicroSysApp-modal-content, [role="dialog"]');
  // The first modal may render after the row click resolves. Wait within a bounded window.
  for (let attempt = 0; attempt < 100; attempt++) {
    const selected = await guarded(() => modals.evaluateAll((elements, { section, target }) => {
      const visible = (element) => element.getClientRects().length > 0
        && getComputedStyle(element).visibility !== 'hidden';
      const text = (element) => element.textContent.trim();
      document.querySelectorAll('[data-rd1-target]').forEach((element) => element.removeAttribute('data-rd1-target'));
      const candidates = elements.filter((element) => visible(element) && text(element).includes('路区画像详情'));
      const innermost = candidates.filter((element) => !candidates.some((other) => other !== element && element.contains(other)));
      if (innermost.length === 0) return null;
      if (innermost.length !== 1) return false;
      const modal = innermost[0];
      const labels = [...modal.querySelectorAll('*')].filter((element) => !element.children.length && visible(element)
        && (section === '路区难易度' ? text(element) === section : text(element).startsWith(section)));
      if (labels.length === 0) return null;
      if (labels.length !== 1) return false;
      for (let parent = labels[0].parentElement; parent && modal.contains(parent); parent = parent.parentElement) {
        if (parent === modal) return null;
        // Other sections may already have links while this section is still loading.
        if (text(parent).includes('基础属性')) return null;
        // Only innermost text matches count; wrapper nodes can carry the same text as their link.
        const links = [...parent.querySelectorAll('*')].filter((element) => visible(element) && /^详情\s*>?$/.test(text(element)));
        const leaves = links.filter((element) => !links.some((other) => other !== element && element.contains(other)));
        if (!leaves.length) continue;
        if (leaves.length > 1) return false;
        leaves[0].setAttribute('data-rd1-target', target);
        return true;
      }
      return null;
    }, { section, target }));
    if (selected === false) throw new SelectorError(`${section}详情不唯一`);
    if (selected === true) {
      await guarded(() => page.locator(`[data-rd1-target="${target}"]`).click());
      return;
    }
    await guarded(() => page.waitForTimeout(200));
  }
  throw new SelectorError(section === '路区难易度' ? '路区画像详情未加载' : `${section}详情未加载`);
}

export async function captureRouteDetail({ browserType, statePath, baseUrl, station, routeName, pageSize = 100,
  maxListRequests = 3, maxDetailRequests = 30, headless = false, log = () => {} }) {
  return withPortraitPage({ browserType, statePath, baseUrl, station, pageSize,
    maxListRequests, maxDetailRequests, headless, log,
    listRequestPath: '/roadAreaPortrait/home/frontPage/', needsLoginOn401: true,
    validate: () => {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(routeName || '') || pageSize !== 100
        || !Number.isSafeInteger(maxDetailRequests) || maxDetailRequests < 1) throw new CaptureError();
    },
  }, async context => {
    const { page, body, guarded, control, counts } = context;
    if (!Array.isArray(body?.data?.records)) throw new CaptureError();
    const matches = body.data.records.filter((row) => row?.roadAreaName === routeName);
    if (matches.length !== 1) throw new CaptureError();
    const rawId = matches[0].roadAreaId;
    if (!(typeof rawId === 'number' || typeof rawId === 'string' && /^\d+$/.test(rawId))) throw new CaptureError();
    const routeId = Number(rawId);
    if (!Number.isSafeInteger(routeId) || routeId < 1 || matches[0].transitStationName !== station) throw new CaptureError();
    const result = await captureRouteDetailOnPage(context, { routeName, routeId });
    if (result.restoreList && !result.restorationError) {
      try {
        await closeRouteDetailModals(context);
        await guarded(result.restoreList);
      } catch (error) {
        if (!(error instanceof SelectorError)) throw error;
        result.restorationError = error;
      }
      result.listRequestCount = counts().listRequestCount;
    }
    return result;
  });
}

export async function captureRouteDetailOnPage(context, { routeName, routeId }) {
    const { page, body, guarded, control, counts } = context;
    const location = await control('画像详情', () => clickPortraitRow(context, { routeName, routeId })).catch(error => {
      for (const key of ['click_retry', 'click_wait_reason']) {
        if (context.location?.[key] !== undefined) error[key] = context.location[key];
      }
      throw error;
    });
    await confirmPortraitRoute(page, routeName, guarded);
    // Both listeners must be installed before the single difficulty-detail click.
    const detailResponse = (endpoint) => page.waitForResponse((item) =>
      pathname(item.url()).endsWith('/roadAreaPortraitDetails/details/' + endpoint)
      && item.request().method() === 'POST');
    const [contentResponse, headerResponse] = await control('路区难易度详情', () => Promise.all([
      detailResponse('getRoadAreaContent'), detailResponse('getRoadAreaHeader'),
      clickSectionDetail(page, guarded),
    ]));
    for (const item of [contentResponse, headerResponse]) {
      let id;
      try { id = item.request().postDataJSON()?.roadAreaId; } catch { throw new CaptureError(); }
      if (id !== routeId) throw new CaptureError();
    }
    const [contentBody, headerBody] = await guarded(() => Promise.all([contentResponse.json(), headerResponse.json()]));
    if (headerBody?.data?.roadAreaName !== routeName) throw new CaptureError();
    await closeDetailModal({ page, guarded, control }, '标签详情');
    // DMS remembers the selected tab and may request postal data on opening.
    const capacityResponseFor = endpoint => page.waitForResponse(item => {
      if (!pathname(item.url()).endsWith('/roadAreaPortraitDetails/details/businessPropertiesProductionCapacity/' + endpoint)
        || item.request().method() !== 'POST') return false;
      try { return item.request().postDataJSON()?.roadAreaId === routeId; } catch { return false; }
    }, { timeout: 30000 });
    const capacityHeaderPending = capacityResponseFor('header');
    const postalPending = capacityResponseFor('details/postalCodeDimension');
    capacityHeaderPending.catch(() => {});
    let postalOutcome;
    postalPending.then(response => { postalOutcome = { response }; }, error => { postalOutcome = { error }; });
    const [capacityHeaderResponse] = await control('业务属性-产能详情', () => Promise.all([
      capacityHeaderPending,
      clickSectionDetail(page, guarded, '业务属性-产能', 'capacity'),
    ]));
    await confirmPortraitRoute(page, routeName, guarded, '业务属性（产能）- 详情');
    const capacityHeaderBody = await validateResponse(capacityHeaderResponse);
    if (capacityHeaderBody?.data?.roadAreaName !== routeName) throw new CaptureError();
    const capacityResponse = await control('按邮编', async () => {
      const postalSelected = await inspectCapacityTabs(page, guarded);
      let switchToPostal = !postalSelected;
      if (postalSelected) {
        for (let poll = 0; !postalOutcome && poll < 25; poll++) await guarded(() => page.waitForTimeout(200));
        if (postalOutcome?.error) throw postalOutcome.error;
        if (!postalOutcome) {
          switchToPostal = true;
          await selectCapacityTab(page, guarded, false);
        }
      }
      if (switchToPostal) await selectCapacityTab(page, guarded, true);
      return postalPending;
    });
    const capacityBody = await validateResponse(capacityResponse);
    if (!Array.isArray(capacityBody?.data)) throw new CaptureError();
    async function validateResponse(response) {
      let id;
      try { id = response.request().postDataJSON()?.roadAreaId; } catch { throw new CaptureError(); }
      if (id !== routeId) throw new CaptureError();
      const value = await guarded(() => response.json());
      if (value?.data?.roadAreaName !== undefined && value.data.roadAreaName !== routeName) throw new CaptureError();
      return value;
    }
    // Reset before closing; any resulting requests belong to this Route's count.
    let restorationError;
    try { await control('按日期', () => selectCapacityTab(page, guarded, false)); }
    catch (error) {
      // Preserve validated data; callers stop after saving it. Safety failures still stop immediately.
      if (!(error instanceof SelectorError)) throw error;
      restorationError = error;
    }
    const { listRequestCount, detailRequestCount } = counts();
    return { routeId, listBody: body, contentBody, headerBody, capacityBody, listRequestCount, detailRequestCount, ...location,
      ...(restorationError ? { restorationError } : {}) };
}

export async function confirmPortraitRoute(page, routeName, guarded, title = '路区画像详情') {
  for (let attempt = 0; attempt < 100; attempt++) {
    const found = await guarded(() => page.locator('.dbuMicroSysApp-modal, .dbuMicroSysApp-modal-content, [role="dialog"]').evaluateAll((elements, { name, title }) => {
      const candidates = elements.filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden'
        && [...element.querySelectorAll('*')].some(heading => heading.textContent.trim() === title));
      const inner = candidates.filter(element => !candidates.some(other => other !== element && element.contains(other)));
      if (inner.length > 1) return false;
      if (!inner.length) return null;
      // Status tags may follow the name, but another route-name character must not.
      return [...inner[0].querySelectorAll('*')].some(element => {
        const text = element.textContent.trim();
        if (!text.startsWith('路区名称：')) return false;
        const value = text.slice('路区名称：'.length).trimStart();
        return value.startsWith(name) && (value.length === name.length || !/[A-Za-z0-9._-]/.test(value[name.length]));
      }) ? true : null;
    }, { name: routeName, title }));
    if (found === false) throw new SelectorError(`${title}不唯一`);
    if (found === true) return;
    await guarded(() => page.waitForTimeout(200));
  }
  throw new SelectorError('路区名称未匹配');
}

async function closeDetailModal({ page, guarded, control }, title) {
    await control(`关闭${title}`, async () => {
      const selected = await guarded(() => page.locator('.dbuMicroSysApp-modal-content').evaluateAll((elements, title) => {
        const visible = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
        document.querySelectorAll('[data-rd3-close], [data-rd3-modal]').forEach(element => {
          element.removeAttribute('data-rd3-close'); element.removeAttribute('data-rd3-modal');
        });
        const candidates = elements.filter(element => visible(element)
          && [...element.querySelectorAll('.dbuMicroSysApp-modal-title')].some(heading => heading.textContent.trim() === title));
        const inner = candidates.filter(element => !candidates.some(other => other !== element && element.contains(other)));
        if (inner.length !== 1) return false;
        const modal = inner[0];
        const buttons = [...modal.querySelectorAll('.dbuMicroSysApp-modal-close')].filter(button => visible(button)
          && button.closest('.dbuMicroSysApp-modal-content') === modal);
        if (buttons.length !== 1) return false;
        modal.setAttribute('data-rd3-modal', 'closing');
        buttons[0].setAttribute('data-rd3-close', 'close');
        return true;
      }, title));
      if (!selected) throw new SelectorError(`${title}关闭按钮不唯一或缺失`);
      await guarded(() => page.locator('[data-rd3-close="close"]').click());
      for (let attempt = 0; attempt < 50; attempt++) {
        const visible = await guarded(() => page.locator('[data-rd3-modal="closing"]').evaluateAll(elements =>
          elements.some(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden')));
        if (!visible) return;
        await guarded(() => page.waitForTimeout(200));
      }
      throw new SelectorError(`${title}关闭超时`);
    });
}

export async function closeRouteDetailModals(context) {
  const { page, guarded, control } = context;
  for (const title of ['业务属性（产能）- 详情', '路区画像详情']) await closeDetailModal(context, title);
  await control('确认列表', async () => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const { count } = await guarded(() => page.locator('.vxe-table--main-wrapper .vxe-table--body-wrapper')
        .evaluateAll(inspectVisibleTableBody));
      if (count > 1) throw new SelectorError('列表不唯一');
      if (count === 1) return;
      await guarded(() => page.waitForTimeout(200));
    }
    throw new SelectorError('列表不可见');
  });
}

async function selectCapacityTab(page, guarded, postalSelected) {
  await inspectCapacityTabs(page, guarded);
  await guarded(() => page.locator(`[data-rd1-target="${postalSelected ? 'postal' : 'date'}"]`).click());
  await inspectCapacityTabs(page, guarded, postalSelected);
}

async function inspectCapacityTabs(page, guarded, expectedPostalSelected) {
  for (let poll = 0; poll <= 50; poll++) {
    const selected = await guarded(() => page.locator('.dbuMicroSysApp-modal-content').evaluateAll(elements => {
      const visible = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
      document.querySelectorAll('[data-rd1-target]').forEach(element => element.removeAttribute('data-rd1-target'));
      const candidates = elements.filter(element => visible(element) && [...element.querySelectorAll('.dbuMicroSysApp-modal-title')]
        .some(heading => heading.textContent.trim() === '业务属性（产能）- 详情'));
      const inner = candidates.filter(element => !candidates.some(other => other !== element && element.contains(other)));
      if (inner.length !== 1) return false;
      const modal = inner[0];
      const labels = ['按日期', '按邮编'].map(text => {
        const links = [...modal.querySelectorAll('*')].filter(element => visible(element) && element.textContent.trim() === text);
        const leaves = links.filter(element => !links.some(other => other !== element && element.contains(other)));
        if (leaves.length !== 1) return null;
        const label = leaves[0].closest('label.dbuMicroSysApp-radio-button-wrapper');
        return label && modal.contains(label) && visible(label) ? label : null;
      });
      if (labels.includes(null) || labels[0] === labels[1]) return null;
      const group = labels[0].closest('.dbuMicroSysApp-radio-group');
      if (!group || !modal.contains(group) || labels[1].closest('.dbuMicroSysApp-radio-group') !== group) return null;
      // Never inspect the shared group: its checked input belongs to only one label.
      const tabs = labels.map(label => label.className.split(/\s+/).includes('dbuMicroSysApp-radio-button-wrapper-checked')
        || label.querySelector('input')?.checked === true);
      if (tabs[0] === tabs[1]) return null;
      labels.forEach((label, index) => label.setAttribute('data-rd1-target', index ? 'postal' : 'date'));
      return { postalSelected: tabs[1] };
    }));
    if (selected && (expectedPostalSelected === undefined || selected.postalSelected === expectedPostalSelected)) return selected.postalSelected;
    if (poll < 50) await guarded(() => page.waitForTimeout(200));
  }
  throw new SelectorError(expectedPostalSelected === false ? '按日期标签状态' : '按邮编标签状态');
}
