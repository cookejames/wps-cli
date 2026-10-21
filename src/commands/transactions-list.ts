import { loadCategoryIndex } from "../catalog.ts";
import { BadArgsError } from "../errors.ts";
import { resolveCategoryRef } from "../domain/categories.ts";
import { addDays, isDateString, toLondonDate } from "../domain/dates.ts";
import { mapTransaction } from "../domain/transactions.ts";
import type { CommandDef } from "./types.ts";

export const transactionsList: CommandDef = {
  group: "transactions",
  name: "list",
  summary: "List transactions in a date range (default: the last windowDays days)",
  options: {
    from: { type: "string" },
    to: { type: "string" },
    account: { type: "string" },
    project: { type: "string" },
    category: { type: "string" },
    text: { type: "string" },
    "include-deleted": { type: "boolean" },
    raw: { type: "boolean" },
    limit: { type: "string" },
  },
  needsSession: true,
  columns: ["bookingDate", "amount.major", "categoryName", "projectName", "shortDescription", "accountId"],
  async run(ctx) {
    const a = ctx.args;
    const today = toLondonDate(ctx.now(), ctx.config.timezone);
    const to = (a.to as string | undefined) ?? today;
    const from = (a.from as string | undefined) ?? addDays(to, -ctx.config.windowDays);
    for (const [n, v] of [["--from", from], ["--to", to]] as const) {
      if (!isDateString(v)) throw new BadArgsError(`${n} must be YYYY-MM-DD`);
    }
    if (from > to) throw new BadArgsError("--from is after --to");
    let limit: number | undefined;
    if (a.limit !== undefined) {
      limit = Number(a.limit);
      if (!Number.isInteger(limit) || limit < 1) throw new BadArgsError("--limit must be a positive integer");
    }

    const backend = await ctx.backend();
    const [rawTx, index, projects] = await Promise.all([backend.listTransactions(from, to), loadCategoryIndex(ctx), backend.listProjects()]);
    const projectName = new Map(projects.map((p) => [p.id, p.name]));

    let catIds: Set<string> | undefined;
    if (typeof a.category === "string") {
      const ids = resolveCategoryRef(a.category, index);
      if (ids.length === 0) throw new BadArgsError(`no category matches '${a.category}'`);
      catIds = new Set(ids);
    }
    const text = typeof a.text === "string" ? a.text.toLowerCase() : undefined;

    let txs = rawTx.map((r) => mapTransaction(r, { index, timezone: ctx.config.timezone, includeRaw: a.raw === true }));
    if (!a["include-deleted"]) txs = txs.filter((t) => !t.deleted);
    if (typeof a.account === "string") txs = txs.filter((t) => t.accountId === a.account);
    if (typeof a.project === "string") txs = txs.filter((t) => t.projectId === a.project);
    if (catIds) txs = txs.filter((t) => t.categoryId !== null && catIds!.has(t.categoryId));
    if (text) {
      txs = txs.filter((t) =>
        [t.shortDescription, t.longDescription, t.merchantName, t.notes, t.label].some((s) => s?.toLowerCase().includes(text)),
      );
    }
    txs.sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
    const matched = txs.length;
    if (limit !== undefined) txs = txs.slice(0, limit);

    const rows = txs.map((t) => ({
      ...t,
      categoryName: (t.categoryId && index.byId.get(t.categoryId)?.name) || null,
      projectName: (t.projectId && projectName.get(t.projectId)) || null,
    }));
    let inMinor = 0;
    let outMinor = 0;
    for (const t of txs) (t.amount.value >= 0 ? (inMinor += t.amount.value) : (outMinor += t.amount.value));
    return {
      data: rows,
      meta: { count: rows.length, matched, from, to, totalIn: inMinor / 100, totalOut: outMinor / 100 },
    };
  },
};
