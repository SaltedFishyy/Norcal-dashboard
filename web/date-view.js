// Shared URL and presentation helpers for Pacific snapshot days.
export function readViewDate(search) {
  const values = new URLSearchParams(search).getAll('date');
  const day = values[0];
  if (values.length !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const parsed = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day ? day : null;
}
export function withViewDate(href, date) {
  const url = new URL(href, 'http:' + '//date-view.local');
  url.searchParams.delete('date');
  if (date) url.searchParams.set('date', date);
  return /^https?:/.test(href) ? url.href : url.pathname + url.search + url.hash;
}
export function apiUrl(path, params, date) {
  const search = new URLSearchParams(params);
  search.delete('date');
  if (date) search.set('date', date);
  return path + (search.size ? `?${search}` : '');
}
export const formatViewDate = day => day.slice(5).replace('-', '/');
export function dateOptions(days) {
  const year = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric' }).format(new Date());
  return [{ value: '', label: '最新' }, ...days.map(({ day, has_data }) => ({ value: day,
    label: (day.slice(0, 4) === year ? formatViewDate(day) : day.replaceAll('-', '/')) + (has_data === false ? '（空）' : '') }))];
}
export function syncNavLinks(document, date) {
  for (const link of document.querySelectorAll?.('.page-nav a') ?? []) {
    link.setAttribute('href', withViewDate(link.getAttribute('href'), date));
  }
}
