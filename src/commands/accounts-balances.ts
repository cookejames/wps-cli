import { BadArgsError } from "../errors.ts";
import { flattenBalances } from "../domain/history.ts";
import { isDateString } from "../domain/dates.ts";
import type { CommandDef } from "./types.ts";

export const accountsBalances: CommandDef = {
  group: "accounts",
  name: "balances",
  summary: "Balance history, one entry per recorded balance (--account <id>, --from, --to; deleted/archived accounts hidden unless --include-deleted/--include-archived)",
  options: {
    account: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    "include-deleted": { type: "boolean" },
    "include-archived": { type: "boolean" },
  },
  needsSession: true,
  columns: ["date", "accountName", "accountType", "amount", "entryType", "tag", "accountId", "archived"],
  async run(ctx) {
    const a = ctx.args;
    for (const n of ["from", "to"]) if (a[n] !== undefined && !isDateString(a[n] as string)) throw new BadArgsError(`--${n} must be YYYY-MM-DD`);
    const now = ctx.now();
    let list = flattenBalances(await (await ctx.backend()).listAccounts(), now);
    if (typeof a.account === "string") list = list.filter((x) => x.accountId === a.account);
    if (!a["include-deleted"]) list = list.filter((x) => x.active);
    if (!a["include-archived"]) list = list.filter((x) => !x.archived);
    const from = a.from as string | undefined;
    const to = a.to as string | undefined;
    if (from !== undefined) list = list.filter((x) => x.date !== null && x.date >= from);
    if (to !== undefined) list = list.filter((x) => x.date !== null && x.date <= to);
    return { data: list, meta: { count: list.length, asOf: now.toISOString() } };
  },
};
