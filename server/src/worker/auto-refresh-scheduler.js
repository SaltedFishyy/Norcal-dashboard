import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '../store/atomic-file.js';
import { needsLogin, safeStopReason } from '../api/freshness.js';

export const RETRY_INTERVAL_MS = 15 * 60_000;
export const MAX_RETRY_ROUNDS = 2;
export const BUSY_INTERVAL_MS = 5 * 60_000;
export const BUSY_DEADLINE_MINUTES = 120;
export const CATCHUP_CUTOFF = '23:00';
export const CATCHUP_DELAY_MS = 2 * 60_000;

export function autoRefreshConfig(env, source, log = () => {}) {
  const time = env.AUTO_REFRESH_TIME?.trim();
  const time_zone = env.AUTO_REFRESH_TZ || 'America/Los_Angeles';
  const disabled = { enabled: false, time: time || null, time_zone };
  if (source !== 'db') { log('auto_refresh_disabled: DATA_SOURCE=json'); return disabled; }
  if (!time || time === 'off') return disabled;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    log('auto_refresh_disabled: invalid AUTO_REFRESH_TIME'); return disabled;
  }
  try { new Intl.DateTimeFormat('en', { timeZone: time_zone }).format(); }
  catch { log('auto_refresh_disabled: invalid AUTO_REFRESH_TZ'); return disabled; }
  return { enabled: true, time, time_zone };
}

