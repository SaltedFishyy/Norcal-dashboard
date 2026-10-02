import { NeedsLoginError, SelectorError, LoadLimitError, CircuitBreakerError, CaptureError } from './route-profile-page.js';

import { withPortraitPage } from './portrait-page.js';
const pathname = (url) => new URL(url).pathname;

async function clickPortraitRow(page, routeName, guarded) {
  const rows = page.locator('.vxe-table--main-wrapper .vxe-table--body-wrapper tr[rowid]');
  const body = page.locator('.vxe-table--main-wrapper .vxe-table--body-wrapper');
  // Virtual tables render only part of the list. Scroll inside the table, with a finite bound.
  for (let attempt = 0; attempt < 100; attempt++) {
    const ids = await guarded(() => rows.evaluateAll((elements, name) => elements
      .filter((row) => [...row.querySelectorAll('td')].some((cell) => cell.textContent.trim() === name))
      .map((row) => row.getAttribute('rowid')), routeName));
    if (ids.length > 1) throw new SelectorError('Route 行不唯一');
    if (ids.length === 1) {
      // Attribute filtering avoids interpolating a server-provided rowid into a CSS selector.
      const actions = page.locator('tr[rowid]').filter({ has: page.getByText('画像详情', { exact: true }) });
      const candidates = [];
      for (let i = 0; i < await guarded(() => actions.count()); i++) {
        const row = actions.nth(i);
        if (await guarded(() => row.getAttribute('rowid')) !== ids[0]) continue;
        const buttons = row.getByText('画像详情', { exact: true });
        for (let j = 0; j < await guarded(() => buttons.count()); j++) {
          if (await guarded(() => buttons.nth(j).isVisible())) candidates.push(buttons.nth(j));
        }
      }
      if (candidates.length !== 1) throw new SelectorError('画像详情不唯一');
      await guarded(() => candidates[0].click());
      return;
    }
    const moved = await guarded(() => body.evaluateAll((elements, reset) => {
      const visible = elements.filter((element) => element.getClientRects().length);
      if (visible.length !== 1) return false;
      const element = visible[0], previous = element.scrollTop;
      element.scrollTop = reset ? 0 : previous + Math.max(1, element.clientHeight * .8);
      return reset || element.scrollTop > previous;
    }, attempt === 0));
    if (!moved) break;
    await guarded(() => page.waitForTimeout(50));
  }
  throw new SelectorError('Route 行未找到');
}

async function clickDifficultyDetail(page, guarded) {
  const modals = page.locator('.dbuMicroSysApp-modal, .dbuMicroSysApp-modal-content, [role="dialog"]');
  // The first modal may render after the row click resolves. Wait within a bounded window.
  for (let attempt = 0; attempt < 100; attempt++) {
    const selected = await guarded(() => modals.evaluateAll((elements) => {
      const visible = (element) => element.getClientRects().length > 0
        && getComputedStyle(element).visibility !== 'hidden';
      const text = (element) => element.textContent.trim();
      document.querySelectorAll('[data-rd1-target]').forEach((element) => element.removeAttribute('data-rd1-target'));
      const candidates = elements.filter((element) => visible(element) && text(element).includes('路区画像详情'));
      const innermost = candidates.filter((element) => !candidates.some((other) => other !== element && element.contains(other)));
      if (innermost.length === 0) return null;
      if (innermost.length !== 1) return false;
      const modal = innermost[0];
      const labels = [...modal.querySelectorAll('*')].filter((element) => !element.children.length && visible(element) && text(element) === '路区难易度');
      if (labels.length === 0) return null;
      if (labels.length !== 1) return false;
      for (let parent = labels[0].parentElement; parent && modal.contains(parent); parent = parent.parentElement) {
        // Other sections may already have links while this section is still loading.
        if (text(parent).includes('基础属性')) return null;
        // Only innermost text matches count; wrapper nodes can carry the same text as their link.
        const links = [...parent.querySelectorAll('*')].filter((element) => visible(element) && /^详情\s*>?$/.test(text(element)));
        const leaves = links.filter((element) => !links.some((other) => other !== element && element.contains(other)));
        if (!leaves.length) continue;
        if (leaves.length > 1) return false;
        leaves[0].setAttribute('data-rd1-target', 'difficulty');
        return true;
      }
      return null;
    }));
    if (selected === false) throw new SelectorError('路区难易度详情不唯一');
    if (selected === true) {
      await guarded(() => page.locator('[data-rd1-target="difficulty"]').click());
      return;
    }
    await guarded(() => page.waitForTimeout(200));
  }
  throw new SelectorError('路区画像详情未加载');
}

export async function captureRouteDetail({ browserType, statePath, baseUrl, station, routeName, pageSize = 100,
  maxListRequests = 3, maxDetailRequests = 20, headless = false, log = () => {} }) {
  return withPortraitPage({ browserType, statePath, baseUrl, station, pageSize,
    maxListRequests, maxDetailRequests, headless, log,
    listRequestPath: '/roadAreaPortrait/home/frontPage/', needsLoginOn401: true,
    validate: () => {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(routeName || '') || pageSize !== 100
        || !Number.isSafeInteger(maxDetailRequests) || maxDetailRequests < 1) throw new CaptureError();
    },
  }, async ({ page, body, guarded, control, counts }) => {
    if (!Array.isArray(body?.data?.records)) throw new CaptureError();
    const matches = body.data.records.filter((row) => row?.roadAreaName === routeName);
    if (matches.length !== 1) throw new CaptureError();
    const rawId = matches[0].roadAreaId;
    if (!(typeof rawId === 'number' || typeof rawId === 'string' && /^\d+$/.test(rawId))) throw new CaptureError();
    const routeId = Number(rawId);
    if (!Number.isSafeInteger(routeId) || routeId < 1 || matches[0].transitStationName !== station) throw new CaptureError();
    await control('画像详情', () => clickPortraitRow(page, routeName, guarded));
    // Both listeners must be installed before the single difficulty-detail click.
    const detailResponse = (endpoint) => page.waitForResponse((item) =>
      pathname(item.url()).endsWith('/roadAreaPortraitDetails/details/' + endpoint)
      && item.request().method() === 'POST');
    const [contentResponse, headerResponse] = await control('路区难易度详情', () => Promise.all([
      detailResponse('getRoadAreaContent'), detailResponse('getRoadAreaHeader'),
      clickDifficultyDetail(page, guarded),
    ]));
    for (const item of [contentResponse, headerResponse]) {
      let id;
      try { id = item.request().postDataJSON()?.roadAreaId; } catch { throw new CaptureError(); }
      if (id !== routeId) throw new CaptureError();
    }
    const [contentBody, headerBody] = await guarded(() => Promise.all([contentResponse.json(), headerResponse.json()]));
    if (headerBody?.data?.roadAreaName !== routeName) throw new CaptureError();
    const { listRequestCount, detailRequestCount } = counts();
    return { routeId, listBody: body, contentBody, headerBody, listRequestCount, detailRequestCount };
  });
}
