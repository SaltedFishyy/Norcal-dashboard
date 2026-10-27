import pg from 'pg';

export function dbConfig(variable, { schema = 'nc', env = process.env } = {}) {
  const value = env[variable];
  try {
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname
      || !url.username || !url.pathname || url.pathname === '/') throw new Error();
  } catch {
    throw new Error('数据库连接配置缺失或无效，请检查本地环境变量。');
  }
  // search_path is set separately with an escaped identifier, never as a URL option.
  return { connectionString: value, connectionTimeoutMillis: 5000, schema };
}

export async function connectDb(variable, options) {
  const { schema, ...config } = dbConfig(variable, options);
  const client = new pg.Client(config);
  try {
    await client.connect();
    await client.query(`SET search_path TO ${pg.escapeIdentifier(schema)}`);
    return client;
  } catch {
    await client.end().catch(() => {});
    throw new Error('数据库连接失败，请检查本地配置和数据库服务。');
  }
}
