// Sheet layouts (column order is the contract) and row <-> cell conversion.
import type { Account, Category, Project, Transaction } from "../model.ts";
import { BUCKETS, type BalanceHistoryEntry, type NetWorthPoint } from "../domain/history.ts";
import { canonicalIso, dateToSerial, isoToSerial, serialToDate, serialToIso } from "./serial.ts";

export type ColType = "string" | "number" | "amount" | "boolean" | "date" | "datetime" | "any";
export interface Col { key: string; type: ColType }
export interface TableDef { sheet: string; cols: readonly Col[] }
export type Value = string | number | boolean | null;
export type Row = Record<string, Value>;

const c = (key: string, type: ColType = "string"): Col => ({ key, type });

export const TRANSACTIONS: TableDef = {
  sheet: "raw_transactions",
  cols: [
    c("id"), c("bookingDate", "date"), c("date", "datetime"), c("accountId"), c("amount", "amount"), c("currency"),
    c("shortDescription"), c("longDescription"), c("merchantName"), c("notes"), c("label"), c("categoryId"),
    c("internalCategoryId"), c("categoryIdConfirmed", "boolean"), c("projectId"), c("status"), c("deleted", "boolean"),
    c("missingFromSource", "boolean"), c("dateOnStatement"), c("dateModified", "datetime"), c("counterpartyId"), c("synced_at", "datetime"),
  ],
};
export const CATEGORIES: TableDef = {
  sheet: "ref_categories",
  cols: [c("categoryId"), c("internalId"), c("key"), c("name"), c("groupId"), c("groupKey"), c("groupName"), c("custom", "boolean")],
};
export const PROJECTS: TableDef = { sheet: "ref_projects", cols: [c("id"), c("name"), c("type")] };
export const ACCOUNTS: TableDef = {
  sheet: "raw_accounts",
  cols: [
    c("id"), c("name"), c("provider"), c("type"), c("accountType"), c("auto", "boolean"), c("manual", "boolean"),
    c("balance", "amount"), c("currency"), c("balanceDate", "date"), c("providerLastUpdated", "datetime"), c("lastUpdated", "date"),
    c("daysSinceUpdate", "number"), c("deleted", "boolean"), c("netWorthContribution", "number"),
    c("archived", "boolean"), c("archivedAt", "datetime"),
    c("value", "amount"), c("netWorthValue", "amount"), c("netWorthEnabled", "boolean"), c("yearlyAppreciation", "number"), c("active", "boolean"),
  ],
};
export const RAW_BALANCES: TableDef = {
  sheet: "raw_balances",
  cols: [c("accountId"), c("accountName"), c("accountType"), c("date", "date"), c("amount", "amount"), c("entryType"), c("tag"), c("active", "boolean"), c("archived", "boolean")],
};
export const RAW_NETWORTH: TableDef = {
  sheet: "raw_networth",
  cols: [c("date", "date"), c("net_worth", "amount"), ...BUCKETS.map((b) => c(b, "amount")), c("adjusted", "boolean")],
};
/**
 * Append-only: one row per account per sync day (`source` "recorded"). `sheets backfill-snapshots` adds "rebuilt"
 * rows for earlier days, worked out from the balance history.
 */
export const RAW_SNAPSHOTS: TableDef = {
  sheet: "raw_account_snapshots",
  cols: [
    c("snapshot_date", "date"), c("accountId"), c("name"), c("type"), c("balance", "amount"), c("balanceDate", "date"), c("value", "amount"),
    c("netWorthValue", "amount"), c("netWorthEnabled", "boolean"), c("netWorthContribution", "number"), c("archived", "boolean"),
    c("active", "boolean"), c("synced_at", "datetime"), c("source"),
  ],
};
export const META: TableDef = { sheet: "meta", cols: [c("key"), c("value", "any")] };

export const NUMBER_FORMATS: Record<string, { type: "DATE" | "DATE_TIME" | "NUMBER"; pattern: string }> = {
  date: { type: "DATE", pattern: "yyyy-mm-dd" },
  datetime: { type: "DATE_TIME", pattern: "yyyy-mm-dd hh:mm" },
  amount: { type: "NUMBER", pattern: "#,##0.00" },
};

/** Zero-based column index -> A1 letters. */
export function colLetter(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export function colIndex(def: TableDef, key: string): number {
  const i = def.cols.findIndex((x) => x.key === key);
  if (i < 0) throw new Error(`column '${key}' not in ${def.sheet}`);
  return i;
}

const orNull = (v: string | undefined | null): Value => (v === undefined || v === null || v === "" ? null : v);
const dateOnly = (s: string | null | undefined): Value => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);
const iso = (s: string | null | undefined, tz: string): Value => {
  if (!s) return null;
  try { return canonicalIso(s, tz); } catch { return null; }
};

export function transactionRow(t: Transaction, tz: string): Row {
  return {
    id: t.id, bookingDate: t.bookingDate, date: iso(t.date, tz), accountId: orNull(t.accountId), amount: t.amount.major,
    currency: orNull(t.amount.currency), shortDescription: orNull(t.shortDescription), longDescription: orNull(t.longDescription),
    merchantName: orNull(t.merchantName), notes: orNull(t.notes), label: orNull(t.label), categoryId: orNull(t.categoryId),
    internalCategoryId: orNull(t.internalCategoryId), categoryIdConfirmed: t.categoryIdConfirmed, projectId: orNull(t.projectId),
    status: orNull(t.status), deleted: t.deleted, dateOnStatement: orNull(t.dateOnStatement), dateModified: iso(t.dateModified, tz),
    counterpartyId: orNull(t.counterpartyId),
  };
}

