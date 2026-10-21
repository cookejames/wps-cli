import { BadArgsError } from "../errors.ts";
import { initDashboard } from "../sinks/dashboard.ts";
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
  summary: "Create the Transactions dashboard sheet (one formula over raw_*/ref_* sheets)",
  options: { spreadsheet: { type: "string" }, sheet: { type: "string" }, force: { type: "boolean" } },
  needsSession: false,
  async run(ctx) {
    const name = (ctx.args.sheet as string | undefined) ?? "Transactions";
    if (!name.trim()) throw new BadArgsError("--sheet must not be empty");
    const data = await initDashboard(makeSink(ctx), name, ctx.args.force === true, (m) => ctx.log.warn(m));
    return { data };
  },
};
