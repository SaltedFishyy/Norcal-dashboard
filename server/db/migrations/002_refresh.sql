SET LOCAL search_path TO {{schema}};

ALTER TABLE scrape_runs DROP CONSTRAINT scrape_runs_trigger_check;
ALTER TABLE scrape_runs ADD CONSTRAINT scrape_runs_trigger_check CHECK (trigger IN ('cli', 'ui', 'json_import'));
ALTER TABLE scrape_runs ADD COLUMN scope jsonb;

DROP VIEW v_runs;
CREATE VIEW v_runs AS
  SELECT r.id, r.trigger, r.status, r.requested_stations,
         (SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
          FROM jsonb_each(r.options) WHERE key IN ('refresh', 'max_routes_per_station', 'new_run')) AS options,
         r.started_at, r.finished_at, r.prod_api_requests, r.request_cap, r.stop_reason,
         r.original_station_restored, r.scope,
         jsonb_build_object(
           'completed', (SELECT count(*) FROM scrape_run_stations s WHERE s.run_id=r.id AND s.status='completed'),
           'limited', (SELECT count(*) FROM scrape_run_stations s WHERE s.run_id=r.id AND s.status='limited'),
           'stopped', (SELECT count(*) FROM scrape_run_stations s WHERE s.run_id=r.id AND s.status='stopped'),
           'pending', (SELECT count(*) FROM scrape_run_stations s WHERE s.run_id=r.id AND s.status='pending'),
           'in_progress', (SELECT count(*) FROM scrape_run_stations s WHERE s.run_id=r.id AND s.status='in_progress'),
           'skipped', coalesce(jsonb_array_length(r.scope->'skipped'), 0)) AS counts
  FROM scrape_runs r;

REVOKE ALL ON v_runs FROM PUBLIC;
GRANT SELECT ON v_runs TO {{scraper_role}}, {{reader_role}};
-- Existing column UPDATE grants remain unchanged: scope is immutable after INSERT.
GRANT INSERT (scope) ON scrape_runs TO {{scraper_role}};
