import { connectDb } from '../src/db/connection.js';
import { importDistricts } from '../src/db/district-import.js';

let client;
try {
  client = await connectDb('NC_DB_OWNER_URL');
  const counts = await importDistricts({ client });
  for (const [name, count] of Object.entries(counts)) console.log(`${name}: ${count}`);
} catch (error) {
  // Driver errors can expose connection or authentication data.
  console.error('district import: failed');
  if (/^[0-9A-Z]{5}$/.test(error.code)) console.error(`SQLSTATE: ${error.code}`);
  process.exitCode = 1;
} finally {
  if (client) await client.end();
}
