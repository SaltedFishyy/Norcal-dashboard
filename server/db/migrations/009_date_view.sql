SET LOCAL search_path TO {{schema}};

CREATE VIEW v_daily_snapshots AS
  SELECT DISTINCT ON (station_code, (coalesce(activated_at, created_at) AT TIME ZONE 'America/Los_Angeles')::date)
         station_code AS station,
         (coalesce(activated_at, created_at) AT TIME ZONE 'America/Los_Angeles')::date AS day,
         id AS snapshot_id, coalesce(activated_at, created_at) AS snapshot_at,
         fetched_at, source_as_of, total, source
  FROM station_snapshots
  WHERE status IN ('active', 'superseded')
  ORDER BY station_code, day, coalesce(activated_at, created_at) DESC, id DESC;

CREATE OR REPLACE VIEW v_route_history_daily AS
  SELECT s.day, s.station AS station, s.snapshot_id AS snapshot_id, s.snapshot_at,
         r.route_id, r.route_name, r.profile->>'dsp_name' AS dsp_name,
         CASE WHEN jsonb_typeof(r.profile->'pickup_volume') = 'number'
              THEN (r.profile->>'pickup_volume')::numeric END AS pickup_volume,
         CASE WHEN jsonb_typeof(r.profile->'pph') = 'number'
              THEN (r.profile->>'pph')::numeric END AS pph,
         CASE WHEN jsonb_typeof(r.profile->'first_mile_distance') = 'number'
              THEN (r.profile->>'first_mile_distance')::numeric END AS first_mile_distance,
         CASE WHEN jsonb_typeof(r.profile->'postal_codes') = 'array'
              THEN jsonb_array_length(r.profile->'postal_codes') END AS zip_count,
         r.profile->>'route_difficulty' AS route_difficulty,
         CASE WHEN jsonb_typeof(r.profile->'postal_codes') = 'array'
              THEN ARRAY(SELECT jsonb_array_elements_text(r.profile->'postal_codes')) END AS postal_codes
  FROM v_daily_snapshots s JOIN snapshot_routes r ON r.snapshot_id = s.snapshot_id;

CREATE VIEW v_daily_snapshot_routes AS
  SELECT s.day, s.station, s.snapshot_id, r.route_id, r.ordinal, r.route_name,
         r.profile - 'raw' AS profile, r.detail_version_id
  FROM v_daily_snapshots s JOIN snapshot_routes r ON r.snapshot_id = s.snapshot_id;

CREATE VIEW v_route_detail_versions AS
  SELECT id, route_id, station_code, run_id, origin, status,
         fetched_at, detail - 'capacity_raw' AS detail, created_at, committed_at
  FROM route_detail_versions WHERE status = 'committed';

CREATE VIEW v_route_detail_version_zips AS
  SELECT d.route_id, z.detail_version_id, z.ordinal, z.postal_code, z.zip - 'raw' AS zip
  FROM route_detail_zips z JOIN v_route_detail_versions d ON d.id = z.detail_version_id
  ORDER BY d.route_id, z.ordinal;

REVOKE ALL ON v_daily_snapshots, v_daily_snapshot_routes,
  v_route_detail_versions, v_route_detail_version_zips FROM PUBLIC;
GRANT SELECT ON v_daily_snapshots, v_daily_snapshot_routes,
  v_route_detail_versions, v_route_detail_version_zips TO {{scraper_role}}, {{reader_role}};
