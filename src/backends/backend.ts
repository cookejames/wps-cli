import type { Project } from "../model.ts";

/** Shapes as returned by a backend (validated minimally, tolerant of extras). */
export interface SourceTransaction {
  uid: string;
  accountUid?: string;
  amount: number;
  currency?: string;
  date: string;
  dateOnStatement?: string;
  dateModified?: string;
  dateCreated?: string;
  description?: string;
  cleanDescription?: string;
  merchantName?: string;
  notes?: string;
  label?: string;
  categoryId?: string | number | null;
  categoryIdConfirmed?: boolean;
  projectId?: string | null;
  status?: string;
  deleted?: boolean;
  counterpartyId?: string | null;
  [k: string]: unknown;
}

export interface SourceCustomCategory {
  uid: string;
  name: string;
  categoryGroup: number;
}

export interface SourceAccount {
  uid: string;
  deleted?: boolean;
  auto?: boolean;
  accountName?: string | null;
  providerAccountName?: string | null;
  productName?: string | null;
  closed?: string | boolean | null;
  parties?: unknown;
  bankName?: string | null;
  type?: string | null;
  accountType?: string | null;
  currency?: string | null;
  currentBalance?: unknown;
  balances?: unknown;
  providerLastUpdated?: string | null;
  netWorthContribution?: unknown;
  netWorthEnabled?: boolean | null;
  yearlyAppreciation?: number | null;
  deletedConnection?: boolean | null;
  /** pension: "definedContribution" | "definedBenefit" */
  subType?: string | null;
  /** defined benefit pension: annual income (major units) */
  income?: number | null;
  /** defined benefit pension: the date the income was valued at (often missing) */
  incomeDate?: string | null;
  dateBenefitStarts?: string | null;
  employeeContribution?: unknown;
  employerContribution?: unknown;
  [k: string]: unknown;
}

export interface CategoryNames {
  /** category key -> display name */
  categories: Record<string, string>;
  /** group key -> display name (empty if the source has none) */
  groups: Record<string, string>;
}

export interface Backend {
  checkSession(): Promise<void>;
  listTransactions(from: string, to: string): Promise<SourceTransaction[]>;
  listCustomCategories(): Promise<SourceCustomCategory[]>;
  listAccounts(): Promise<SourceAccount[]>;
  listProjects(): Promise<Project[]>;
  getCategoryNames(): Promise<CategoryNames>;
  /** Add (or replace, for the same date) a balance entry of a manual account: amount in major units, date YYYY-MM-DD. */
  setBalance(accountId: string, entry: { amount: number; date: string }): Promise<void>;
}
