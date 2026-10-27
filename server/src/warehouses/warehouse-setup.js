// Worker (3100) warehouse write setup only (D18).
import { createWarehouseStore } from './warehouse-store.js';

export class WarehousePrivilegeError extends Error {
  constructor() { super('仓库写入账号权限过大，拒绝启动。'); this.name = 'WarehousePrivilegeError'; }
}
export function excessivePrivileges(result) {
  return !result.ok && result.problems.some(code => code !== 'missing_warehouse_privilege');
}
export async function setupWarehouses({ env = process.env, port,
  log = () => {}, createStore = createWarehouseStore } = {}) {
  let store = null, writeEnabled = false;
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (env.NC_DB_WAREHOUSE_URL) {
    try {
      store = createStore({ env });
      const result = await store.checkPrivileges();
      if (excessivePrivileges(result)) throw new WarehousePrivilegeError();
      if (!result.ok) log('仓库写入未开启：数据库未就绪或权限不足。');
      else writeEnabled = env.DATA_SOURCE === 'db' && hosts.length > 0;
    } catch (error) {
      await store?.close().catch(() => {}); store = null;
      if (error instanceof WarehousePrivilegeError) throw error;
      log('仓库写入未开启：数据库未就绪或权限不足。');
    }
  }
  if (!writeEnabled && store) { await store.close(); store = null; }
  return { store, writeEnabled, allowedHosts: () => hosts, close: async () => { await store?.close(); } };
}
