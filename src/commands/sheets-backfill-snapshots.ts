import { BadArgsError, SinkError } from "../errors.ts";
import { mapAccount } from "../domain/accounts.ts";
import { addDays, isDateString, toLondonDate } from "../domain/dates.ts";
import { firstBalanceDate, isExcludedOn, snapshotBackfillDays, type Interval } from "../domain/history.ts";
import { canonicalIso } from "../sinks/serial.ts";
import { decodeRows, RAW_SNAPSHOTS, snapshotRow, type Row } from "../sinks/tables.ts";
import { makeSink } from "./sheets-init-dashboard.ts";
import type { CommandDef } from "./types.ts";

const INTERVALS = ["month", "day"];

export const sheetsBackfillSnapshots: CommandDef = {
  group: "sheets",
  name: "backfill-snapshots",
  summary:
    "Fill raw_account_snapshots before its first recorded day with rows rebuilt from the balance history (source 'rebuilt'; --interval month|day, --from, --dry-run)",
  options: { interval: { type: "string" }, from: { type: "string" }, spreadsheet: { type: "string" }, "dry-run": { type: "boolean" } },
  needsSession: true,
  async run(ctx) {
    const a = ctx.args;
    const interval = ((a.interval as string | undefined) ?? "month") as Interval;
    if (!INTERVALS.includes(interval)) throw new BadArgsError("--interval must be month or day");
    if (a.from !== undefined && !isDateString(a.from as string)) throw new BadArgsError("--from must be YYYY-MM-DD");
    const tz = ctx.config.timezone;
    const now = ctx.now();
    const today = toLondonDate(now, tz);
    const sink = makeSink(ctx);

    // Existing rows first (before any API traffic): recorded rows are kept as they are, earlier rebuilt ones replaced.
    let existing: Row[] = [];
    if ((await sink.listSheets()).some((s) => s.title === RAW_SNAPSHOTS.sheet)) {
      const grid = await sink.readValues(RAW_SNAPSHOTS.sheet);
      if (grid.length > 0 && !grid[0]!.map(String).includes("snapshot_date")) throw new SinkError(`${RAW_SNAPSHOTS.sheet} has no 'snapshot_date' header; not touching it`);
      existing = decodeRows(RAW_SNAPSHOTS, grid, tz);
    }
    // rows from before the source column are recorded ones
    const recorded = existing.filter((r) => r.source !== "rebuilt").map((r): Row => ({ ...r, source: "recorded" }));
    const firstRecorded = recorded.reduce<string | null>((m, r) => {
      const d = String(r.snapshot_date ?? "");
      return d && (m === null || d < m) ? d : m;
    }, null);
    const end = addDays(firstRecorded ?? today, -1);

    const raws = await (await ctx.backend()).listAccounts();
    const from = (a.from as string | undefined) ?? firstBalanceDate(raws);
    const days = from && from <= end ? snapshotBackfillDays(from, end, interval) : [];
    const syncedAt = canonicalIso(now.toISOString(), tz);
    const exclusions = ctx.config.historyExclusions;
    const rebuilt: Row[] = [];
    for (const day of days) {
      const at = new Date(day + "T12:00:00Z"); // as `networth --date` and the history
      for (const r of raws) {
        const acc = mapAccount(r, at, tz);
        if (acc.balance === null) continue; // not in WPS yet on that day
        const row = snapshotRow(acc, day, syncedAt, tz, "rebuilt");
        // same as raw_networth: an excluded account counts 0 that day
        if (isExcludedOn(exclusions, r.uid, day)) row.netWorthValue = 0;
        rebuilt.push(row);
      }
    }
    const byDayName = (x: Row, y: Row) => String(x.snapshot_date).localeCompare(String(y.snapshot_date)) || String(x.name ?? "").localeCompare(String(y.name ?? ""));
    const rows = [...rebuilt.sort(byDayName), ...recorded];
    const result = {
      interval,
      from: days[0] ?? null,
      to: days[days.length - 1] ?? null,
      days: days.length,
      rebuilt: rebuilt.length,
      replacedRebuilt: existing.length - recorded.length,
      recordedKept: recorded.length,
      firstRecorded,
      ...(a["dry-run"] === true ? { dryRun: true } : {}),
    };
    if (a["dry-run"] === true) return { data: result };
    await sink.rewriteTable(RAW_SNAPSHOTS, rows);
    return { data: result };
  },
};
