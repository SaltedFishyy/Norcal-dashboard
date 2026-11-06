// Route profiles and quotation matching use the same active snapshot payload.
export async function readActiveRouteProfiles(client, station) {
  const filter = station === undefined ? '' : ' WHERE station_code=$1';
  return (await client.query(`SELECT route_id,route_name,station_code,profile
    FROM v_active_routes${filter} ORDER BY station_code,ordinal`, station === undefined ? [] : [station])).rows;
}
