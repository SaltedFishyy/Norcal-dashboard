import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntimeDir, checkRuntimeDir } from '../src/config.js';
import { startApiServer } from '../src/api/server.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export async function runServer({ env = process.env, log = console.log, errorLog = console.error,
  start = startApiServer } = {}) {
  const value = env.PORT === undefined ? '3000' : env.PORT.trim();
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
    errorLog('PORT 必须是 1–65535 的整数。'); return 1;
  }
  try {
    const runtime = checkRuntimeDir(resolveRuntimeDir({ env, platform: process.platform, homedir: homedir(), repoRoot }), repoRoot);
    for (const warning of runtime.warnings) log(warning);
    await start({ port, runtimeDir: runtime.path, log });
    log(`Server: http://127.0.0.1:${port}`);
    log(`Runtime data: ${runtime.path}`);
    return 0;
  } catch (error) {
    errorLog(error?.code === 'EADDRINUSE' ? `端口 ${port} 已被占用。` : 'Server 启动失败，请检查端口和本地配置。');
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = await runServer();
}
