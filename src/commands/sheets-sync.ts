import { readFileSync } from "node:fs";
import { loadCategoryIndex } from "../catalog.ts";
import { BadArgsError, SinkError } from "../errors.ts";
import { mapAccount, netWorthTotal } from "../domain/accounts.ts";
import { flattenBalances, networthSeries } from "../domain/history.ts";
import { addDays, isDateString, toLondonDate } from "../domain/dates.ts";
import { mergeByUid } from "../domain/merge.ts";
import { mapTransaction } from "../domain/transactions.ts";
import { canonicalIso } from "../sinks/serial.ts";
import {
  ACCOUNTS, accountRow, balanceRow, CATEGORIES, categoryRow, decodeRows, META, networthRow, PROJECTS, projectRow, RAW_BALANCES, RAW_NETWORTH, RAW_SNAPSHOTS, snapshotRow, TRANSACTIONS, transactionRow, type Row,
} from "../sinks/tables.ts";
import { makeSink } from "./sheets-init-dashboard.ts";
import type { CommandDef } from "./types.ts";

export const BACKFILL_FROM = "2015-01-01";

const version = (): string => {
  try {
    return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
};

/** newest booking date first, then id */
export const byDateDesc = (a: Row, b: Row): number =>
  String(b.bookingDate ?? "").localeCompare(String(a.bookingDate ?? "")) || String(a.id).localeCompare(String(b.id));

export const sheetsSync: CommandDef = {
  group: "sheets",
  name: "sync",
  summary: "Sync transactions, accounts, balance history, net worth series, snapshots, categories and projects into raw_*/ref_*/meta sheets",
  options: {
    backfill: { type: "boolean" },
    from: { type: "string" },
    to: { type: "string" },
    spreadsheet: { type: "string" },
    "dry-run": { type: "boolean" },
  },
  needsSession: true,
  async run(ctx) {
    const a = ctx.args;
    const tz = ctx.config.timezone;
    const backfill = a.backfill === true;
    const dryRun = a["dry-run"] === true;
    const now = ctx.now();
    const today = toLondonDate(now, tz);
    const to = (a.to as string | undefined) ?? today;
    if (backfill && a.from !== undefined) throw new BadArgsError("--backfill and --from cannot be combined (backfill starts at " + BACKFILL_FROM + ")");
    const from = backfill ? BACKFILL_FROM : ((a.from as string | undefined) ?? addDays(to, -ctx.config.windowDays));
    for (const [n, v] of [["--from", from], ["--to", to]] as const) if (!isDateString(v)) throw new BadArgsError(`${n} must be YYYY-MM-DD`);
    if (from > to) throw new BadArgsError("--from is after --to");

    const sink = makeSink(ctx);

    // Existing table first: fail fast (before any API traffic) when a window sync has nothing to merge into.
    let existing: Row[] = [];
    if (!backfill) {
      const sheets = await sink.listSheets();
      if (sheets.some((s) => s.title === TRANSACTIONS.sheet)) {
        const grid = await sink.readValues(TRANSACTIONS.sheet);
        if (grid.length > 0 && !grid[0]!.map(String).includes("id")) throw new SinkError(`${TRANSACTIONS.sheet} has no 'id' header; not touching it`);
        existing = decodeRows(TRANSACTIONS, grid, tz);
      }
      if (existing.length === 0) throw new BadArgsError("raw_transactions is empty; run with --backfill first");
    }

    const backend = await ctx.backend();
    ctx.log.info(`fetching ${from}..${to}`);
    const rawTx = await backend.listTransactions(from, to);
    const index = await loadCategoryIndex(ctx);
    const projects = await backend.listProjects();
    const rawAccounts = await backend.listAccounts();

    const syncedAt = canonicalIso(now.toISOString(), tz);
    const fresh = rawTx.map((r) => transactionRow(mapTransaction(r, { index, timezone: tz }), tz));
    let rows: Row[];
    let stats = { total: 0, added: 0, updated: 0, unchanged: 0, missingFromSource: 0 };
    if (backfill) {
      rows = fresh.map((r) => ({ ...r, missingFromSource: false, synced_at: syncedAt }));
      stats = { total: rows.length, added: rows.length, updated: 0, unchanged: 0, missingFromSource: 0 };
    } else {
      const syncedById = new Map(existing.map((r) => [String(r.id), r.synced_at ?? null]));
      const strip = ({ synced_at: _s, ...rest }: Row): Row => rest;
      const merged = mergeByUid(existing.map(strip), fresh, from, to, { key: "id", dateField: "bookingDate" });
      const freshSet = new Set<Row>(fresh);
      rows = merged.rows.map((r) => ({
        ...r,
        missingFromSource: r.missingFromSource === true,
        synced_at: freshSet.has(r) ? syncedAt : (syncedById.get(String(r.id)) ?? null),
      }));
      // rows whose fresh copy differs only in the flag are "updated"; mergeByUid already counted them
      stats = { total: rows.length, added: merged.added, updated: merged.updated, unchanged: merged.unchanged, missingFromSource: rows.filter((r) => r.missingFromSource === true).length };
    }
    rows.sort(byDateDesc);

    const accountRows = rawAccounts.map((r) => accountRow(mapAccount(r, now, tz), tz));
    const categoryRows = index.categories.map(categoryRow);
    const projectRows = projects.map(projectRow);

    // Values over time: the history is rebuilt from the API every run; snapshots are append-only.
    const balanceRows = flattenBalances(rawAccounts, now).map(balanceRow);
    const series = networthSeries(rawAccounts, { to: today, now, tz });
    const networthRows = series.map(networthRow);
    const snapshotRows = rawAccounts.map((r) => snapshotRow(mapAccount(r, now, tz), today, syncedAt, tz));

    const result = {
      mode: backfill ? "backfill" : "window",
      window: { from, to },
      transactions: stats,
      accounts: accountRows.length,
      categories: categoryRows.length,
      projects: projectRows.length,
      balances: balanceRows.length,
      networth: { days: networthRows.length, from: series[0]?.date ?? null, to: today },
      snapshots: { date: today, rows: snapshotRows.length },
      ...(dryRun ? { dryRun: true } : {}),
    };
    if (dryRun) return { data: result };

    await sink.rewriteTable(TRANSACTIONS, rows);
    await sink.rewriteTable(CATEGORIES, categoryRows);
    await sink.rewriteTable(PROJECTS, projectRows);
    await sink.rewriteTable(ACCOUNTS, accountRows);
    await sink.rewriteTable(RAW_BALANCES, balanceRows);
    await sink.rewriteTable(RAW_NETWORTH, networthRows);
    // earlier days are never rewritten; a re-run on the same day replaces only today's rows
    const snap = await sink.appendTable(RAW_SNAPSHOTS, snapshotRows, { key: "snapshot_date", value: today });
    const meta: [string, string | number][] = [
      ["last_run_at", syncedAt],
      ["mode", result.mode],
      ["window_from", from],
      ["window_to", to],
      ["transactions_total", stats.total],
      ["added", stats.added],
      ["updated", stats.updated],
      ["unchanged", stats.unchanged],
      ["missing_from_source", stats.missingFromSource],
      ["accounts_total", accountRows.length],
      ["net_worth", netWorthTotal(rawAccounts, now, tz)],
      ["net_worth_as_of", today],
      ["balances_total", balanceRows.length],
      ["networth_days", networthRows.length],
      ["networth_from", series[0]?.date ?? ""],
      ["snapshots_appended", snap.appended],
      ["categories_total", categoryRows.length],
      ["projects_total", projectRows.length],
      ["wps_cli_version", version()],
      ["status", "ok"],
    ];
    await sink.rewriteTable(META, meta.map(([key, value]) => ({ key, value })));
    return { data: result };
  },
};
