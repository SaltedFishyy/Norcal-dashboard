SET LOCAL search_path TO {{schema}};

CREATE TABLE warehouses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_name text NOT NULL CHECK (length(btrim(warehouse_name)) > 0 AND length(warehouse_name) <= 120),
  address text NOT NULL CHECK (length(btrim(address)) > 0 AND length(address) <= 300),
  address_key text NOT NULL,
  district_id text NOT NULL CHECK (district_id ~ '^[a-z0-9-]{1,32}$'),
  station_id text CHECK (station_id ~ '^[A-Z]{3}\d{2}$'),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX warehouses_address_key_idx ON warehouses (address_key);
CREATE INDEX warehouses_district_id_idx ON warehouses (district_id);

CREATE VIEW v_warehouses AS
  SELECT id, warehouse_name, address, district_id, station_id, latitude, longitude, created_at, updated_at
  FROM warehouses;

REVOKE ALL ON warehouses, v_warehouses FROM PUBLIC;
GRANT USAGE ON SCHEMA {{schema}} TO {{warehouse_role}};
GRANT SELECT ON v_warehouses TO {{reader_role}}, {{warehouse_role}};
GRANT SELECT, INSERT, DELETE ON warehouses TO {{warehouse_role}};
GRANT UPDATE (warehouse_name, address, address_key, district_id, station_id, latitude, longitude, updated_at)
  ON warehouses TO {{warehouse_role}};
