import type { SourceAccount } from "../backends/backend.ts";
import type { Account, Money } from "../model.ts";
import { toLondonDate as toDateIn } from "./dates.ts";
import { toMinor } from "./transactions.ts";

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Amount as major units from a number or {amount|value: number|{value}} (tolerant). */
function amountOf(v: unknown): number | null {
  const n = num(v);
  if (n !== null) return n;
  if (isRec(v)) return amountOf(v.amount) ?? amountOf(v.value);
  return null;
}

function money(major: number, currency: string): Money {
  const m = Math.round(major * 100) / 100;
  return { value: toMinor(m), major: m, currency };
}

const ts = (s: string | null): number => (s ? Date.parse(s) : NaN);

const HOLDER = /^(mr|mrs|ms|miss|mx|dr|prof|sir|lady|rev)\.?\s/i;
const TYPE_LABEL: Record<string, string> = { cash: "current account", savings: "savings", card: "card" };

/** True when an account name is really the holder's name (e.g. "MR A SMITH", "DR A & MR B SMITH"). */
export function isHolderName(name: string, parties: unknown): boolean {
  if (HOLDER.test(name)) return true;
  if (!Array.isArray(parties)) return false;
  const n = name.trim().toLowerCase();
  return parties.some((p) => isRec(p) && typeof p.name === "string" && p.name.trim().toLowerCase() === n);
}

/**
 * Display name for an account. Providers sometimes put the holder's name in accountName;
 * then use the product name, else "<bank> <type>" (e.g. "Virgin Money savings").
 */
export function accountDisplayName(raw: SourceAccount): string {
  const name = str(raw.accountName) ?? str(raw.providerAccountName);
  if (name && !isHolderName(name, raw.parties)) return name;
  const product = str(raw.productName);
  if (product) return product;
  const bank = str(raw.bankName)?.replace(/\s*\(.*\)\s*$/, "") ?? null;
  const type = str(raw.type);
  const label = type ? TYPE_LABEL[type] ?? type : null;
  const fallback = [bank, label].filter(Boolean).join(" ");
  return fallback || name || "";
}

/** The web app treats an account as archived when `closed` is set and in the past (isClosed). */
export function archiveOf(closed: unknown, now: Date): { archived: boolean; archivedAt: string | null } {
  if (closed === true) return { archived: true, archivedAt: null };
  const at = str(closed);
  if (!at || Number.isNaN(Date.parse(at))) return { archived: false, archivedAt: null };
  return { archived: Date.parse(at) <= now.getTime(), archivedAt: at };
}

/** A normalised entry of an account's `balances` array. */
export interface BalanceEntry {
  date: string | null;
  amount: number | null;
  tag: string | null;
}

const dayOf = (d: string): string => d.slice(0, 10);

/**
 * Balance in force on `onDate` (YYYY-MM-DD), following the web app's rules: entries sorted by date (an
 * "initial" entry first on equal dates); before the first date there is none; on or after the last date it
 * is the last entry; otherwise the latest entry dated on or before `onDate` (the last of several on that date).
 * No dated entries: the last entry. Empty or missing array: undefined.
 */
export function balanceForDate(balances: unknown, onDate: string): BalanceEntry | undefined {
  if (!Array.isArray(balances)) return undefined;
  const all: BalanceEntry[] = balances
    .filter(isRec)
    .map((b) => ({ date: str(b.date), amount: amountOf(b.amount), tag: str(b.tag) }));
  if (all.length === 0) return undefined;
  const dated = all.filter((b) => b.date !== null);
  if (dated.length === 0) return all[all.length - 1];
  dated.sort((x, y) => {
    const c = dayOf(x.date!).localeCompare(dayOf(y.date!));
    if (c !== 0) return c;
    return (x.tag === "initial" ? 0 : 1) - (y.tag === "initial" ? 0 : 1);
  });
  if (onDate < dayOf(dated[0]!.date!)) return undefined;
  if (dayOf(dated[dated.length - 1]!.date!) <= onDate) return dated[dated.length - 1];
  let found: BalanceEntry | undefined;
  for (const b of dated) if (dayOf(b.date!) <= onDate) found = b;
  return found;
}

const round2 = (x: number): number => Math.round(x * 100) / 100;
const VALUED_TYPES = new Set(["properties", "asset"]);

/** The balance entry for today, falling back to currentBalance only when `balances` is missing or empty (CLI fallback). */
function currentEntry(raw: SourceAccount, today: string): BalanceEntry | undefined {
  if (Array.isArray(raw.balances) && raw.balances.length > 0) return balanceForDate(raw.balances, today);
  const cb = raw.currentBalance;
  const amount = amountOf(cb);
  if (amount === null) return undefined;
  return { date: isRec(cb) ? str(cb.date) : null, amount, tag: null };
}

