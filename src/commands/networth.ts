import { BadArgsError } from "../errors.ts";
import { isActive, mapAccount, netWorthTotal } from "../domain/accounts.ts";
import { isDateString, toLondonDate } from "../domain/dates.ts";
import type { Money } from "../model.ts";
import { toMinor } from "../domain/transactions.ts";
import type { CommandDef } from "./types.ts";

type Reason = "archived" | "netWorthDisabled" | "zeroContribution" | "nonGBP" | "noBalance" | "deleted";

interface Line {
  id: string;
  name: string;
  type: string | null;
  value: Money | null;
  netWorthValue: Money;
  included: boolean;
  reason?: Reason;
}

const money = (major: number): Money => {
  const m = Math.round(major * 100) / 100;
  return { value: toMinor(m), major: m, currency: "GBP" };
};

export const networth: CommandDef = {
  group: "networth",
  name: "",
  summary: "Net worth as the web app dashboard shows it (--by type|account for the table, --date YYYY-MM-DD for an as-of date)",
  options: { by: { type: "string" }, date: { type: "string" } },
  needsSession: true,
  async run(ctx) {
    const by = (ctx.args.by as string | undefined) ?? "account";
    if (by !== "type" && by !== "account") throw new BadArgsError("--by must be type or account");
    const tz = ctx.config.timezone;
    let now = ctx.now();
    const date = ctx.args.date as string | undefined;
    if (date !== undefined) {
      if (!isDateString(date)) throw new BadArgsError("--date must be YYYY-MM-DD");
      // midday on that calendar day
      now = new Date(date + "T12:00:00Z");
    }
    const raws = await (await ctx.backend()).listAccounts();
    const asOf = date ?? toLondonDate(now, tz);
    const lines: Line[] = raws.map((r) => {
      const a = mapAccount(r, now, tz);
      let reason: Reason | undefined;
      if (!isActive(r)) reason = "deleted";
      else if (a.archived) reason = "archived";
      else if ((a.currency ?? "GBP") !== "GBP") reason = "nonGBP";
      else if (!a.netWorthEnabled) reason = "netWorthDisabled";
      else if (a.netWorthContribution === 0) reason = "zeroContribution";
      else if (a.value === null) reason = "noBalance";
      const line: Line = { id: a.id, name: a.name, type: a.type, value: a.value, netWorthValue: a.netWorthValue, included: reason === undefined };
      if (reason) line.reason = reason;
      return line;
    });
    lines.sort((x, y) => y.netWorthValue.major - x.netWorthValue.major || x.name.localeCompare(y.name));
    const byType: Record<string, number> = {};
    const activeIds = new Set(raws.filter(isActive).map((r) => r.uid));
    for (const l of lines) {
      if (!activeIds.has(l.id)) continue;
      const k = l.type ?? "unknown";
      byType[k] = Math.round(((byType[k] ?? 0) + l.netWorthValue.major) * 100) / 100;
    }
    return {
      data: { total: money(netWorthTotal(raws, now, tz)), asOf, accounts: lines, byType },
      meta: { count: lines.length, by },
    };
  },
  renderTable(data, args) {
    const d = data as { total: Money; accounts: Line[]; byType: Record<string, number> };
    const gbp = (n: number) => n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const rows: string[][] =
      args.by === "type"
        ? [["type", "netWorthValue"], ...Object.entries(d.byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, gbp(v)])]
        : [
            ["name", "type", "value", "netWorthValue", "included"],
            ...d.accounts.map((l) => [l.name, l.type ?? "", l.value ? gbp(l.value.major) : "", gbp(l.netWorthValue.major), l.reason ?? "yes"]),
          ];
    rows.push(args.by === "type" ? ["TOTAL", gbp(d.total.major)] : ["TOTAL", "", "", gbp(d.total.major), ""]);
    const w = rows[0]!.map((_, i) => Math.min(60, Math.max(...rows.map((r) => (r[i] ?? "").length))));
    const right = (c: number) => (args.by === "type" ? c === 1 : c === 2 || c === 3);
    return rows.map((r) => r.map((v, i) => (right(i) && r !== rows[0] ? v.padStart(w[i]!) : v.padEnd(w[i]!))).join("  ").trimEnd()).join("\n") + "\n";
  },
};
