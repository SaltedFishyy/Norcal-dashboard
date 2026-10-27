import { connectDb } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';

let client;
try {
  client = await connectDb('NC_DB_OWNER_URL');
  await migrate(client, { onResult: ({ version, result }) => console.log(`${version}: ${result}`) });
} catch (error) {
  // Never print driver errors: they can contain connection or authentication data.
  console.error('migration: failed');
  if (/^[0-9A-Z]{5}$/.test(error.code)) console.error(`SQLSTATE: ${error.code}`);
  process.exitCode = 1;
} finally {
  if (client) await client.end();
}
