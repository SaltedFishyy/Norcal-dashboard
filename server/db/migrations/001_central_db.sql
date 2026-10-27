SET LOCAL search_path TO {{schema}};

CREATE TABLE stations (
  code text PRIMARY KEY CHECK (code ~ '^[A-Z]{3}\d{2}$'),
  active_snapshot_id bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE scrape_runs (
  id uuid PRIMARY KEY,
  trigger text NOT NULL CHECK (trigger IN ('cli', 'json_import')),
  json_run_id text, app_version text,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'stopped', 'abandoned')),
  requested_stations text[] NOT NULL, options jsonb NOT NULL,
  started_at timestamptz NOT NULL, finished_at timestamptz,
  prod_api_requests int, request_cap int, stop_reason text,
  original_station_restored boolean, import_digest text
);
CREATE UNIQUE INDEX one_running_run ON scrape_runs ((true)) WHERE status = 'running';
CREATE TABLE station_snapshots (
  id bigserial PRIMARY KEY, station_code text NOT NULL REFERENCES stations(code),
  run_id uuid NOT NULL REFERENCES scrape_runs(id),
  status text NOT NULL CHECK (status IN ('pending', 'active', 'superseded', 'rejected')),
  origin text NOT NULL CHECK (origin IN ('dms', 'json_import')),
  fetched_at text NOT NULL, source_as_of text, source text NOT NULL, total int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), activated_at timestamptz,
  superseded_at timestamptz, rejected_reason text
);
CREATE UNIQUE INDEX one_active_per_station ON station_snapshots (station_code) WHERE status = 'active';
ALTER TABLE stations ADD FOREIGN KEY (active_snapshot_id) REFERENCES station_snapshots(id);
CREATE TABLE scrape_run_stations (
  run_id uuid REFERENCES scrape_runs(id), station_code text,
  status text NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed', 'limited', 'stopped')),
  route_total int, success_count int NOT NULL, cached_count int NOT NULL, failed_count int NOT NULL,
  request_count int, started_at timestamptz, ended_at timestamptz, stop_reason text,
  integrity jsonb, snapshot_id bigint REFERENCES station_snapshots(id),
  PRIMARY KEY (run_id, station_code)
);
CREATE TABLE route_detail_versions (
  id bigserial PRIMARY KEY, route_id bigint NOT NULL, station_code text NOT NULL,
  run_id uuid NOT NULL REFERENCES scrape_runs(id),
  origin text NOT NULL CHECK (origin IN ('dms', 'json_import')),
  status text NOT NULL CHECK (status IN ('pending', 'committed')),
  fetched_at text NOT NULL, detail jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), committed_at timestamptz
);
CREATE TABLE snapshot_routes (
  snapshot_id bigint REFERENCES station_snapshots(id), route_id bigint,
  ordinal int NOT NULL, route_name text NOT NULL, profile jsonb NOT NULL,
  detail_version_id bigint REFERENCES route_detail_versions(id),
  PRIMARY KEY (snapshot_id, route_id), UNIQUE (snapshot_id, ordinal), UNIQUE (snapshot_id, route_name)
);
CREATE TABLE snapshot_route_zips (
  snapshot_id bigint, route_id bigint, postal_code text CHECK (postal_code ~ '^\d{5}$'), ordinal int NOT NULL,
  PRIMARY KEY (snapshot_id, route_id, postal_code), UNIQUE (snapshot_id, postal_code),
  FOREIGN KEY (snapshot_id, route_id) REFERENCES snapshot_routes(snapshot_id, route_id)
);
CREATE TABLE route_detail_zips (
  detail_version_id bigint REFERENCES route_detail_versions(id), ordinal int,
  postal_code text, zip jsonb NOT NULL, PRIMARY KEY (detail_version_id, ordinal)
);

CREATE VIEW v_active_snapshots AS
  SELECT station_code, fetched_at, source_as_of, source, total
  FROM station_snapshots WHERE status = 'active';
CREATE VIEW v_active_routes AS
  SELECT s.station_code, r.snapshot_id, r.route_id, r.ordinal, r.route_name,
         r.profile - 'raw' AS profile, r.detail_version_id
  FROM snapshot_routes r JOIN station_snapshots s ON s.id = r.snapshot_id
  WHERE s.status = 'active' ORDER BY s.station_code, r.ordinal;
CREATE VIEW v_route_details AS
  SELECT DISTINCT ON (route_id) id, route_id, station_code, run_id, origin, status,
         fetched_at, detail - 'capacity_raw' AS detail, created_at, committed_at
  FROM route_detail_versions WHERE status = 'committed'
  ORDER BY route_id, committed_at DESC NULLS LAST, id DESC;
CREATE VIEW v_route_detail_zips AS
  SELECT d.route_id, z.detail_version_id, z.ordinal, z.postal_code, z.zip - 'raw' AS zip
  FROM route_detail_zips z JOIN v_route_details d ON d.id = z.detail_version_id
  ORDER BY d.route_id, z.ordinal;
CREATE VIEW v_runs AS
  SELECT id, trigger, json_run_id, app_version, status, requested_stations,
         (SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
          FROM jsonb_each(options) WHERE key IN ('refresh', 'max_routes_per_station', 'new_run')) AS options,
         started_at, finished_at, prod_api_requests, request_cap, stop_reason, original_station_restored
  FROM scrape_runs;

REVOKE ALL ON SCHEMA {{schema}} FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA {{schema}} FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA {{schema}} FROM PUBLIC;
GRANT USAGE ON SCHEMA {{schema}} TO {{scraper_role}}, {{reader_role}};
GRANT SELECT ON ALL TABLES IN SCHEMA {{schema}} TO {{scraper_role}};
GRANT INSERT ON stations, scrape_runs, scrape_run_stations, station_snapshots,
  snapshot_routes, snapshot_route_zips, route_detail_versions, route_detail_zips TO {{scraper_role}};
GRANT UPDATE (active_snapshot_id) ON stations TO {{scraper_role}};
GRANT UPDATE (status, finished_at, prod_api_requests, request_cap, stop_reason, original_station_restored)
  ON scrape_runs TO {{scraper_role}};
GRANT UPDATE (status, route_total, success_count, cached_count, failed_count, request_count,
  started_at, ended_at, stop_reason, integrity, snapshot_id) ON scrape_run_stations TO {{scraper_role}};
GRANT UPDATE (status, activated_at, superseded_at, rejected_reason) ON station_snapshots TO {{scraper_role}};
GRANT UPDATE (status, committed_at) ON route_detail_versions TO {{scraper_role}};
GRANT USAGE ON ALL SEQUENCES IN SCHEMA {{schema}} TO {{scraper_role}};
GRANT SELECT ON v_active_snapshots, v_active_routes, v_route_details, v_route_detail_zips, v_runs TO {{reader_role}};