export const categoryRow = (x: Category): Row => ({
  categoryId: x.categoryId, internalId: orNull(x.internalId), key: orNull(x.key), name: orNull(x.name), groupId: orNull(x.groupId),
  groupKey: orNull(x.groupKey), groupName: orNull(x.groupName), custom: x.custom,
});
export const projectRow = (p: Project): Row => ({ id: p.id, name: p.name, type: p.type });
export const accountRow = (a: Account, tz: string): Row => ({
  id: a.id, name: orNull(a.name), provider: a.provider, type: a.type, accountType: a.accountType, auto: a.auto, manual: a.manual,
  balance: a.balance ? a.balance.major : null, currency: a.currency, balanceDate: dateOnly(a.balanceDate),
  providerLastUpdated: iso(a.providerLastUpdated, tz), lastUpdated: dateOnly(a.lastUpdated), daysSinceUpdate: a.daysSinceUpdate,
  deleted: a.deleted, netWorthContribution: a.netWorthContribution,
  archived: a.archived, archivedAt: iso(a.archivedAt, tz),
  value: a.value ? a.value.major : null, netWorthValue: a.netWorthValue.major, netWorthEnabled: a.netWorthEnabled,
  yearlyAppreciation: a.yearlyAppreciation, active: a.active,
});

export const balanceRow = (e: BalanceHistoryEntry): Row => ({
  accountId: e.accountId, accountName: orNull(e.accountName), accountType: e.accountType, date: e.date, amount: e.amount,
  entryType: e.entryType, tag: e.tag, active: e.active, archived: e.archived,
});
export const networthRow = (p: NetWorthPoint): Row => ({ ...p });
/** One account on one sync day, from the mapped account (same values as raw_accounts). */
export const snapshotRow = (a: Account, day: string, syncedAt: string, tz: string, source: "recorded" | "rebuilt" = "recorded"): Row => ({
  snapshot_date: day, accountId: a.id, name: orNull(a.name), type: a.type, balance: a.balance ? a.balance.major : null, balanceDate: dateOnly(a.balanceDate),
  value: a.value ? a.value.major : null, netWorthValue: a.netWorthValue.major, netWorthEnabled: a.netWorthEnabled,
  netWorthContribution: a.netWorthContribution, archived: a.archived, active: a.active, synced_at: iso(syncedAt, tz), source,
});

/** Typed row -> cell. Dates and datetimes become serial numbers; everything else is sent as-is (RAW). */
export function encodeCell(col: Col, v: Value | undefined, tz: string): string | number | boolean {
  if (v === null || v === undefined || v === "") return "";
  switch (col.type) {
    case "date": return typeof v === "string" ? dateToSerial(v) : v;
    case "datetime": return typeof v === "string" ? isoToSerial(v, tz) : v;
    case "number": case "amount": return typeof v === "number" ? v : Number(v);
    case "boolean": return typeof v === "boolean" ? v : v === "true";
    case "string": return String(v);
    default: return v;
  }
}

export function encodeRows(def: TableDef, rows: readonly Row[], tz: string): (string | number | boolean)[][] {
  return [def.cols.map((x) => x.key), ...rows.map((r) => def.cols.map((col) => encodeCell(col, r[col.key], tz)))];
}

/** Cell read back from a sheet -> typed value (inverse of encodeCell). */
export function decodeCell(col: Col, v: unknown, tz: string): Value {
  if (v === undefined || v === null || v === "") return null;
  switch (col.type) {
    case "date":
      if (typeof v === "number") return serialToDate(v);
      return dateOnly(String(v));
    case "datetime": {
      if (typeof v === "number") return serialToIso(v, tz);
      const s = String(v);
      const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?$/.exec(s);
      if (m) return serialToIso(dateToSerial(m[1]!) + (Number(m[2]!.slice(0, 2)) * 3600 + Number(m[2]!.slice(3)) * 60 + Number(m[3] ?? 0)) / 86400, tz);
      return iso(s, tz);
    }
    case "number": case "amount": return typeof v === "number" ? v : Number.isFinite(Number(v)) ? Number(v) : null;
    case "boolean": return typeof v === "boolean" ? v : String(v).toLowerCase() === "true";
    case "string": return String(v);
    default: return typeof v === "number" || typeof v === "boolean" ? v : String(v);
  }
}

/** Parse a sheet's value grid (header in row 1) back into typed rows, by header name. */
export function decodeRows(def: TableDef, grid: readonly (readonly unknown[])[], tz: string): Row[] {
  if (grid.length === 0) return [];
  const header = grid[0]!.map(String);
  const at = new Map(def.cols.map((col) => [col.key, header.indexOf(col.key)]));
  const out: Row[] = [];
  for (const line of grid.slice(1)) {
    if (!line || line.every((x) => x === "" || x === null || x === undefined)) continue;
    const r: Row = {};
    for (const col of def.cols) {
      const i = at.get(col.key)!;
      r[col.key] = i < 0 ? null : decodeCell(col, line[i], tz);
    }
    out.push(r);
  }
  return out;
}
