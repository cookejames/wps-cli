import { BadArgsError } from "../errors.ts";
import { filterStale, mapAccount, sortByStaleness } from "../domain/accounts.ts";
import type { CommandDef } from "./types.ts";

export const accountsList: CommandDef = {
  group: "accounts",
  name: "list",
  summary: "List accounts (--manual, --stale-days N: manual accounts not updated for N days; archived ones hidden unless --include-archived)",
  options: {
    type: { type: "string" },
    manual: { type: "boolean" },
    "stale-days": { type: "string" },
    "include-deleted": { type: "boolean" },
    "include-archived": { type: "boolean" },
    archived: { type: "boolean" },
    "include-all-types": { type: "boolean" },
  },
  needsSession: true,
  columns: ["id", "name", "provider", "type", "manual", "balance.major", "currency", "lastUpdated", "daysSinceUpdate", "archived"],
  async run(ctx) {
    const a = ctx.args;
    let staleDays: number | undefined;
    if (a["stale-days"] !== undefined) {
      staleDays = Number(a["stale-days"]);
      if (!Number.isInteger(staleDays) || staleDays < 0) throw new BadArgsError("--stale-days must be a non-negative integer");
    }
    const now = ctx.now();
    let list = (await (await ctx.backend()).listAccounts()).map((r) => mapAccount(r, now));
    if (!a["include-deleted"]) list = list.filter((x) => !x.deleted);
    if (a.archived) list = list.filter((x) => x.archived);
    else if (!a["include-archived"]) list = list.filter((x) => !x.archived);
    if (typeof a.type === "string") list = list.filter((x) => x.type === a.type);
    if (a.manual) list = list.filter((x) => x.manual);
    if (staleDays !== undefined) {
      // Valued assets (property by default, config.staleIgnoreTypes) aren't "updated" like balances.
      if (!a["include-all-types"]) list = list.filter((x) => !(x.type && ctx.config.staleIgnoreTypes.includes(x.type)));
      list = filterStale(list, staleDays);
    }
    list = sortByStaleness(list);
    return { data: list, meta: { count: list.length, asOf: now.toISOString() } };
  },
};
