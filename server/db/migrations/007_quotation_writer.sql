SET LOCAL search_path TO {{schema}};

GRANT USAGE ON SCHEMA {{schema}} TO {{quotation_role}};
GRANT SELECT ON v_active_routes TO {{quotation_role}};
GRANT SELECT, INSERT ON route_quotation_imports, route_quotation_lines, route_quotation_prices
  TO {{quotation_role}};
GRANT UPDATE (voided_at, void_reason) ON route_quotation_lines TO {{quotation_role}};
GRANT USAGE ON SEQUENCE route_quotation_lines_id_seq TO {{quotation_role}};
