SET LOCAL search_path TO {{schema}};
DROP VIEW v_warehouses;
ALTER TABLE warehouses DROP COLUMN warehouse_name;
CREATE VIEW v_warehouses AS
  SELECT id, address, district_id, station_id, latitude, longitude, created_at, updated_at FROM warehouses;
REVOKE ALL ON v_warehouses FROM PUBLIC;
GRANT SELECT ON v_warehouses TO {{reader_role}}, {{warehouse_role}};
