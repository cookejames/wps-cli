const formatters = new Map<string, Intl.DateTimeFormat>();

/** Calendar date (YYYY-MM-DD) of an instant in the given IANA time zone. */
export function toLondonDate(iso: string | Date, timeZone = "Europe/London"): string {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) throw new RangeError(`invalid date: ${String(iso)}`);
  let fmt = formatters.get(timeZone);
  if (!fmt) formatters.set(timeZone, (fmt = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })));
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export const isDateString = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));

export function addDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
