import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureChineseDms, DmsLanguageError } from '../src/dms/language-switch.js';
import { withPortraitPage, NeedsLoginError, InterruptedError, CircuitBreakerError, LoadLimitError } from '../src/dms/portrait-page.js';
import { stationPage } from './multi-station-fixtures.js';

function languagePage({ chinese = false, unknown = false, triggers = ['English'], items = ['中文'],
  succeeds = true, clickError, idleError } = {}) {
  const clicks = [], budgets = [], logs = [];
  let switched = chinese;
  const page = {
    getByRole: (_, { name }) => ({ count: async () => Number(!unknown && name.test(switched ? '查询' : 'search Search')) }),
    locator: selector => ({ filter: ({ hasText }) => {
      const matches = (selector.startsWith('header') ? triggers : items).filter(text => hasText.test(text));
      return { count: async () => matches.length, click: async ({ timeout }) => {
        assert.equal(timeout, 2000);
        clicks.push(matches[0]);
        if (clickError) throw clickError;
        if (!selector.startsWith('header')) switched = succeeds;
      } };
    } }),
    waitForLoadState: async () => { if (idleError) throw idleError; },
    waitForTimeout: async () => {},
  };
  const context = { page, guarded: action => action(), allowLanguageSwitch: () => budgets.push(1),
    assertLoggedIn: async () => {}, log: value => logs.push(value), timeout: 0 };
  return { page, context, clicks, budgets, logs, run: () => ensureChineseDms(context) };
}

test('Chinese page leaves clicks and budget unchanged', async () => {
  const h = languagePage({ chinese: true });
  assert.equal(await h.run(), false);
  assert.deepEqual(h.clicks, []); assert.deepEqual(h.budgets, []);
});
for (const item of ['中文', '简体中文', '  中文  ']) test(`switches once using exact ${item}`, async () => {
  const h = languagePage({ triggers: ['Pacific Time', 'English', 'SFO01'], items: ['English', item, '中文（繁體）'] });
  assert.equal(await h.run(), true);
  assert.deepEqual(h.clicks, ['English', item]); assert.deepEqual(h.budgets, [1]);
  assert.deepEqual(h.logs, ['阶段：语言已切换为中文']);
});
for (const options of [
  { triggers: [] }, { triggers: ['English', 'English'] }, { triggers: ['English Settings'] },
  { items: [] }, { items: ['English', '中文（繁體）'] }, { items: ['中文', '简体中文'] },
  { succeeds: false }, { clickError: new Error('click failed') },
]) test(`switch failure is dedicated and never retries: ${JSON.stringify(options)}`, async () => {
  const h = languagePage(options);
  await assert.rejects(h.run(), DmsLanguageError);
  assert.ok(h.clicks.length <= 2); assert.ok(h.budgets.length <= 1);
});
for (const Type of [NeedsLoginError, InterruptedError, CircuitBreakerError, LoadLimitError]) {
  test(`preserves ${Type.name} during switching`, async () => {
    const error = new Type(), h = languagePage({ clickError: error });
    await assert.rejects(h.run(), value => value === error);
    const after = languagePage(); after.context.assertLoggedIn = async () => { throw error; };
    await assert.rejects(after.run(), value => value === error);
  });
}
test('networkidle timeout is tolerated but safety errors are preserved', async () => {
  assert.equal(await languagePage({ idleError: Object.assign(new Error(), { name: 'TimeoutError' }) }).run(), true);
  const error = new InterruptedError();
  await assert.rejects(languagePage({ idleError: error }).run(), value => value === error);
});

function integration({ english = true, extra = 0, extraList = false, openExtra = false,
  redirect = false, batch = true, idleError } = {}) {
  const h = stationPage(), originalLocator = h.page.locator;
  const language = languagePage({ chinese: !english });
  const list = () => h.emit('dlvs-dataApi/roadAreaPortrait/home/frontPage/queryList/pagination', 200, {});
  h.page.getByRole = (_, options) => ({ ...originalLocator('query'), ...language.page.getByRole(_, options) });
  h.page.locator = selector => selector.includes(':visible') && /dropdown-(trigger|menu-item)/.test(selector)
    ? { filter: filter => {
      const target = language.page.locator(selector).filter(filter);
      return { ...target, click: async options => {
        await target.click(options);
        if (selector.startsWith('li')) {
          list();
          if (extraList) list();
          for (let i = 0; i < 24 + extra; i++) h.emit('reload/mock', 200, {});
          if (redirect) h.page.url = () => 'https://example.invalid/login';
          h.page.emit('framenavigated', h.page);
        }
      } };
    } } : originalLocator(selector);
  if (idleError) h.page.waitForLoadState = async () => { throw idleError; };
  h.page.goto = async () => { list(); if (openExtra) list(); };
  const run = () => withPortraitPage({ browserType: h.browserType, statePath: '/mock',
    baseUrl: 'https://example.invalid/areaDepiction', globalStationMode: true, batch,
    maxListRequests: 2, maxProdApiRequests: 2 }, async context => (await context.queryStation()).body);
  return { h, language, run };
}
test('reload on areaDepiction continues query with exactly one extra list and 25 prod-api requests', async () => {
  const english = integration(), chinese = integration({ english: false });
  assert.deepEqual(await english.run(), await chinese.run());
  assert.deepEqual(english.language.clicks, ['English', '中文']);
  assert.equal(english.h.requests - chinese.h.requests, 25);
});
test('extra reload prod-api budget remains bounded', async () => {
  await assert.rejects(integration({ extra: 1 }).run(), LoadLimitError);
});
test('extra reload list allowance is only one', async () => {
  await assert.rejects(integration({ extraList: true }).run(), LoadLimitError);
});
test('Chinese page does not receive extra open request allowance', async () => {
  await assert.rejects(integration({ english: false, openExtra: true }).run(), LoadLimitError);
});
test('single-page login check after switch preserves NeedsLoginError', async () => {
  await assert.rejects(integration({ redirect: true, batch: false }).run(), NeedsLoginError);
});
test('batch navigation to login retains existing listener', async () => {
  await assert.rejects(integration({ redirect: true }).run(), NeedsLoginError);
});
test('non-batch wrapper preserves interruption during language switch', async () => {
  const error = new InterruptedError();
  await assert.rejects(integration({ batch: false, idleError: error }).run(), value => value === error);
});
