import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../scripts/codex-watch.mjs', import.meta.url));

async function runWatcher(t, mode, { timer, enter = false, eof = false } = {}) {
  const run = await mkdtemp(path.join(tmpdir(), 'codex-watch-'));
  t.after(() => rm(run, { recursive: true, force: true }));
  await Promise.all([
    writeFile(path.join(run, 'exit-code'), '7'),
    writeFile(path.join(run, 'changed-files.txt'), ''),
    writeFile(path.join(run, 'events.jsonl'), '{"type":"turn.completed"}\n'),
  ]);
  // Inject a clock only into the child; production keeps its fixed eight seconds.
  const preload = timer ? ['--import', `data:text/javascript,${encodeURIComponent(timer)}`] : [];
  const child = spawn(process.execPath, [...preload, script, ...mode, run], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = '', errors = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    output += chunk;
    if (enter && (output.includes('立即关闭）') || output.includes('按 Enter 关闭窗口'))) {
      enter = false;
      if (mode.includes('--hold')) child.stdin.end('\n');
      else child.stdin.write('\n');
    }
  });
  child.stderr.on('data', chunk => { errors += chunk; });
  if (eof) child.stdin.end();
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { code, output, errors };
}

test('codex-watch accepts --auto-close and exits zero after the timer, even on input EOF', { timeout: 10000 }, async t => {
  const result = await runWatcher(t, ['--auto-close'], {
    eof: true,
    timer: `const original = globalThis.setTimeout;
      globalThis.setTimeout = (fn, ms, ...args) => {
        if (ms !== 8000) throw new Error('unexpected timeout: ' + ms);
        return original(() => { console.log('AUTO_CLOSE_TIMER_FIRED'); fn(...args); }, 20);
      };`,
  });
  assert.equal(result.code, 0, result.errors);
  assert.equal(result.errors, '');
  assert.match(result.output, /Codex 退出码: 7/);
  assert.match(result.output, /最终回复:[\s\S]*窗口将在 8 秒后自动关闭（按 Enter 立即关闭）[\s\S]*AUTO_CLOSE_TIMER_FIRED/);
});

test('codex-watch Enter closes auto-close early and cancels the timer', { timeout: 10000 }, async t => {
  const result = await runWatcher(t, ['--auto-close'], {
    enter: true,
    timer: `const original = globalThis.setTimeout;
      globalThis.setTimeout = (fn, ms, ...args) => original(() => {
        console.log('UNEXPECTED_TIMEOUT'); fn(...args);
      }, 60000);`,
  });
  assert.equal(result.code, 0, result.errors);
  assert.equal(result.errors, '');
  assert.match(result.output, /窗口将在 8 秒后自动关闭/);
  assert.doesNotMatch(result.output, /UNEXPECTED_TIMEOUT/);
});

test('codex-watch retains manual --hold and rejects conflicting modes', { timeout: 10000 }, async t => {
  const held = await runWatcher(t, ['--hold'], { enter: true });
  assert.equal(held.code, 0, held.errors);
  assert.match(held.output, /按 Enter 关闭窗口/);
  assert.doesNotMatch(held.output, /自动关闭/);
  const invalid = await runWatcher(t, ['--hold', '--auto-close']);
  assert.equal(invalid.code, 1);
  assert.match(invalid.errors, /用法/);
});
