import { BadArgsError } from "../errors.ts";
import { BUCKETS, firstBalanceDate, networthSeries, type Interval, type NetWorthPoint } from "../domain/history.ts";
import { isDateString, toLondonDate } from "../domain/dates.ts";
import { isActive } from "../domain/accounts.ts";
import type { CommandDef } from "./types.ts";

const INTERVALS = ["day", "week", "month"];
const gbp = (n: number) => n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const networthHistory: CommandDef = {
  group: "networth",
  name: "history",
  summary: "Net worth per day/week/month over time, with per-type sums (--from, --to, --interval day|week|month, --by type for the table)",
  options: { from: { type: "string" }, to: { type: "string" }, interval: { type: "string" }, by: { type: "string" } },
  needsSession: true,
  async run(ctx) {
    const a = ctx.args;
    const interval = ((a.interval as string | undefined) ?? "day") as Interval;
    if (!INTERVALS.includes(interval)) throw new BadArgsError("--interval must be day, week or month");
    if (a.by !== undefined && a.by !== "type") throw new BadArgsError("--by must be type");
    for (const n of ["from", "to"]) if (a[n] !== undefined && !isDateString(a[n] as string)) throw new BadArgsError(`--${n} must be YYYY-MM-DD`);
    const tz = ctx.config.timezone;
    const now = ctx.now();
    const to = (a.to as string | undefined) ?? toLondonDate(now, tz);
    const raws = await (await ctx.backend()).listAccounts();
    const from = (a.from as string | undefined) ?? firstBalanceDate(raws) ?? to;
    if (from > to) throw new BadArgsError("--from is after --to");
    const points = networthSeries(raws, { from, to, interval, now, tz });
    return { data: points, meta: { count: points.length, from, to, interval, accounts: raws.filter(isActive).length } };
  },
  renderTable(data, args) {
    const rows = data as NetWorthPoint[];
    if (rows.length === 0) return "(no rows)\n";
    const keys: string[] = args.by === "type" ? ["net_worth", ...BUCKETS] : ["net_worth"];
    const table = [["date", ...keys], ...rows.map((r) => [r.date, ...keys.map((k) => gbp((r as unknown as Record<string, number>)[k]!))])];
    const w = table[0]!.map((_, i) => Math.max(...table.map((r) => r[i]!.length)));
    return table.map((r, n) => r.map((v, i) => (i > 0 && n > 0 ? v.padStart(w[i]!) : v.padEnd(w[i]!))).join("  ").trimEnd()).join("\n") + "\n";
  },
};
