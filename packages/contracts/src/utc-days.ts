const millisecondsPerDay = 86_400_000;

export function utcDay(date: Date) {
  return date.toISOString().slice(0, 10);
}

export function shiftDay(day: string, offset: number) {
  return utcDay(new Date(Date.parse(day) + offset * millisecondsPerDay));
}

export function readDay(value: string | string[] | undefined) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
  const milliseconds = Date.parse(value);
  if (Number.isFinite(milliseconds) && utcDay(new Date(milliseconds)) === value) return value;
}
