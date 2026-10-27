const updateColumns = ['warehouse_name', 'address', 'address_key', 'district_id', 'station_id',
  'latitude', 'longitude', 'updated_at'];
const writes = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'];

async function relations(client, schema) {
  return (await client.query(`SELECT c.oid, c.relname, c.relkind,
    c.relowner = (SELECT oid FROM pg_roles WHERE rolname=current_user) AS owned
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1`, [schema])).rows;
}
async function tablePrivilege(client, oid, privilege) {
  return (await client.query('SELECT has_table_privilege(current_user, $1::oid, $2) AS allowed',
    [oid, privilege])).rows[0].allowed;
}
async function columns(client, oid) {
  return (await client.query(`SELECT attname,
    has_column_privilege(current_user, attrelid, attnum, 'SELECT') AS sel,
    has_column_privilege(current_user, attrelid, attnum, 'INSERT') AS ins,
    has_column_privilege(current_user, attrelid, attnum, 'UPDATE') AS upd
    FROM pg_attribute WHERE attrelid=$1::oid AND attnum>0 AND NOT attisdropped`, [oid])).rows;
}
const result = problems => ({ ok: problems.size === 0, problems: [...problems] });

export async function checkWarehousePrivileges(client, { schema }) {
  const problems = new Set();
  const role = (await client.query(`SELECT oid, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls,
    rolreplication FROM pg_roles WHERE rolname=current_user`)).rows[0];
  if (role.rolsuper) problems.add('superuser');
  if (role.rolcreaterole || role.rolcreatedb || role.rolbypassrls || role.rolreplication)
    problems.add('role_attribute');
  if ((await client.query('SELECT 1 FROM pg_auth_members WHERE member=$1', [role.oid])).rowCount)
    problems.add('role_membership');
  const namespaces = (await client.query(`SELECT nspowner=$2::oid AS owned,
    has_schema_privilege(current_user, oid, 'CREATE') AS can_create
    FROM pg_namespace WHERE nspname IN ($1, 'public')`, [schema, role.oid])).rows;
  if (namespaces.some(n => n.owned)) problems.add('owns_objects');
  if (namespaces.some(n => n.can_create)) problems.add('schema_create');
  const database = (await client.query(`SELECT
    has_database_privilege(current_user, current_database(), 'CREATE') AS can_create,
    has_database_privilege(current_user, current_database(), 'TEMP') AS can_temp`)).rows[0];
  if (database.can_create) problems.add('database_create');
  if (database.can_temp) problems.add('database_temp');
  const objects = await relations(client, schema);
  if (objects.some(r => r.owned)) problems.add('owns_objects');
  if (!objects.some(r => r.relname === 'warehouses') || !objects.some(r => r.relname === 'v_warehouses'))
    problems.add('missing_warehouse_privilege');
  for (const relation of objects) {
    if (relation.relkind === 'S') {
      const row = (await client.query(`SELECT has_sequence_privilege(current_user,$1::oid,'USAGE') OR
        has_sequence_privilege(current_user,$1::oid,'UPDATE') AS allowed`, [relation.oid])).rows[0];
      if (row.allowed) problems.add('sequence_privilege');
      continue;
    }
    if (!['r', 'v', 'm', 'p', 'f'].includes(relation.relkind)) continue;
    const cols = await columns(client, relation.oid);
    if (relation.relname === 'warehouses') {
      for (const privilege of ['SELECT', 'INSERT', 'DELETE'])
        if (!await tablePrivilege(client, relation.oid, privilege)) problems.add('missing_warehouse_privilege');
      for (const name of updateColumns)
        if (!cols.some(c => c.attname === name && c.upd)) problems.add('missing_warehouse_privilege');
      if (cols.some(c => c.upd && !updateColumns.includes(c.attname))) problems.add('extra_warehouse_privilege');
      for (const privilege of ['TRUNCATE', 'REFERENCES', 'TRIGGER'])
        if (await tablePrivilege(client, relation.oid, privilege)) problems.add('extra_warehouse_privilege');
    } else {
      const view = relation.relname === 'v_warehouses';
      if (view && !await tablePrivilege(client, relation.oid, 'SELECT')) problems.add('missing_warehouse_privilege');
      for (const privilege of view ? [...writes, 'REFERENCES', 'TRIGGER'] : writes)
        if (await tablePrivilege(client, relation.oid, privilege))
          problems.add(view ? 'extra_warehouse_privilege' : 'other_relation_write');
      if (cols.some(c => c.ins || c.upd)) problems.add(view ? 'extra_warehouse_privilege' : 'other_relation_write');
    }
  }
  return result(problems);
}

export async function checkReaderWarehouseIsolation(client) {
  // The connection's search_path selects the same schema used by the reader data source.
  const rows = (await client.query(`SELECT to_regclass('warehouses')::oid AS base,
    to_regclass('v_warehouses')::oid AS view`)).rows[0];
  const problems = new Set();
  if (!rows.view || !await tablePrivilege(client, rows.view, 'SELECT')) problems.add('missing_warehouse_privilege');
  if (!rows.base) problems.add('missing_warehouse_privilege');
  else {
    for (const privilege of ['SELECT', ...writes])
      if (await tablePrivilege(client, rows.base, privilege)) problems.add('extra_warehouse_privilege');
    if ((await columns(client, rows.base)).some(c => c.sel || c.ins || c.upd)) problems.add('extra_warehouse_privilege');
  }
  return result(problems);
}
