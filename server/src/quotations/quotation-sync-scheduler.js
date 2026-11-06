import { projectQuotationSyncStatus } from './quotation-sync-status.js';

export function createQuotationSyncScheduler({ intervalMinutes, runOnce,
  setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, initialDelayMs = 60_000, log = () => {} }) {
  let active = false, running = false, timer;
  const schedule = delay => {
    // Node clamps overflowing timeouts to 1ms; split long configured intervals.
    const chunk = Math.min(delay, 2_147_483_647);
    timer = setTimeoutImpl(async () => {
      timer = undefined;
      if (!active) return;
      if (delay > chunk) { schedule(delay - chunk); return; }
      running = true;
      try {
        const status = await runOnce();
        const attempt = projectQuotationSyncStatus(status)?.last_attempt;
        log(JSON.stringify({ result: attempt?.result ?? 'finished', counts: attempt?.counts ?? {} }));
      } catch { log('quotation_sync_job_failed'); }
      finally {
        running = false;
        if (active) schedule(intervalMinutes * 60_000);
      }
    }, chunk);
  };
  return {
    start() {
      if (intervalMinutes === 0 || active) return;
      active = true;
      if (!running) schedule(initialDelayMs);
    },
    stop() {
      active = false;
      if (timer !== undefined) clearTimeoutImpl(timer);
      timer = undefined;
    },
  };
}

export function quotationSyncInterval(env, source, log = () => {}) {
  const raw = env.LARK_QUOTATION_SYNC_MINUTES;
  const minutes = Number(raw ?? 0);
  if (!Number.isSafeInteger(minutes) || minutes < 0 || raw?.trim() === '') {
    log('LARK_QUOTATION_SYNC_MINUTES invalid; quotation_sync_disabled');
    return 0;
  }
  if (source !== 'db') {
    log('quotation_sync_disabled: DATA_SOURCE=json');
    return 0;
  }
  return minutes;
}
