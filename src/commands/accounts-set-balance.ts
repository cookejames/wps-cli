import { BadArgsError, UpstreamError } from "../errors.ts";
import { archiveOf, balanceForDate, isActive, mapAccount } from "../domain/accounts.ts";
import { isDateString, toLondonDate } from "../domain/dates.ts";
import type { SourceAccount } from "../backends/backend.ts";
import type { CommandDef } from "./types.ts";

// As the web app's getBalance: liabilities are always stored negative, whatever sign is typed.
const NEGATIVE_TYPES = new Set(["mortgage", "loan"]);

interface Change {
  id: string;
  name: string;
  type: string | null;
  oldBalance: number | null;
  oldBalanceDate: string | null;
  amount: number;
  date: string;
}

/** `<id or unique id prefix of 8+ chars>=<amount>`; the amount may have commas, a £ sign and up to 2 decimals. */
export function parseSet(s: string): { ref: string; amount: number } {
  const m = /^([\w-]{8,})=(.+)$/.exec(s.trim());
  if (!m) throw new BadArgsError(`--set '${s}': expected <account id>=<amount>`);
  const txt = m[2]!.replace(/[£,\s]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(txt)) throw new BadArgsError(`--set '${s}': amount must be a number with at most 2 decimals`);
  return { ref: m[1]!.toLowerCase(), amount: Number(txt) };
}

function resolve(raws: SourceAccount[], ref: string): SourceAccount {
  const hits = raws.filter((r) => r.uid.toLowerCase() === ref || r.uid.toLowerCase().startsWith(ref));
  if (hits.length === 0) throw new BadArgsError(`no account matches '${ref}'`);
  if (hits.length > 1) throw new BadArgsError(`'${ref}' matches ${hits.length} accounts; use more of the id`);
  return hits[0]!;
}

export const accountsSetBalance: CommandDef = {
  group: "accounts",
  name: "set-balance",
  summary: "Set the balance of manual accounts (--set <id>=<amount>, repeatable; --date, default today). Dry-run unless --yes",
  options: { set: { type: "string", multiple: true }, date: { type: "string" } },
  needsSession: true,
  mutating: true,
  columns: ["id", "name", "type", "oldBalance", "oldBalanceDate", "amount", "date", "status"],
  async run(ctx) {
    const sets = (ctx.args.set as string[] | undefined) ?? [];
    if (sets.length === 0) throw new BadArgsError("give at least one --set <account id>=<amount>");
    const tz = ctx.config.timezone;
    const now = ctx.now();
    const today = toLondonDate(now, tz);
    const date = (ctx.args.date as string | undefined) ?? today;
    if (!isDateString(date)) throw new BadArgsError("--date must be YYYY-MM-DD");
    if (date > today) throw new BadArgsError("--date is in the future");
    const parsed = sets.map(parseSet);

    const backend = await ctx.backend();
    const raws = await backend.listAccounts();
    // Check everything before changing anything.
    const changes: Change[] = parsed.map(({ ref, amount }) => {
      const r = resolve(raws, ref);
      const a = mapAccount(r, now, tz);
      if (!isActive(r)) throw new BadArgsError(`${a.name}: account is deleted`);
      if (archiveOf(r.closed, now).archived) throw new BadArgsError(`${a.name}: account is archived`);
      if (r.auto === true) throw new BadArgsError(`${a.name}: connected account; its balance comes from the provider`);
      return {
        id: a.id, name: a.name, type: a.type, oldBalance: a.balance?.major ?? null, oldBalanceDate: a.balanceDate,
        amount: NEGATIVE_TYPES.has(String(r.type)) ? -Math.abs(amount) : amount, date,
      };
    });
    const dup = changes.find((c, i) => changes.findIndex((x) => x.id === c.id) !== i);
    if (dup) throw new BadArgsError(`${dup.name}: given more than once`);

    let dryRun = true;
    for (const c of changes) {
      const res = await ctx.mutate(
        { target: c.id, change: { from: c.oldBalance, to: c.amount, date: c.date }, request: { method: "PUT", path: `/apiv2/accounts/${c.id}/balances`, body: { amount: c.amount, date: c.date } } },
        () => backend.setBalance(c.id, { amount: c.amount, date: c.date }),
      );
      dryRun = res.dryRun;
    }
    if (dryRun) return { data: changes.map((c) => ({ ...c, status: "dry-run" })), meta: { dryRun: true, count: changes.length } };

    // Read back: the balance in force on that date must be the new amount.
    const after = await backend.listAccounts();
    const rows = changes.map((c) => {
      const r = after.find((x) => x.uid === c.id);
      const b = r ? balanceForDate(r.balances, c.date) : undefined;
      return { ...c, status: b?.amount === c.amount ? "updated" : "not confirmed" };
    });
    const failed = rows.filter((r) => r.status !== "updated");
    if (failed.length) throw new UpstreamError(`balance not confirmed after update: ${failed.map((f) => f.name).join(", ")}`);
    return { data: rows, meta: { dryRun: false, count: rows.length } };
  },
};
