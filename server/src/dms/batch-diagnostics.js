import path from 'node:path';
import * as fs from 'node:fs/promises';
import { writeFileAtomic } from '../store/atomic-file.js';

export function diagnosticMessage(error) {
  const seen = new Set();
  while (error?.cause && !seen.has(error.cause)) { seen.add(error); error = error.cause; }
  return String(error?.message || '').split(/[\r\n]/, 1)[0]
    .replace(/https?:\/\/\S+/g, '').split(/[?#]/, 1)[0].slice(0, 300);
}

// RD3-11 diagnostics are best-effort and must never delay shutdown indefinitely.
export async function writePageFailureDiagnostic({ runtimeDir, page, error, currentRoute, phase,
  now = () => new Date(), fileOps = fs, errorLog = () => {}, prefix = 'route-details-batch', fields = {} }) {
  const json = `${prefix}-failure.json`, png = `${prefix}-failure.png`;
  let screenshot = null, diagnostic = null, warned = false, timer, expired = false;
  const warn = () => { if (!warned) { warned = true; errorLog('诊断保存失败，请检查本地目录或页面状态。'); } };
  const work = async () => {
    try {
      await fileOps.mkdir(runtimeDir, { recursive: true });
      if (expired) return;
      if (page) { await page.screenshot({ path: path.join(runtimeDir, png), fullPage: false, timeout: 4000 }); screenshot = png; }
    } catch { warn(); }
    if (expired) return;
    try {
      const record = { at: now().toISOString(), route_name: currentRoute?.route_name ?? null,
        route_id: currentRoute?.route_id ?? null, phase, error_type: error.name,
        step: error.name === 'SelectorError' ? error.message.replace(/^页面控件不可用：/, '') : null,
        message_first_line: diagnosticMessage(error), ...fields };
      await writeFileAtomic(path.join(runtimeDir, json), JSON.stringify(record, null, 2) + '\n', { fileOps });
      if (!expired) diagnostic = { json, screenshot };
    } catch { warn(); }
  };
  try {
    await Promise.race([work(), new Promise(resolve => {
      timer = setTimeout(() => { expired = true; warn(); resolve(); }, 4500);
    })]);
  } finally { clearTimeout(timer); }
  return diagnostic;
}
