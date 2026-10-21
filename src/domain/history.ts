// Values over time: the daily net worth series and the flattened balance history.
import type { SourceAccount } from "../backends/backend.ts";
import { accountDisplayName, amountOf, archiveOf, isActive, netWorthValue } from "./accounts.ts";
import { addDays, toLondonDate } from "./dates.ts";
import type { HistoryExclusion } from "../config.ts";

export const BUCKETS = ["cash", "savings", "card", "investment", "pension", "properties", "asset", "mortgage", "loan", "other"] as const;
export type Bucket = (typeof BUCKETS)[number];
export type Interval = "day" | "week" | "month";

export interface NetWorthPoint extends Record<Bucket, number> {
  date: string;
  net_worth: number;
  /** true when a configured history exclusion left an account out on this day */
  adjusted: boolean;
}

/** The exclusion covering `account` on `date`, if any. */
const exclusionOn = (ex: readonly HistoryExclusion[], account: string, date: string): HistoryExclusion | undefined =>
  ex.find((e) => e.account === account && e.from <= date && date <= e.to);

/** How each exclusion applies to a series: the days it removed an active account (0 = matched nothing). */
export function exclusionReport(raws: SourceAccount[], ex: readonly HistoryExclusion[], days: readonly string[], today: string) {
  const ids = new Set(raws.filter(isActive).map((r) => r.uid));
  return ex.map((e) => ({
    ...e,
    accountFound: ids.has(e.account),
    days: ids.has(e.account) ? days.filter((d) => d !== today && e.from <= d && d <= e.to).length : 0,
  }));
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const BUCKET_SET = new Set<string>(BUCKETS);
const bucketOf = (type: unknown): Bucket => (typeof type === "string" && BUCKET_SET.has(type) ? (type as Bucket) : "other");
const dayOf = (d: unknown): string | null => (typeof d === "string" && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null);

/** Earliest dated balance entry of any active account, or null when there is none. */
export function firstBalanceDate(raws: SourceAccount[]): string | null {
  let first: string | null = null;
  for (const r of raws) {
    if (!isActive(r) || !Array.isArray(r.balances)) continue;
    for (const b of r.balances) {
      const d = isRec(b) ? dayOf(b.date) : null;
      if (d && (first === null || d < first)) first = d;
    }
  }
  return first;
}

/**
 * The days of [from, to] to report. `week` and `month` keep the last day of each period (Sunday / calendar
 * month end) and always the `to` day, which closes a partial final period.
 */
export function seriesDays(from: string, to: string, interval: Interval = "day"): string[] {
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const next = addDays(d, 1);
    const ends =
      interval === "day" ||
      d === to ||
      (interval === "week" ? new Date(d + "T00:00:00Z").getUTCDay() === 0 : next.slice(0, 7) !== d.slice(0, 7));
    if (ends) days.push(d);
  }
  return days;
}

/** Round the buckets to pence so that they add up to `totalPence` exactly (largest remainder). */
function roundToTotal(sums: Record<Bucket, number>, totalPence: number): Record<Bucket, number> {
  const floors = BUCKETS.map((b) => Math.floor(sums[b] * 100 + 1e-6));
  let deficit = totalPence - floors.reduce((a, b) => a + b, 0);
  const order = BUCKETS.map((_, i) => i).sort((x, y) => (sums[BUCKETS[y]!] * 100 - floors[y]!) - (sums[BUCKETS[x]!] * 100 - floors[x]!) || x - y);
  for (let k = 0; deficit !== 0; k++) {
    const i = order[k % order.length]!;
    const step = deficit > 0 ? 1 : -1;
    floors[i] = floors[i]! + step;
    deficit -= step;
  }
  return Object.fromEntries(BUCKETS.map((b, i) => [b, floors[i]! / 100])) as Record<Bucket, number>;
}

/**
 * Net worth per day for [from, to] (default: first balance date .. today), with the per-type sums of
 * netWorthValue over active accounts. Each day is evaluated like `wps networth --date`: `now` is midday UTC on
 * that day (or the real `now` for today, so today's point equals netWorthTotal exactly).
 *
 * Rounding: `net_worth` is the unrounded sum rounded to pence, i.e. exactly netWorthTotal. Buckets are rounded
 * with the largest-remainder method so that they add up to `net_worth` to the penny; a bucket can therefore
 * differ by a penny from its independently rounded value. The total always wins.
 *
 * `exclusions` leave an account out on the days they cover (a stalled connection tracked twice, say). They are
 * never applied to today, so today's point still equals the dashboard; days they change are marked `adjusted`.
 */
export function networthSeries(
  raws: SourceAccount[],
  opts: { from?: string; to?: string; interval?: Interval; now?: Date; tz?: string; exclusions?: readonly HistoryExclusion[] } = {},
): NetWorthPoint[] {
  const tz = opts.tz ?? "Europe/London";
  const now = opts.now ?? new Date();
  const today = toLondonDate(now, tz);
  const to = opts.to ?? today;
  const from = opts.from ?? firstBalanceDate(raws);
  if (from === null || from > to) return [];
  const active = raws.filter(isActive);
  const exclusions = opts.exclusions ?? [];
  return seriesDays(from, to, opts.interval).map((date) => {
    const at = date === today ? now : new Date(date + "T12:00:00Z");
    const sums = Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<Bucket, number>;
    let total = 0; // same order of addition as netWorthTotal
    let adjusted = false;
    for (const r of active) {
      if (date !== today && exclusions.length && exclusionOn(exclusions, r.uid, date)) {
        adjusted = true;
        continue;
      }
      const v = netWorthValue(r, at, tz);
      sums[bucketOf(r.type)] += v;
      total += v;
    }
    const netWorth = Math.round(total * 100) / 100; // = netWorthTotal
    const pence = Math.round(netWorth * 100);
    return { date, net_worth: netWorth, ...roundToTotal(sums, pence), adjusted };
  });
}

export interface BalanceHistoryEntry {
  accountId: string;
  accountName: string;
  accountType: string | null;
  date: string | null;
  amount: number | null;
  entryType: string | null;
  tag: string | null;
  active: boolean;
  archived: boolean;
}

/** One entry per `balances[]` item of every account, oldest date first (then account name, then source order). */
export function flattenBalances(raws: SourceAccount[], now: Date): BalanceHistoryEntry[] {
  const out: BalanceHistoryEntry[] = [];
  for (const r of raws) {
    if (!Array.isArray(r.balances)) continue;
    const base = {
      accountId: r.uid,
      accountName: accountDisplayName(r),
      accountType: typeof r.type === "string" ? r.type : null,
      active: isActive(r),
      archived: archiveOf(r.closed, now).archived,
    };
    for (const b of r.balances) {
      if (!isRec(b)) continue;
      const amount = amountOf(b.amount);
      out.push({
        ...base,
        date: dayOf(b.date),
        amount,
        entryType: typeof b.type === "string" ? b.type : null,
        tag: typeof b.tag === "string" && b.tag !== "" ? b.tag : null,
      });
    }
  }
  // undated entries last; Array.prototype.sort is stable
  return out.sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999") || a.accountName.localeCompare(b.accountName) || a.accountId.localeCompare(b.accountId));
}
