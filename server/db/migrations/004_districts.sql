SET LOCAL search_path TO {{schema}};

CREATE TABLE known_stations (
  code text PRIMARY KEY CHECK (code ~ '^[A-Z]{3}\d{2}$'),
  scrape_disabled_reason text CHECK (scrape_disabled_reason IN ('not_in_dms_menu', 'no_permission', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE districts (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9-]{1,32}$' AND id <> 'unassigned'),
  name_zh text NOT NULL CHECK (length(btrim(name_zh)) > 0),
  name_en text NOT NULL CHECK (length(btrim(name_en)) > 0),
  ordinal int NOT NULL UNIQUE
);
CREATE TABLE district_stations (
  station_code text PRIMARY KEY REFERENCES known_stations(code),
  district_id text NOT NULL REFERENCES districts(id),
  ordinal int NOT NULL
);
CREATE TABLE district_config_version (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  version bigint NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE VIEW v_known_stations AS SELECT code, scrape_disabled_reason FROM known_stations;
CREATE VIEW v_districts AS SELECT id, name_zh, name_en, ordinal FROM districts;
CREATE VIEW v_district_stations AS SELECT station_code, district_id, ordinal FROM district_stations;
CREATE VIEW v_district_config_version AS SELECT version, updated_at FROM district_config_version;

REVOKE ALL ON known_stations, districts, district_stations, district_config_version,
  v_known_stations, v_districts, v_district_stations, v_district_config_version FROM PUBLIC;
GRANT USAGE ON SCHEMA {{schema}} TO {{district_role}};
GRANT SELECT ON v_known_stations, v_districts, v_district_stations, v_district_config_version
  TO {{reader_role}}, {{scraper_role}}, {{district_role}};
GRANT SELECT ON v_districts, v_district_stations TO {{warehouse_role}};
GRANT SELECT, DELETE ON district_stations TO {{district_role}};
GRANT INSERT (station_code, district_id, ordinal), UPDATE (district_id, ordinal)
  ON district_stations TO {{district_role}};
GRANT SELECT, UPDATE (version, updated_at) ON district_config_version TO {{district_role}};