/** Whole calendar days from `from` to `to` (YYYY-MM-DD). */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86_400_000);
}

/** Unrounded dashboard value of an account on the day of `now`; undefined when there is no balance. */
export function currentValue(raw: SourceAccount, now: Date, tz = "Europe/London"): number | undefined {
  if (archiveOf(raw.closed, now).archived) return 0;
  const today = toDateIn(now, tz);
  const b = currentEntry(raw, today);
  if (!b || b.amount === null) return undefined;
  if (!VALUED_TYPES.has(String(raw.type))) return b.amount;
  const rate = num(raw.yearlyAppreciation) ?? 0;
  const days = b.date ? Math.max(0, daysBetween(dayOf(b.date), today)) : 0;
  const p = Math.floor(days / (365 / 12)) / 12;
  return b.amount * Math.pow(1 + rate / 100, p);
}

/** Unrounded contribution to net worth (GBP accounts only; the contribution is a percentage). */
export function netWorthValue(raw: SourceAccount, now: Date, tz = "Europe/London"): number {
  if ((str(raw.currency) ?? "GBP") !== "GBP") return 0;
  if (raw.netWorthEnabled === false) return 0;
  const nw = num(raw.netWorthContribution);
  if (nw === 0) return 0;
  const v = currentValue(raw, now, tz) ?? 0;
  return nw !== null ? (v * nw) / 100 : v;
}

/** Counts towards net worth at all (not deleted, connection not deleted). */
export const isActive = (raw: SourceAccount): boolean => raw.deleted !== true && raw.deletedConnection !== true;

/** Net worth total: the sum of the contributions of active accounts, rounded to pence. */
export function netWorthTotal(raws: SourceAccount[], now: Date, tz = "Europe/London"): number {
  return round2(raws.filter(isActive).reduce((sum, r) => sum + netWorthValue(r, now, tz), 0));
}

export function mapAccount(raw: SourceAccount, now: Date = new Date(), tz = "Europe/London"): Account {
  const auto = raw.auto === true;
  const currency = str(raw.currency) ?? "GBP";
  const entry = currentEntry(raw, toDateIn(now, tz));
  const balanceMajor = entry?.amount ?? null;
  const balanceDate = entry?.date ?? null;
  const providerLastUpdated = str(raw.providerLastUpdated);

  const candidates = [providerLastUpdated, balanceDate].filter((x): x is string => !!x && !Number.isNaN(ts(x)));
  const lastUpdated = candidates.length ? candidates.reduce((a, b) => (ts(b) > ts(a) ? b : a)) : null;
  const daysSinceUpdate = lastUpdated ? Math.max(0, Math.floor((now.getTime() - ts(lastUpdated)) / 86_400_000)) : null;
  const value = currentValue(raw, now, tz);

  return {
    id: raw.uid,
    name: accountDisplayName(raw),
    provider: str(raw.bankName),
    type: str(raw.type),
    accountType: str(raw.accountType),
    auto,
    manual: !auto,
    currency: str(raw.currency),
    balance: balanceMajor === null ? null : money(balanceMajor, currency),
    balanceDate,
    value: value === undefined ? null : money(round2(value), currency),
    providerLastUpdated,
    lastUpdated,
    daysSinceUpdate,
    deleted: raw.deleted === true,
    ...archiveOf(raw.closed, now),
    netWorthEnabled: raw.netWorthEnabled !== false,
    netWorthContribution: num(raw.netWorthContribution) ?? 100,
    netWorthValue: money(round2(netWorthValue(raw, now, tz)), currency),
    yearlyAppreciation: num(raw.yearlyAppreciation),
    active: isActive(raw),
  };
}

/** manual accounts not updated for at least `days` days; never-updated counts as stale. */
export function isStale(a: Account, days: number): boolean {
  return a.manual && (a.daysSinceUpdate === null || a.daysSinceUpdate >= days);
}

export function filterStale(accounts: Account[], days: number): Account[] {
  return accounts.filter((a) => isStale(a, days));
}

/** Most stale first; accounts never updated come first. */
export function sortByStaleness(accounts: Account[]): Account[] {
  const key = (a: Account) => (a.daysSinceUpdate === null ? Infinity : a.daysSinceUpdate);
  return [...accounts].sort((x, y) => key(y) - key(x) || x.name.localeCompare(y.name));
}
