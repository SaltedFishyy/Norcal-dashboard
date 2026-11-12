import { open, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), '..');
const AUTO_CLOSE_SECONDS = 8;
const help = `用法：node scripts/codex-watch.mjs [--once | --hold | --auto-close | --window] [<run-dir>]
  默认：跟踪最新 run；指定目录相对 cwd 或使用绝对路径。
  --once   打印已有事件后退出
  --hold   run 结束后按 Enter 关闭窗口
  --auto-close run 结束后 ${AUTO_CLOSE_SECONDS} 秒自动关闭，按 Enter 立即关闭
  --window 在新的 Windows Terminal 窗口运行 --auto-close
  --help   显示用法`;
let stopped = false;
process.on('SIGINT', () => { stopped = true; process.exit(0); });

function print(value, error = false) {
  const stream = error ? process.stderr : process.stdout;
  for (const line of String(value).split(/\r?\n/)) {
    stream.write(`${new Date().toTimeString().slice(0, 8)} ${line}\n`);
  }
}
function relative(value) {
  return path.relative(root, path.resolve(root, value)).replaceAll('\\', '/') || '.';
}
function short(value, limit = 200) {
  const text = String(value ?? '').replace(/\s+/g, ' ');
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
function errorText(value) {
  return typeof value === 'string' ? value : value?.message ?? '未知错误';
}
function eventOutput(event) {
  if (!event || typeof event !== 'object') { print('· 未知事件'); return; }
  if (event.error || event.type === 'error' || event.type === 'turn.failed') {
    print(`✖ ${errorText(event.error ?? event.message)}`); return;
  }
  if (event.type === 'thread.started') { print('● Codex 会话开始'); return; }
  if (event.type === 'turn.started') { print('● 开始执行'); return; }
  if (event.type === 'turn.completed') {
    print(`● 本轮结束 (input ${event.usage?.input_tokens ?? '?'} / output ${event.usage?.output_tokens ?? '?'})`);
    return;
  }
  const item = event.item;
  if (item?.error) { print(`✖ ${errorText(item.error)}`); return; }
  if (!item || !event.type?.startsWith('item.')) { print(`· ${short(event.type ?? '未知事件')}`); return; }
  const completed = event.type === 'item.completed';
  if (item.type === 'command_execution') {
    if (event.type === 'item.started') print(`▶ 执行命令: ${short(item.command)}`);
    else if (completed) {
      if (item.exit_code === 0) print('✓ 命令完成');
      else {
        print(`✖ 命令失败 (exit ${item.exit_code ?? '?'})`);
        const lines = String(item.aggregated_output ?? '').trimEnd().split(/\r?\n/).slice(-5);
        if (lines.some(Boolean)) print(lines.map(line => `   ${line}`).join('\n'));
      }
    }
  } else if (item.type === 'file_change') {
    if (completed) for (const change of item.changes ?? []) {
      print(`${{ add: '＋ 新增文件', update: '✎ 修改文件', delete: '－ 删除文件' }[change.kind] ?? '· 文件变化'}: ${relative(change.path)}`);
    }
  } else if (item.type === 'agent_message') {
    if (completed) print(`💬 Codex: ${String(item.text ?? '').trimEnd().replace(/\r?\n/g, '\n   ')}`);
  } else {
    const labels = { reasoning: '思考', todo_list: '任务清单', web_search: '网页搜索', mcp_tool_call: '工具调用' };
    print(`· ${labels[item.type] ?? short(item.type)} (${completed ? '完成' : '进行中'})${item.query ? `: ${short(item.query)}` : ''}`);
  }
}
async function optionalStat(file) {
  try { return await stat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function latest() {
  try {
    const entries = await readdir(path.join(root, '.handoff/runs'), { withFileTypes: true });
    const names = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    return names.length ? path.join(root, '.handoff/runs', names.at(-1)) : null;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Keep byte offsets separate from decoded text so split UTF-8 characters survive polling.
async function watch(run, mode) {
  print(`正在观察: ${relative(run)}`);
  const events = path.join(run, 'events.jsonl');
  let offset = 0, pending = '', decoder = new StringDecoder('utf8');
  function parse(line) {
    if (!line.trim()) return;
    try { eventOutput(JSON.parse(line)); } catch { print('⚠ 忽略非法 JSON 行'); }
  }
  async function readAdded() {
    const info = await optionalStat(events);
    if (!info) return;
    if (info.size < offset) {
      offset = 0; pending = ''; decoder = new StringDecoder('utf8');
      print('· 事件文件已截断，从头读取');
    }
    if (info.size === offset) return;
    let handle;
    try {
      handle = await open(events, 'r');
      const buffer = Buffer.alloc(Math.min(64 * 1024, info.size - offset));
      while (offset < info.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, info.size - offset), offset);
        if (!bytesRead) break;
        offset += bytesRead;
        pending += decoder.write(buffer.subarray(0, bytesRead));
        let end;
        while ((end = pending.indexOf('\n')) !== -1) {
          parse(pending.slice(0, end)); pending = pending.slice(end + 1);
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    finally { await handle?.close(); }
  }
  async function summary(wait) {
    print(`● run 结束，Codex 退出码: ${(await readFile(path.join(run, 'exit-code'), 'utf8')).trim()}`);
    const changes = path.join(run, 'changed-files.txt');
    const deadline = Date.now() + (wait ? 15000 : 0);
    while (!(await optionalStat(changes)) && Date.now() < deadline) await delay(500);
    print('本轮变更文件:');
    if (await optionalStat(changes)) print(`   ${(await readFile(changes, 'utf8')).trimEnd().replace(/\r?\n/g, '\n   ') || '（无文件变更）'}`);
    else print('   尚未生成');
    print(`最终回复: ${path.join(run, 'last-message.md')}`);
  }
  while (!stopped) {
    await readAdded();
    const finished = await optionalStat(path.join(run, 'exit-code'));
    const size = (await optionalStat(events))?.size ?? 0;
    if (finished && offset === size) {
      pending += decoder.end();
      if (pending.trim()) parse(pending);
      await summary(mode !== '--once');
      if (mode === '--hold' || mode === '--auto-close') {
        const autoClose = mode === '--auto-close';
        print(autoClose ? `窗口将在 ${AUTO_CLOSE_SECONDS} 秒后自动关闭（按 Enter 立即关闭）` : '按 Enter 关闭窗口');
        await new Promise(resolve => {
          let timer;
          function finish() {
            clearTimeout(timer);
            process.stdin.off('data', onData);
            process.stdin.off('end', onEnd);
            process.stdin.pause();
            resolve();
          }
          function onData(chunk) { if (chunk.includes('\n') || chunk.includes('\r')) finish(); }
          // With no interactive input, auto-close still waits for its timer.
          function onEnd() { if (!autoClose) finish(); }
          if (autoClose) timer = setTimeout(finish, AUTO_CLOSE_SECONDS * 1000);
          process.stdin.setEncoding('utf8');
          process.stdin.on('data', onData);
          process.stdin.once('end', onEnd);
          process.stdin.resume();
        });
        process.stdin.pause();
        if (autoClose) process.exit(0);
      }
      return;
    }
    if (mode === '--once') return;
    await delay(500);
  }
}

async function windowRun(run) {
  const fallback = `node scripts/codex-watch.mjs '${run.replaceAll("'", "''")}'`;
  try {
    const child = spawn('wt.exe', ['-w', 'new', 'new-tab', '--title', `Codex watch: ${path.basename(run)}`, '-d', root, process.execPath, script, '--auto-close', run], {
      cwd: root, detached: true, stdio: 'ignore', shell: false,
    });
    // Wait for the launcher result to catch nonzero failures, without keeping it alive.
    await new Promise((resolve, reject) => {
      let timer;
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => {
        clearTimeout(timer);
        if (code === 0) resolve(); else reject(new Error(`wt.exe 退出码 ${code}`));
      });
      child.once('spawn', () => {
        child.unref();
        timer = setTimeout(resolve, 200);
      });
    });
  } catch (error) {
    print(`✖ 无法打开 Windows Terminal: ${error.message}`, true);
    print(`手动运行（仓库根目录 PowerShell）: ${fallback}`, true);
    process.exitCode = 1;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { print(help); return; }
  const flags = args.filter(arg => arg.startsWith('--'));
  const dirs = args.filter(arg => !arg.startsWith('--'));
  if (flags.some(flag => !['--once', '--hold', '--auto-close', '--window'].includes(flag)) || flags.length > 1 || dirs.length > 1) throw new Error(help);
  const mode = flags[0];
  let run = dirs.length ? path.resolve(dirs[0]) : await latest();
  if (dirs.length && !(await optionalStat(run))?.isDirectory()) throw new Error(`run 目录不存在: ${run}`);
  if (!run && mode === '--window') throw new Error('还没有 run，无法打开观察窗口');
  if (!run) print('等待第一个 run 出现…');
  while (!run) { await delay(500); run = await latest(); }
  if (mode === '--window') await windowRun(run);
  else await watch(run, mode);
}
main().catch(error => { print(`✖ ${error.message}`, true); process.exitCode = 1; });
