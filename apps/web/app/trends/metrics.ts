const countFormat = new Intl.NumberFormat("en-US");
const decimalFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const costFormat = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 3 });
const monthFormat = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

export const formatCount = (value: number) => countFormat.format(value);
export const formatDecimal = (value: number) => decimalFormat.format(value);
export const formatCost = (value: number) => costFormat.format(value);
export const formatPercent = (value: number) => `${decimalFormat.format(value)}%`;
export const formatMonth = (month: string) => monthFormat.format(new Date(`${month}-01T00:00:00Z`));

export function formatDuration(seconds: number) {
  if (seconds >= 172_800) return `${formatDecimal(seconds / 86_400)} d`;
  if (seconds >= 3_600) return `${formatDecimal(seconds / 3_600)} hr`;
  if (seconds >= 60) return `${formatDecimal(seconds / 60)} min`;
  return `${formatDecimal(seconds)} sec`;
}

export function reportNumber(value: number | null, format: (value: number) => string) {
  return value === null ? "Unavailable" : format(value);
}
