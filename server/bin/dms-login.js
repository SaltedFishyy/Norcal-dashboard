import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveStatePath, checkStatePath, parseBaseUrl } from '../src/config.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

try {
  const state = checkStatePath(resolveStatePath({
    env: process.env, platform: process.platform, homedir: homedir(), repoRoot,
  }), repoRoot);
  for (const warning of state.warnings) console.warn(warning);
  console.log(`Session 文件：${state.path}`);
  const url = parseBaseUrl(process.env.DMS_BASE_URL);
  console.log(`打开：${url.display}`);
  // 配置校验通过后才加载浏览器工具。
  try {
    const { runLogin } = await import('../src/dms/session.js');
    process.exitCode = await runLogin({ statePath: state.path, baseUrl: url.href });
  } catch {
    console.error('登录工具启动或清理失败。请检查 Playwright 安装和本地文件权限。');
    process.exitCode = 1;
  }
} catch (error) {
  // 这里只输出本模块生成的配置错误。
  console.error(error.message);
  process.exitCode = 1;
}