export function createAutoRefreshScheduler({ config, launcher, readDistricts, runtimeDir,
  now = () => new Date(), setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, log = () => {} }) {
  const filename = path.join(runtimeDir, 'auto-refresh-status.json');
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: config.time_zone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const local = date => {
    const p = Object.fromEntries(formatter.formatToParts(date).map(p => [p.type, p.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
  };
  const tomorrow = date => new Date(Date.parse(`${date}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  // Search real UTC minutes so gaps and repeated local times follow the zone's DST rules.
  const at = (date, time) => {
    const center = Date.parse(`${date}T${time}:00Z`);
    for (let t = center - 18 * 3_600_000; t <= center + 30 * 3_600_000; t += 60_000) {
      const p = local(new Date(t));
      if (p.date === date && p.time >= time) return t;
    }
    throw new Error('Unresolvable local date');
  };
  let active = false, running = false, timer, cancelWait, last = null, next = null;
  const event = (event, fields = {}) => log(JSON.stringify({ event, ...fields }));
  const save = () => writeFileAtomic(filename, JSON.stringify(last, null, 2) + '\n');
  const arm = (target, callback) => {
    timer = setTimeoutImpl(async () => {
      timer = undefined;
      if (!active) return;
      if (now().getTime() < target) { arm(target, callback); return; }
      await callback();
    }, Math.max(0, Math.min(target - now().getTime(), 2_147_483_647)));
  };
  const wait = ms => new Promise(resolve => {
    cancelWait = () => resolve(false);
    arm(now().getTime() + ms, () => { cancelWait = undefined; resolve(true); });
  });
  const result = () => {
    const ds = last.districts;
    if (ds.some(d => needsLogin(d.stop_reason))) return 'needs_login';
    if (ds.every(d => ['completed', 'skipped_empty'].includes(d.status))) return 'completed';
    if (ds.some(d => d.status === 'completed')) return 'partial';
    return ds.some(d => d.status === 'skipped_busy') ? 'skipped_busy' : 'failed';
  };
  const districtEvent = d => event('auto_refresh_district', { id: d.id, status: d.status,
    stop_reason: d.stop_reason, run_id: d.run_id });
  const scheduleNext = () => {
    if (!active) return;
    const p = local(now());
    const date = p.time < config.time && last?.date !== p.date ? p.date : tomorrow(p.date);
    next = new Date(at(date, config.time)).toISOString();
    arm(Date.parse(next), () => run(date));
  };
  const run = async date => {
    if (!active || running) return;
    const p = local(now());
    if (p.date !== date || p.time < config.time || p.time >= CATCHUP_CUTOFF) {
      event('auto_refresh_missed', { date }); scheduleNext(); return;
    }
    if (last?.date === date) { scheduleNext(); return; }
    running = true; next = null;
    try {
      const districts = await readDistricts();
      last = { version: 1, date, time_zone: config.time_zone, scheduled_for: config.time,
        started_at: now().toISOString(), finished_at: null, result: 'running', retry_round: 0,
        districts: (districts.districts ?? districts).map(d => ({ id: d.id, status: 'pending',
          run_id: null, stop_reason: null, attempts: 0 })) };
      await save(); event('auto_refresh_start');
      const deadline = at(date, config.time) + BUSY_DEADLINE_MINUTES * 60_000;
      let targets = last.districts, abort = false;
      for (let round = 0; round <= MAX_RETRY_ROUNDS && !abort; round++) {
        if (round) {
          if (!await wait(RETRY_INTERVAL_MS)) return;
          last.retry_round = round; await save(); event('auto_refresh_retry');
        }
        for (let i = 0; i < targets.length; i++) {
          const d = targets[i];
          let started;
          while (active) {
            const busy = await launcher.isBusy();
            if (!active) return;
            if (!busy) {
              try { started = await launcher.start({ scope: `district:${d.id}`, trigger: 'schedule' }); }
              catch { started = { started: false, error: 'start_failed' }; }
              if (started.started || started.error !== 'refresh_in_progress') break;
            }
            event('auto_refresh_busy', { id: d.id });
            if (now().getTime() >= deadline) {
              for (const remaining of targets.slice(i)) {
                remaining.status = 'skipped_busy'; districtEvent(remaining);
              }
              abort = true; break;
            }
            if (!await wait(Math.min(BUSY_INTERVAL_MS, deadline - now().getTime()))) return;
          }
          if (!active) return;
          if (abort) break;
          d.attempts++;
          if (!started.started) {
            d.status = started.error === 'empty_scope' ? 'skipped_empty' : 'stopped';
            d.stop_reason = d.status === 'stopped' ? 'process:StartFailed' : null;
          } else {
            const completion = Promise.resolve(started.done).catch(() => ({ status: 'stopped', stop_reason: 'process:Exited' }));
            // Persist pending before awaiting the child, allowing restart recovery.
            d.status = 'pending'; await save();
            const done = await completion;
            d.status = done.status === 'completed' ? 'completed' : 'stopped';
            d.run_id = done.run_id ?? null; d.stop_reason = safeStopReason(done.stop_reason);
          }
          districtEvent(d);
          if (needsLogin(d.stop_reason)) {
            for (const remaining of last.districts) {
              if (remaining !== d && (remaining.status === 'pending' || targets.slice(i + 1).includes(remaining))) {
                remaining.status = 'not_run_login'; districtEvent(remaining);
              }
            }
            abort = true;
          }
          await save();
          if (!active) return;
          if (abort) break;
        }
        targets = last.districts.filter(d => d.status === 'stopped');
        if (!targets.length) break;
      }
      last.result = result(); last.finished_at = now().toISOString(); await save();
      event('auto_refresh_done', { status: last.result });
    } catch {
      // Do not log exception text: upstream errors may contain private URLs.
      if (last?.date === date) {
        for (const d of last.districts) if (d.status === 'pending') {
          d.status = 'stopped'; d.stop_reason = 'process:SchedulerError';
        }
        last.result = last.districts.some(d => d.status === 'completed') ? 'partial' : 'failed';
        last.finished_at = now().toISOString();
        await save().catch(() => {});
      }
      event('auto_refresh_done', { status: 'failed' });
    } finally { running = false; scheduleNext(); }
  };
  return {
    async start() {
      if (!config.enabled || active || running) return;
      active = true;
      let contents;
      last = null;
      try { contents = await readFile(filename, 'utf8'); }
      catch (error) {
        if (error.code !== 'ENOENT') {
          active = false; event('auto_refresh_done', { status: 'failed' }); return;
        }
      }
      if (contents !== undefined) {
        try {
          const parsed = JSON.parse(contents);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
            || typeof parsed.date !== 'string' || !parsed.date || !Array.isArray(parsed.districts)) {
            throw new Error('Invalid status');
          }
          last = parsed;
        } catch { event('auto_refresh_status_invalid'); }
      }
      if (!active) return;
      const p = local(now());
      if (last?.date === p.date && last.result === 'running') {
        for (const d of last.districts) if (d.status === 'pending') {
          d.status = 'stopped'; d.stop_reason = 'worker:Restarted'; districtEvent(d);
        }
        last.result = last.districts.some(d => d.status === 'completed') ? 'partial' : 'failed';
        last.finished_at = now().toISOString(); await save();
        event('auto_refresh_done', { status: last.result });
      }
      if (last?.date !== p.date && p.time >= config.time && p.time < CATCHUP_CUTOFF) {
        next = new Date(now().getTime() + CATCHUP_DELAY_MS).toISOString();
        arm(Date.parse(next), () => run(p.date));
      } else scheduleNext();
    },
    stop() {
      active = false; next = null;
      if (timer !== undefined) clearTimeoutImpl(timer);
      timer = undefined; cancelWait?.(); cancelWait = undefined;
    },
    status() { return { enabled: config.enabled, time: config.time, time_zone: config.time_zone,
      next_run_at: next, last: last === null ? null : structuredClone(last) }; },
  };
}
