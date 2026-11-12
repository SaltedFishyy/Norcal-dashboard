// Rows arrive in chronological order from the daily history view.
export function buildRouteHistory(rows, { routeId, days, firstSeen = null, lastSeen = null,
  formerNames = [], latestDay = null }) {
  const points = rows.map(({ day, route_name, station, dsp_name, pickup_volume, pph,
    first_mile_distance, zip_count, route_difficulty }) => ({ day, route_name, station, dsp_name,
    pickup_volume, pph, first_mile_distance, zip_count, route_difficulty }));
  const changes = [];
  for (let i = 1; i < rows.length; i++) {
    const previous = rows[i - 1], current = rows[i];
    for (const field of ['route_difficulty', 'dsp_name']) {
      if (previous[field] != null && current[field] != null && previous[field] !== current[field])
        changes.push({ day: current.day, field, from: previous[field], to: current[field] });
    }
    if (previous.postal_codes != null && current.postal_codes != null) {
      const before = new Set(previous.postal_codes), after = new Set(current.postal_codes);
      const added = [...after].filter(zip => !before.has(zip)).length;
      const removed = [...before].filter(zip => !after.has(zip)).length;
      if (added || removed) changes.push({ day: current.day, field: 'zip_set', from: null, to: null, added, removed });
    }
  }
  return { available: true, route_id: routeId, days, points, changes, first_seen: firstSeen,
    last_seen: lastSeen, latest_day: latestDay, former_names: [...formerNames] };
}
