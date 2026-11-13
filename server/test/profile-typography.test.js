import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = name => readFile(new URL('../../web/' + name, import.meta.url), 'utf8');
test('PL-T5 explicit metric classes and scheme B rules', async () => {
  const css = await source('styles.css');
  for (const [selector, declarations] of [
    ['.profile-route-title', ['font-size: 17px', 'font-weight: 700']],
    ['.profile-route-owner', ['font-size: 13px']],
    ['.profile-route-pph', ['font-size: 19px', 'font-weight: 700', 'color: #fff']],
    ['.profile-route-pickup', ['font-size: 15px', 'font-weight: 600']],
    ['.profile-route-difficulty', ['flex: 0 0 32px', 'line-height: 32px', 'font-size: 15px']],
    ['.profile-sidebar', ['flex: 0 0 390px', 'width: 390px']],
    ['.pl-metric dd', ['font-size: 30px', 'font-weight: 700']],
    ['.pl-metric-key', ['border-top: 3px solid #2dd9c6', 'background: #0f2230']],
  ]) {
    const start = css.indexOf('\n.profile-page ' + selector + ' {');
    assert.ok(start >= 0, selector);
    const rule = css.slice(start, css.indexOf('}', start));
    for (const declaration of declarations) assert.ok(rule.includes(declaration), selector + ': ' + declaration);
  }
  const app = await source('app.js');
  assert.match(app, /'PPH', 'profile-route-pph'/);
  assert.match(app, /'件', 'profile-route-pickup'/);
  assert.match(app, /node\('span', value, className\)/);
  const detail = await source('route-detail.js');
  assert.match(detail, /if \(key === 'pickup_volume' \|\| key === 'pph'\) \{\s*card.className \+= ' pl-metric-key'/);
  assert.doesNotMatch(css, /\.pl-metric:nth-child|\.profile-route-values > span:(?:first|last)-child/);
});
test('PL-T5 both pages share the filled switch and retain accessible headings', async () => {
  const css = await source('styles.css');
  for (const suffix of ['', ' a', ' a[aria-current="page"]', ' a:not([aria-current]):hover']) {
    const selector = '.profile-page .page-nav' + suffix + ', .map-page .page-nav' + suffix + ' {';
    assert.equal(css.split(selector).length, 2, 'one shared rule: ' + suffix);
    const start = css.indexOf(selector), rule = css.slice(start, css.indexOf('}', start));
    if (suffix === ' a[aria-current="page"]') {
      for (const value of ['background: #2dd9c6', 'color: #06222a', 'font-weight: 800', 'box-shadow:']) assert.ok(rule.includes(value));
    }
  }
  for (const file of ['index.html', 'map.html']) assert.match(await source(file), /<h1 class="sr-only"[^>]*>线路(?:档案|地图)<\/h1>/);
  assert.match(await source('map.html'), /<h1 class="sr-only" data-map-text="title">/);
});


test('ML-T4 scheme B list values have one rule shared by both pages', async () => {
  const css = await source('styles.css');
  for (const suffix of ['title', 'owner', 'pph', 'pickup', 'difficulty']) {
    const shared = '.map-page .map-route-' + suffix + ',\n.profile-page .profile-route-' + suffix + ' {';
    assert.equal(css.split(shared).length, 2, suffix);
  }
  assert.ok(css.includes('.map-page .map-route, .profile-page .profile-route { min-height: 72px; padding: 9px 10px; gap: 10px; }'));
  const panel = await source('map-panel.js');
  assert.ok(panel.includes("text('span', pph, 'map-route-pph')"));
  assert.ok(panel.includes("text('span', volume, 'map-route-pickup')"));
  assert.match(css, /\.route-labels--disabled \{ visibility: hidden; \}/);
});
