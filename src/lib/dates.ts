const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Post dates are calendar dates, so they are read in UTC to avoid timezone drift.
const parts = (date: Date) => ({
  day: date.getUTCDate(),
  month: MONTHS[date.getUTCMonth()],
  year: date.getUTCFullYear(),
});

/** 17 Feb 2026 */
export function formatDate(date: Date): string {
  const { day, month, year } = parts(date);
  return `${day} ${month} ${year}`;
}

/** Feb 2026 */
export function formatMonthYear(date: Date): string {
  const { month, year } = parts(date);
  return `${month} ${year}`;
}

/** 17 Feb */
export function formatDayMonth(date: Date): string {
  const { day, month } = parts(date);
  return `${day} ${month}`;
}

/** 2026-02-17, for <time datetime> */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
