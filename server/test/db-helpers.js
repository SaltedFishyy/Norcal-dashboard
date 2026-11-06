import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { connectDb } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';

export const dbSkip = ['OWNER', 'SCRAPER', 'READER', 'WAREHOUSE', 'DISTRICT', 'QUOTATION'].every(role => process.env[`NC_TEST_DB_${role}_URL`])
  ? false : '未配置 NC_TEST_DB_*';

export async function createTestDb(t) {
  const schema = `nc_t_${randomBytes(12).toString('hex')}`;
  const clients = {};
  t.after(async () => {
    try {
      if (clients.owner) await clients.owner.query(`DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(schema)} CASCADE`);
    } finally {
      await Promise.all(Object.values(clients).map(client => client.end()));
    }
  });
  clients.owner = await connectDb('NC_TEST_DB_OWNER_URL', { schema });
  // Refuse accidental production credentials without displaying the URL or database name.
  const database = await clients.owner.query('SELECT current_database() AS name');
  if (database.rows[0].name !== 'nc_ops_test') {
    await clients.owner.end();
    delete clients.owner;
    throw new Error('DB 测试只允许使用 nc_ops_test。');
  }
  const options = { schema, scraperRole: 'nc_test_scraper', readerRole: 'nc_test_reader', warehouseRole: 'nc_test_warehouse', districtRole: 'nc_test_district', quotationRole: 'nc_test_quotation' };
  const firstMigration = await migrate(clients.owner, options);
  for (const role of ['scraper', 'reader', 'warehouse', 'district', 'quotation']) {
    clients[role] = await connectDb(`NC_TEST_DB_${role.toUpperCase()}_URL`, { schema });
    const identity = await clients[role].query('SELECT current_database() AS name, current_user AS role');
    if (identity.rows[0].name !== 'nc_ops_test' || identity.rows[0].role !== `nc_test_${role}`)
      throw new Error('DB 测试角色配置无效。');
  }
  return { ...clients, schema, options, firstMigration };
}
