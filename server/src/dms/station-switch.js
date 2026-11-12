export class StationSwitchError extends Error {
  constructor(reason = 'Station switch failed', options) { super(reason, options); this.name = 'StationSwitchError'; }
}
export class StationNotInMenuError extends StationSwitchError {
  constructor(station) { super(`Station ${station} not in DMS menu`); this.name = 'StationNotInMenuError'; }
}
export class StationMismatchError extends Error {
  constructor() { super('Station identity mismatch'); this.name = 'StationMismatchError'; }
}
const headerSelector = 'header .dbu-web-main-dropdown-trigger span.groupCheck';
const listPath = '/roadAreaPortrait/home/frontPage/queryList/pagination';
const safetyErrors = ['NeedsLoginError', 'CircuitBreakerError', 'LoadLimitError', 'InterruptedError'];
export async function readCurrentStation({ page, guarded }, { timeout = 5000 } = {}) {
  const label = page.locator(headerSelector);
  try { await guarded(() => label.waitFor({ state: 'visible', timeout })); }
  catch (error) {
    if (safetyErrors.includes(error.name)) throw error;
    throw new StationSwitchError('严格检查页头未就绪', { cause: error });
  }
  const count = await guarded(() => label.count());
  if (count !== 1) throw new StationSwitchError(`页头 Station 数量为 ${count}`);
  const station = (await guarded(() => label.innerText({ timeout }))).trim();
  if (!/^[A-Z]{3}\d{2}$/.test(station)) throw new StationSwitchError('页头 Station 格式无效');
  return station;
}
// Reloading may temporarily remove, duplicate or repaint the header.
export async function waitForHeaderStation(context, options = {}) {
  return waitForHeaderValue(context, options);
}
const originPattern = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/;
export async function readHeaderOrigin(context, options = {}) {
  const value = await waitForHeaderValue(context, { ...options, allowLabel: true });
  return { kind: /^[A-Z]{3}\d{2}$/.test(value) ? 'station' : 'label', value };
}
async function waitForHeaderValue({ page, guarded }, { station, timeout = 30000, allowLabel = false } = {}) {
  const deadline = Date.now() + timeout;
  let reason = '页头未就绪', cause;
  for (let poll = 0; poll <= Math.ceil(timeout / 200) && Date.now() <= deadline; poll++) {
    try {
      const label = page.locator(headerSelector);
      const count = await guarded(() => label.count());
      reason = `页头未就绪，Station 数量为 ${count}`;
      if (count === 1 && await guarded(() => label.isVisible())) {
        const value = (await guarded(() => label.innerText({ timeout: Math.max(1, Math.min(200, deadline - Date.now())) }))).trim();
        if ((allowLabel ? originPattern : /^[A-Z]{3}\d{2}$/).test(value)) {
          if (!station || value === station) return value;
          reason = `页头 Station 未变为 ${station}，当前为 ${value}`;
        } else reason = '页头未就绪，Station 格式无效';
      }
      cause = undefined;
    } catch (error) {
      if (safetyErrors.includes(error.name) || page.isClosed()) throw error;
      cause = error; reason = '页头未就绪，读取失败';
    }
    if (poll < Math.ceil(timeout / 200) && Date.now() < deadline) await guarded(() => page.waitForTimeout(Math.min(200, deadline - Date.now())));
  }
  throw new StationSwitchError(reason, cause ? { cause } : undefined);
}
export async function assertCurrentStation(context, station) {
  if (await readCurrentStation(context) !== station) throw new StationMismatchError();
}
export async function switchStation(context, station) {
  const { page, guarded } = context;
  let phase = '等待当前页头';
  try {
    context.automaticListSeen = false;
    const { value: original } = await readHeaderOrigin(context);
    if (original === station) return false;
    phase = '打开 Station 菜单';
    const trigger = page.locator('header .dbu-web-main-dropdown-trigger').filter({ has: page.locator('span.groupCheck') });
    const triggerCount = await guarded(() => trigger.count());
    if (triggerCount !== 1) throw new StationSwitchError(`Station trigger 数量为 ${triggerCount}`);
    await guarded(() => trigger.click({ timeout: 30000 }));
    const item = page.locator('li.dbu-web-main-dropdown-menu-item').filter({ hasText: new RegExp(`^\\s*${station}\\s*$`) });
    const itemCount = await guarded(() => item.count());
    if (itemCount === 0) {
      const visibleItems = page.locator('li.dbu-web-main-dropdown-menu-item:visible');
      const visibleStations = visibleItems.filter({ hasText: /^\s*[A-Z]{3}\d{2}\s*$/ });
      if (await guarded(() => visibleStations.count()) > 0) {
        phase = '关闭 Station 菜单';
        await guarded(() => trigger.click({ timeout: 30000 }));
        await guarded(() => visibleItems.first().waitFor({ state: 'hidden', timeout: 5000 }));
        if (await guarded(() => visibleItems.count()) !== 0 || (await readHeaderOrigin(context)).value !== original)
          throw new StationSwitchError('Station 菜单未关闭或页头发生变化');
        throw new StationNotInMenuError(station);
      }
    }
    if (itemCount !== 1) throw new StationSwitchError(`Station ${station} 菜单项数量为 ${itemCount}`);
    // Observe both promises before clicking, including when one rejects first.
    const switched = page.waitForResponse(response => response.request().method() === 'GET'
      && /\/prod-api\/switch-org\/[^/]+$/.test(new URL(response.url()).pathname), { timeout: 30000 });
    const listed = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(listPath)
      && response.request().method() === 'POST', { timeout: 30000 });
    switched.catch(() => {});
    const observedList = listed.then(response => { context.automaticListSeen = true; return { response }; }, error => ({ error }));
    phase = 'switch-org';
    await guarded(() => item.click({ timeout: 30000 }));
    const response = await guarded(() => switched);
    if (response.status() !== 200) throw new StationSwitchError(`switch-org 状态码 ${response.status()}`);
    phase = '等待页面重载';
    try { await guarded(() => page.waitForLoadState('networkidle', { timeout: 30000 })); }
    catch (error) { if (error.name !== 'TimeoutError') throw error; }
    phase = '等待目标页头';
    await waitForHeaderStation(context, { station });
    phase = '自动列表';
    const observation = await guarded(() => observedList);
    if (observation.error) {
      if (observation.error.name !== 'TimeoutError') throw observation.error;
      return true;
    }
    const automatic = observation.response;
    context.automaticListSeen = true;
    if (automatic.status() !== 200) throw new StationSwitchError(`自动列表状态码 ${automatic.status()}`);
    const value = await guarded(() => automatic.json());
    if (!(value?.success === true || value?.code === 200)) throw new StationSwitchError('自动列表响应未成功');
    return true;
  } catch (error) {
    if (safetyErrors.includes(error.name) || error instanceof StationSwitchError) throw error;
    throw new StationSwitchError(`${phase}失败`, { cause: error });
  }
}

// Organization labels have no verified switch-org contract; confirm the exact header instead.
export async function restoreHeaderOrigin(context, origin) {
  if (origin.kind === 'station') {
    await switchStation(context, origin.value);
    return await readCurrentStation(context) === origin.value;
  }
  if (!originPattern.test(origin.value)) throw new StationSwitchError('原页头标签格式无效');
  const { page, guarded } = context;
  const trigger = page.locator('header .dbu-web-main-dropdown-trigger').filter({ has: page.locator('span.groupCheck') });
  if (await guarded(() => trigger.count()) !== 1) throw new StationSwitchError('Station trigger 数量无效');
  await guarded(() => trigger.click({ timeout: 30000 }));
  const escaped = origin.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const item = page.locator('li.dbu-web-main-dropdown-menu-item').filter({ hasText: new RegExp(`^\\s*${escaped}\\s*$`) });
  if (await guarded(() => item.count()) !== 1) throw new StationSwitchError('原页头标签菜单项数量无效');
  await guarded(() => item.click({ timeout: 30000 }));
  await waitForHeaderValue(context, { station: origin.value, allowLabel: true });
  return true;
}
