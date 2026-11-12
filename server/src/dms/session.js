import { chromium } from 'playwright';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

export async function runLogin({ statePath, baseUrl, browserType = chromium,
  input = process.stdin, output = process.stdout, log = console.log,
  fileOps = { mkdir, rename, rm } }) {
  const abort = new AbortController();
  const terminal = createInterface({ input, output });
  let browser;
  let temporaryPath;
  let intentionalClose = false;
  let phase = '启动浏览器';
  const cancel = () => {
    if (abort.signal.aborted) return;
    abort.abort();
    void browser?.close().catch(() => {});
  };
  const sigint = () => cancel();
  process.on('SIGINT', sigint);
  terminal.on('SIGINT', sigint);
  terminal.on('close', cancel);

  const open = async (options) => {
    browser = await browserType.launch({ headless: false });
    if (abort.signal.aborted) throw new Error('cancelled');
    browser.on('disconnected', () => { if (!intentionalClose) cancel(); });
    const context = await browser.newContext({ ...options, locale: 'zh-CN' });
    const page = await context.newPage();
    page.on('close', () => { if (!intentionalClose) cancel(); });
    await page.goto(baseUrl, { waitUntil: 'load' });
    return context;
  };
  const close = async () => {
    intentionalClose = true;
    try { await browser?.close(); } finally {
      browser = undefined;
      intentionalClose = false;
    }
  };
  const question = (prompt) => {
    abort.signal.throwIfAborted();
    return terminal.question(prompt, { signal: abort.signal });
  };

  try {
    const context = await open();
    await question('请在打开的浏览器中手动登录 GOFO DMS。登录完成后按 Enter（界面是英文也没关系，刷新时程序会自动切换为中文）。\n');
    phase = '保存 session';
    await fileOps.mkdir(path.dirname(statePath), { recursive: true });
    temporaryPath = `${statePath}.${randomUUID()}.tmp`;
    // 在目标旁完整写入临时文件，再原子重命名，保留已有的完整文件。
    await context.storageState({ path: temporaryPath });
    abort.signal.throwIfAborted();
    await fileOps.rename(temporaryPath, statePath);
    temporaryPath = undefined;
    await close();

    phase = '重新打开并验证 session';
    await open({ storageState: statePath });
    let answer;
    do {
      answer = (await question('浏览器已用保存的 session 重新打开。页面是否仍是登录状态？(y/n)\n')).trim().toLowerCase();
    } while (!['y', 'n'].includes(answer));
    if (answer === 'y') {
      log('storageState 验证成功');
      return 0;
    }
    log('storageState 无法保持登录。不会自动切换 persistent profile，请把结果告诉 Claude / Product Owner');
    return 1;
  } catch {
    // Playwright 原始错误可能包含完整 URL 和登录信息，因此只输出当前阶段。
    log(abort.signal.aborted ? '登录流程已取消。' : `登录流程失败（${phase}）。请检查网络、Chromium 安装和本地文件权限后重试。`);
    return abort.signal.aborted ? 130 : 1;
  } finally {
    await close().catch(() => {});
    try {
      if (temporaryPath) await fileOps.rm(temporaryPath, { force: true });
    } finally {
      process.off('SIGINT', sigint);
      terminal.off('SIGINT', sigint);
      terminal.off('close', cancel);
      terminal.close();
    }
  }
}
