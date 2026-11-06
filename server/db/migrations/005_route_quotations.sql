SET LOCAL search_path TO {{schema}};

CREATE TABLE quotation_weight_bands (
  code text PRIMARY KEY,
  ordinal int NOT NULL UNIQUE,
  label_zh text NOT NULL,
  label_en text NOT NULL
);
INSERT INTO quotation_weight_bands VALUES
  ('0_1',1,'0-1(lb)','0-1(lb)'),
  ('1_5',2,'1-5(lb)','1-5(lb)'),
  ('5_10',3,'5-10(lb)','5-10(lb)'),
  ('10_20',4,'10-20(lb)','10-20(lb)'),
  ('20_30',5,'20-30(lb)','20-30(lb)'),
  ('30_40',6,'30-40(lb)','30-40(lb)'),
  ('40_plus',7,'40(lb)以上','Above 40(lb)');

CREATE TABLE route_quotation_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL CHECK (source IN ('manual_file','lark_sheet','lark_bot')),
  source_ref text,
  quotation_date date,
  status text NOT NULL CHECK (status IN ('completed','partial','rejected')),
  row_count int NOT NULL CHECK (row_count >= 0),
  accepted_count int NOT NULL CHECK (accepted_count >= 0),
  duplicate_count int NOT NULL CHECK (duplicate_count >= 0),
  rejected_count int NOT NULL CHECK (rejected_count >= 0),
  errors jsonb NOT NULL DEFAULT '[]',
  warnings jsonb NOT NULL DEFAULT '[]',
  imported_at timestamptz NOT NULL DEFAULT now(),
  imported_by text
);
CREATE TABLE route_quotation_lines (
  id bigserial PRIMARY KEY,
  import_id uuid NOT NULL REFERENCES route_quotation_imports(id),
  source_row int,
  station_code text NOT NULL REFERENCES known_stations(code),
  route_id bigint NOT NULL,
  route_name text NOT NULL,
  postal_code text NOT NULL CHECK (postal_code ~ '^\d{5}$'),
  station_label_raw text,
  fleet_name text,
  reference_postal_code text,
  effective_from date NOT NULL,
  end_date date,
  remarks text,
  voided_at timestamptz,
  void_reason text,
  UNIQUE (import_id, route_id, postal_code),
  CHECK (end_date IS NULL OR end_date >= effective_from),
  CHECK (void_reason IS NULL OR voided_at IS NOT NULL)
);
CREATE UNIQUE INDEX one_quote_per_key_day
  ON route_quotation_lines (route_id, postal_code, effective_from) WHERE voided_at IS NULL;
CREATE TABLE route_quotation_prices (
  line_id bigint REFERENCES route_quotation_lines(id),
  weight_band text REFERENCES quotation_weight_bands(code),
  parcel_type text CHECK (parcel_type IN ('first','additional')),
  price numeric(8,2) NOT NULL CHECK (price >= 0),
  PRIMARY KEY (line_id, weight_band, parcel_type)
);

CREATE VIEW v_route_quotation_current AS
  WITH current_lines AS (
    SELECT DISTINCT ON (route_id, postal_code) * FROM route_quotation_lines
    WHERE voided_at IS NULL
      AND effective_from <= (now() AT TIME ZONE 'America/Los_Angeles')::date
      AND (end_date IS NULL OR (now() AT TIME ZONE 'America/Los_Angeles')::date <= end_date)
    ORDER BY route_id, postal_code, effective_from DESC
  )
  SELECT l.id AS line_id, l.import_id, l.station_code, l.route_id, l.route_name,
    l.postal_code, l.fleet_name, l.effective_from, l.end_date, l.remarks,
    i.quotation_date, i.imported_at,
    COALESCE(p.first_prices, '{}'::jsonb) AS first_prices,
    COALESCE(p.additional_prices, '{}'::jsonb) AS additional_prices
  FROM current_lines l JOIN route_quotation_imports i ON i.id=l.import_id
  LEFT JOIN LATERAL (
    SELECT jsonb_object_agg(weight_band, price) FILTER (WHERE parcel_type='first') AS first_prices,
      jsonb_object_agg(weight_band, price) FILTER (WHERE parcel_type='additional') AS additional_prices
    FROM route_quotation_prices WHERE line_id=l.id
  ) p ON true;
CREATE VIEW v_route_quotation_first_0_1lb AS
  SELECT route_id, postal_code, (first_prices->>'0_1')::numeric(8,2) AS price
  FROM v_route_quotation_current;
CREATE VIEW v_route_quotation_upcoming AS
  SELECT DISTINCT ON (route_id, postal_code) route_id, postal_code, station_code, effective_from
  FROM route_quotation_lines
  WHERE voided_at IS NULL AND effective_from > (now() AT TIME ZONE 'America/Los_Angeles')::date
  ORDER BY route_id, postal_code, effective_from;
CREATE VIEW v_quotation_weight_bands AS
  SELECT code, ordinal, label_zh, label_en FROM quotation_weight_bands;

REVOKE ALL ON quotation_weight_bands, route_quotation_imports, route_quotation_lines,
  route_quotation_prices, v_route_quotation_current, v_route_quotation_first_0_1lb,
  v_route_quotation_upcoming, v_quotation_weight_bands FROM PUBLIC;
GRANT SELECT ON v_route_quotation_current, v_route_quotation_first_0_1lb,
  v_route_quotation_upcoming, v_quotation_weight_bands TO {{reader_role}};
