// Normalised model, named after the public Moneyhub Data API.

export interface Money {
  /** integer minor units (pence) */
  value: number;
  /** major units (pounds) */
  major: number;
  currency: string;
}

export interface Transaction {
  id: string;
  accountId: string;
  /** ISO UTC timestamp */
  date: string;
  /** local calendar date (config timezone), YYYY-MM-DD */
  bookingDate: string;
  dateOnStatement?: string;
  amount: Money;
  shortDescription: string;
  longDescription: string;
  merchantName?: string;
  notes: string;
  label?: string;
  /** std:<uuid> | cus:<uuid> | std-numeric:<n> | as-is | null */
  categoryId: string | null;
  internalCategoryId?: string;
  categoryIdConfirmed: boolean;
  projectId?: string;
  status: string;
  deleted: boolean;
  dateModified: string;
  counterpartyId?: string;
  raw?: unknown;
}

export interface Category {
  categoryId: string;
  internalId?: string;
  key?: string;
  name: string | null;
  groupId: string | null;
  groupKey: string | null;
  groupName: string | null;
  custom: boolean;
}

export type ProjectType = "GenericProject" | "PropertyProject";

export interface Project {
  id: string;
  name: string;
  type: ProjectType;
}

export interface Account {
  id: string;
  name: string;
  provider: string | null;
  type: string | null;
  accountType: string | null;
  auto: boolean;
  manual: boolean;
  currency: string | null;
  /** The last recorded balance (rule: balance in force today), not the dashboard value. */
  balance: Money | null;
  balanceDate: string | null;
  /** What the web app dashboard shows for the account today (property/asset values appreciate). */
  value: Money | null;
  providerLastUpdated: string | null;
  lastUpdated: string | null;
  daysSinceUpdate: number | null;
  deleted: boolean;
  /** Archived in the web app ("Archived on"): the source's `closed` date is in the past. */
  archived: boolean;
  archivedAt: string | null;
  /** false only when the source says so */
  netWorthEnabled: boolean;
  /** percentage of the value counted towards net worth (100 when the source has none) */
  netWorthContribution: number;
  /** what this account adds to the dashboard net worth (0 when excluded) */
  netWorthValue: Money;
  yearlyAppreciation: number | null;
  /** not deleted and its connection is not deleted */
  active: boolean;
}

/** Entry of the extracted internal numeric standard-category table. */
export interface ExtractedCategory {
  uid: number;
  key: string;
  group: number;
  externalId?: string | null;
}
