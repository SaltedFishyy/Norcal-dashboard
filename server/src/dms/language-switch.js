export const dmsLanguageNotice = 'DMS 界面是英文，程序自动切换中文失败。请在公用电脑打开 DMS，把右上角语言手动切换为中文，然后重新刷新；如仍失败，请运行 npm run dms:login 重新登录。';
export class DmsLanguageError extends Error { constructor() { super('DMS 界面语言不是中文'); this.name = 'DmsLanguageError'; } }

// Read DOM only; missing controls remain the responsibility of existing selector handling.
export async function checkDmsLanguage({ page, guarded, timeout = 2000 }) {
  const deadline = Date.now() + timeout;
  do {
    const chinese = await guarded(() => page.getByRole('button', { name: /查\s*询/ }).count());
    if (chinese > 0) return 'chinese';
    const english = await guarded(() => page.getByRole('button', { name: /(^|\s)Search$/ }).count());
    if (english > 0) throw new DmsLanguageError();
    if (Date.now() >= deadline) return;
    await guarded(() => new Promise(resolve => setTimeout(resolve, Math.min(100, deadline - Date.now()))));
  } while (true);
}

const safetyErrors = ['NeedsLoginError', 'CircuitBreakerError', 'LoadLimitError', 'InterruptedError'];

export async function ensureChineseDms({ page, guarded, allowLanguageSwitch, assertLoggedIn,
  log = () => {}, timeout = 30000 }) {
  try { await checkDmsLanguage({ page, guarded }); return false; }
  catch (error) { if (!(error instanceof DmsLanguageError)) throw error; }
  try {
    const trigger = page.locator('header .dbu-web-main-dropdown-trigger:visible').filter({ hasText: /^\s*English\s*$/ });
    if (await guarded(() => trigger.count()) !== 1) throw new DmsLanguageError();
    await guarded(() => trigger.click({ timeout: 2000 }));
    const item = page.locator('li.dbu-web-main-dropdown-menu-item:visible').filter({ hasText: /^\s*(中文|简体中文)\s*$/ });
    if (await guarded(() => item.count()) !== 1) throw new DmsLanguageError();
    // Reserve before dispatch: reload requests may fire synchronously with the click.
    await guarded(() => { allowLanguageSwitch(); return item.click({ timeout: 2000 }); });
    try { await guarded(() => page.waitForLoadState('networkidle', { timeout: 30000 })); }
    catch (error) { if (error.name !== 'TimeoutError') throw error; }
    const deadline = Date.now() + timeout;
    for (let poll = 0; poll <= Math.ceil(timeout / 200); poll++) {
      await assertLoggedIn();
      try {
        if (await checkDmsLanguage({ page, guarded, timeout: 0 }) === 'chinese') {
          log('阶段：语言已切换为中文');
          return true;
        }
      } catch (error) { if (!(error instanceof DmsLanguageError)) throw error; }
      if (Date.now() >= deadline || poll === Math.ceil(timeout / 200)) break;
      await guarded(() => page.waitForTimeout(Math.min(200, deadline - Date.now())));
    }
    throw new DmsLanguageError();
  } catch (error) {
    if (safetyErrors.includes(error.name)) throw error;
    throw new DmsLanguageError();
  }
}

