SET LOCAL search_path TO {{schema}};

ALTER TABLE scrape_runs DROP CONSTRAINT scrape_runs_trigger_check;
ALTER TABLE scrape_runs ADD CONSTRAINT scrape_runs_trigger_check CHECK (trigger IN ('cli', 'ui', 'schedule', 'json_import'));

CREATE VIEW v_route_history_daily AS
  WITH daily_snapshots AS (
    SELECT DISTINCT ON (station_code, (coalesce(activated_at, created_at) AT TIME ZONE 'America/Los_Angeles')::date)
           id, station_code,
           (coalesce(activated_at, created_at) AT TIME ZONE 'America/Los_Angeles')::date AS day,
           coalesce(activated_at, created_at) AS snapshot_at
    FROM station_snapshots
    WHERE status IN ('active', 'superseded')
    ORDER BY station_code, day, coalesce(activated_at, created_at) DESC, id DESC
  )
  SELECT s.day, s.station_code AS station, s.id AS snapshot_id, s.snapshot_at,
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
  FROM daily_snapshots s JOIN snapshot_routes r ON r.snapshot_id = s.id;

CREATE INDEX IF NOT EXISTS snapshot_routes_route_id_idx ON snapshot_routes (route_id);

REVOKE ALL ON v_route_history_daily FROM PUBLIC;
GRANT SELECT ON v_route_history_daily TO {{scraper_role}}, {{reader_role}};
