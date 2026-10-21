// Google Sheets serial numbers: days since 1899-12-30. Datetimes are wall-clock time in a time zone.
const EPOCH_MS = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;

/** YYYY-MM-DD -> whole-day serial. */
export function dateToSerial(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) throw new RangeError(`invalid date: ${date}`);
  return Math.round((Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!) - EPOCH_MS) / DAY_MS);
}

export function serialToDate(serial: number): string {
  return new Date(EPOCH_MS + Math.round(serial) * DAY_MS).toISOString().slice(0, 10);
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(timeZone: string): Intl.DateTimeFormat {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    fmtCache.set(timeZone, f);
  }
  return f;
}

/** ms to add to a UTC instant to get the wall-clock time (as if UTC) in the zone. */
function offsetMs(instantMs: number, timeZone: string): number {
  const whole = Math.floor(instantMs / 1000) * 1000;
  const p = fmt(timeZone).formatToParts(new Date(whole));
  const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - whole;
}

/** ISO UTC instant -> serial of the wall-clock time in `timeZone`. */
export function isoToSerial(iso: string, timeZone: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new RangeError(`invalid datetime: ${iso}`);
  return (ms + offsetMs(ms, timeZone) - EPOCH_MS) / DAY_MS;
}

/**
 * Serial (wall-clock in `timeZone`) -> ISO UTC with milliseconds. In the repeated autumn hour the
 * result is deterministic but may be the other of the two instants; callers that compare
 * values should canonicalise both sides through this round trip.
 */
export function serialToIso(serial: number, timeZone: string): string {
  const local = EPOCH_MS + Math.round(serial * DAY_MS);
  let guess = local - offsetMs(local, timeZone);
  guess = local - offsetMs(guess, timeZone);
  return new Date(guess).toISOString();
}

/** iso -> serial -> iso (canonical form used for comparisons). */
export function canonicalIso(iso: string, timeZone: string): string {
  return serialToIso(isoToSerial(iso, timeZone), timeZone);
}
