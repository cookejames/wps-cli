import type { SourceTransaction } from "../backends/backend.ts";
import type { Transaction } from "../model.ts";
import { normaliseCategoryId, type CategoryIndex } from "./categories.ts";
import { toLondonDate } from "./dates.ts";

export const toMinor = (major: number): number => Math.round(major * 100);

const nonEmpty = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

export function mapTransaction(
  raw: SourceTransaction,
  opts: { index: CategoryIndex; timezone?: string; includeRaw?: boolean },
): Transaction {
  const cat = normaliseCategoryId(raw.categoryId, opts.index);
  const t: Transaction = {
    id: raw.uid,
    accountId: String(raw.accountUid ?? ""),
    date: raw.date,
    bookingDate: toLondonDate(raw.date, opts.timezone ?? "Europe/London"),
    dateOnStatement: nonEmpty(raw.dateOnStatement),
    amount: { value: toMinor(raw.amount), major: raw.amount, currency: raw.currency || "GBP" },
    shortDescription: raw.cleanDescription ?? "",
    longDescription: raw.description ?? "",
    merchantName: nonEmpty(raw.merchantName),
    notes: raw.notes ?? "",
    label: nonEmpty(raw.label),
    categoryId: cat.categoryId,
    internalCategoryId: cat.internalCategoryId,
    categoryIdConfirmed: raw.categoryIdConfirmed === true,
    projectId: nonEmpty(raw.projectId),
    status: raw.status ?? "",
    deleted: raw.deleted === true,
    dateModified: raw.dateModified ?? raw.dateCreated ?? "",
    counterpartyId: nonEmpty(raw.counterpartyId),
  };
  if (opts.includeRaw) t.raw = raw;
  return t;
}
