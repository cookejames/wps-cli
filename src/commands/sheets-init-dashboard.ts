import { BadArgsError } from "../errors.ts";
import { initDashboard, initNetWorth, NETWORTH_SHEET } from "../sinks/dashboard.ts";
import { SheetsSink } from "../sinks/sheets.ts";
import type { CommandContext, CommandDef } from "./types.ts";

export function makeSink(ctx: CommandContext): SheetsSink {
  const id = (ctx.args.spreadsheet as string | undefined) ?? ctx.config.spreadsheetId;
  if (!id) throw new BadArgsError("no spreadsheet: pass --spreadsheet <id> or set spreadsheetId in the config");
  const backoff = Number(ctx.env.WPS_GWS_BACKOFF_MS);
  return new SheetsSink({
    spreadsheetId: id,
    bin: ctx.env.WPS_GWS_BIN || "gws",
    timezone: ctx.config.timezone,
    log: ctx.log,
    ...(ctx.env.WPS_GWS_BACKOFF_MS !== undefined && Number.isFinite(backoff) ? { backoffMs: backoff } : {}),
  });
}

export const sheetsInitDashboard: CommandDef = {
  group: "sheets",
  name: "init-dashboard",
  summary: "Create the Transactions and Net worth dashboard sheets (formulas over raw_*/ref_* sheets; a Net worth sheet that exists is never touched; --only transactions|networth)",
  options: { spreadsheet: { type: "string" }, sheet: { type: "string" }, force: { type: "boolean" }, only: { type: "string" } },
  needsSession: false,
  async run(ctx) {
    const only = ctx.args.only as string | undefined;
    if (only !== undefined && only !== "transactions" && only !== "networth") throw new BadArgsError("--only must be transactions or networth");
    const name = (ctx.args.sheet as string | undefined) ?? "Transactions";
    if (!name.trim()) throw new BadArgsError("--sheet must not be empty");
    const sink = makeSink(ctx);
    const warn = (m: string) => ctx.log.warn(m);
    const data: Record<string, unknown> = only === "networth" ? {} : { ...(await initDashboard(sink, name, ctx.args.force === true, warn)) };
    if (only !== "transactions") data.netWorth = await initNetWorth(sink, NETWORTH_SHEET, warn);
    return { data };
  },
};
