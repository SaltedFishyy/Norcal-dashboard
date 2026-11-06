SET LOCAL search_path TO {{schema}};
ALTER TABLE route_quotation_lines ADD COLUMN second_parcel_half_price_raw text;
ALTER TABLE route_quotation_lines
  DROP CONSTRAINT route_quotation_lines_import_id_route_id_postal_code_key;
ALTER TABLE route_quotation_lines
  ADD CONSTRAINT quotation_import_route_zip_day_key
  UNIQUE (import_id, route_id, postal_code, effective_from);
