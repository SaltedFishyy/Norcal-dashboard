import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runLogin } from '../src/dms/session.js';

function harness({ answer = 'y', failure = false, cancelAtSave = false, closePage = false } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const events = [];
  const logs = [];
  output.on('data', (chunk) => {
    const prompt = chunk.toString();
    setImmediate(() => input.write(prompt.includes('(y/n)') ? `${answer}\n` : '\n'));
  });
  const browserType = {
    async launch(options) {
      assert.equal(options.headless, false);
      events.push(['launch']);
      const browser = new EventEmitter();
      browser.close = async () => { events.push(['close']); browser.emit('disconnected'); };
      browser.newContext = async (options) => {
        events.push(['context', options]);
        const page = new EventEmitter();
        page.goto = async (url) => {
          events.push(['goto', url]);
          if (failure) throw new Error('private authentication error content');
          if (closePage) setImmediate(() => page.emit('close'));
        };
        return {
          newPage: async () => page,
          storageState: async ({ path }) => {
            events.push(['save', path]);
            if (cancelAtSave) process.emit('SIGINT');
          },
        };
      };
      return browser;
    },
  };
  const fileOps = Object.fromEntries(['mkdir', 'rename', 'rm'].map((name) =>
    [name, async (...args) => { events.push([name, ...args]); }]));
  return { events, logs, run: () => runLogin({ statePath: '/outside/dms-state.json',
    baseUrl: 'https://example.invalid/start', browserType, input, output,
    fileOps, log: (message) => logs.push(message) }) };
}

for (const answer of ['y', 'n']) {
  test(`save and reopen; verification ${answer}`, async () => {
    const h = harness({ answer });
    assert.equal(await h.run(), answer === 'y' ? 0 : 1);
    assert.equal(h.events.filter(([name]) => name === 'launch').length, 2);
    assert.equal(h.events.filter(([name]) => name === 'goto').length, 2);
    const save = h.events.find(([name]) => name === 'save');
    assert.match(save[1], /\.tmp$/);
    assert.deepEqual(h.events.find(([name]) => name === 'rename'), ['rename', save[1], '/outside/dms-state.json']);
    assert.deepEqual(h.events.filter(([name]) => name === 'context')[1][1], { storageState: '/outside/dms-state.json' });
    assert.match(h.logs[0], answer === 'y' ? /验证成功/ : /不会自动切换 persistent profile/);
    assert.equal(process.listenerCount('SIGINT'), 0);
  });
}
test('Ctrl+C during save removes temporary state without replacing previous state', async () => {
  const h = harness({ cancelAtSave: true });
  assert.equal(await h.run(), 130);
  assert.equal(h.events.some(([name]) => name === 'rename'), false);
  assert.equal(h.events.some(([name]) => name === 'rm'), true);
});
test('closing the browser page cancels the pending prompt', async () => {
  const h = harness({ closePage: true });
  assert.equal(await h.run(), 130);
  assert.equal(h.events.some(([name]) => name === 'save'), false);
});
test('browser error details never reach logs', async () => {
  const h = harness({ failure: true });
  assert.equal(await h.run(), 1);
  assert.doesNotMatch(h.logs.join('\n'), /private authentication error content/);
  assert.equal(h.events.some(([name]) => name === 'save'), false);
});
