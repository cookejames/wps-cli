import type { SourceAccount } from "../backends/backend.ts";
import type { Account, Money } from "../model.ts";
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
  return { value: toMinor(major), major, currency };
}

function latestBalance(balances: unknown): { date: string | null; amount: number | null } {
  let best: { date: string | null; amount: number | null } = { date: null, amount: null };
  if (!Array.isArray(balances)) return best;
  for (const b of balances) {
    if (!isRec(b)) continue;
    const date = str(b.date);
    if (!date) continue;
    // later date wins; ties go to the later entry (list is oldest -> newest)
    if (best.date === null || date >= best.date) best = { date, amount: amountOf(b.amount) };
  }
  return best;
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

export function mapAccount(raw: SourceAccount, now: Date = new Date()): Account {
  const auto = raw.auto === true;
  const currency = str(raw.currency) ?? "GBP";
  const latest = latestBalance(raw.balances);
  const cb = raw.currentBalance;
  const cbAmount = amountOf(cb);
  const cbDate = isRec(cb) ? str(cb.date) : null;
  const balanceMajor = cbAmount ?? latest.amount;
  const balanceDate = cbDate ?? latest.date;
  const providerLastUpdated = str(raw.providerLastUpdated);

  const candidates = [providerLastUpdated, balanceDate].filter((x): x is string => !!x && !Number.isNaN(ts(x)));
  const lastUpdated = candidates.length ? candidates.reduce((a, b) => (ts(b) > ts(a) ? b : a)) : null;
  const daysSinceUpdate = lastUpdated ? Math.max(0, Math.floor((now.getTime() - ts(lastUpdated)) / 86_400_000)) : null;
  const nw = num(raw.netWorthContribution);

  const a: Account = {
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
    providerLastUpdated,
    lastUpdated,
    daysSinceUpdate,
    deleted: raw.deleted === true,
  };
  if (nw !== null) a.netWorthContribution = nw;
  return a;
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
