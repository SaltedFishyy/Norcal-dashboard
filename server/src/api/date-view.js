export function pacificToday(now) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now());
  const part = type => parts.find(value => value.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function requestDay(url, today) {
  const values = url.searchParams.getAll('date');
  if (!values.length) return undefined;
  const day = values[0];
  const parsed = new Date(`${day}T00:00:00Z`);
  if (values.length !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(day) || day.startsWith('0000-')
    || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day || day > today) {
    const error = new Error('Invalid date'); error.name = 'InvalidDateError'; throw error;
  }
  return day;
}

export function snapshotCalendar(rows, today) {
  const found = new Map(rows.filter(row => row.day <= today).map(row => [row.day, row.stations]));
  const first = [...found.keys()].sort()[0];
  const days = [];
  if (first) {
    for (let date = new Date(`${today}T00:00:00Z`); date.toISOString().slice(0, 10) >= first; date.setUTCDate(date.getUTCDate() - 1)) {
      const day = date.toISOString().slice(0, 10), stations = found.get(day) ?? [];
      days.push({ day, has_data: stations.length > 0, stations_with_data: stations });
    }
  }
  return { days };
}
