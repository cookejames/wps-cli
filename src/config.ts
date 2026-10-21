import { readFileSync } from "node:fs";
import { BadArgsError } from "./errors.ts";

export interface HistoryExclusion {
  account: string;
  from: string;
  to: string;
  reason?: string;
}

export interface Config {
  apiBase: string;
  webOrigin: string;
  tenantId: string;
  timezone: string;
  windowDays: number;
  logDir: string;
  standardCategoriesFile?: string;
  usePublicCategories: boolean;
  /** Account types never reported as stale (valued assets such as property). */
  staleIgnoreTypes: string[];
  /** Account ids never reported as stale (balances that never change, e.g. premium bonds). */
  staleIgnoreAccounts: string[];
  /** Periods in which an account is left out of the net worth history (e.g. a stalled connection tracked by a manual duplicate). Never applied to today. */
  historyExclusions: HistoryExclusion[];
  /** Google spreadsheet id for the sheets commands (optional; --spreadsheet overrides) */
  spreadsheetId?: string;
}

export const DEFAULT_CONFIG: Config = {
  apiBase: "",
  webOrigin: "",
  tenantId: "",
  timezone: "Europe/London",
  windowDays: 45,
  logDir: "./logs",
  usePublicCategories: true,
  staleIgnoreTypes: ["properties"],
  staleIgnoreAccounts: [],
  historyExclusions: [],
};

export function parseConfig(obj: unknown): Config {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) throw new BadArgsError("config must be a JSON object");
  const o = obj as Record<string, unknown>;
  const c: Config = { ...DEFAULT_CONFIG };
  const str = (k: string): string | undefined => {
    const v = o[k];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string") throw new BadArgsError(`config.${k} must be a string`);
    return v;
  };
  c.apiBase = (str("apiBase") ?? c.apiBase).replace(/\/+$/, "");
  c.webOrigin = (str("webOrigin") ?? c.webOrigin).replace(/\/+$/, "");
  c.tenantId = str("tenantId") ?? c.tenantId;
  c.timezone = str("timezone") ?? c.timezone;
  c.logDir = str("logDir") ?? c.logDir;
  c.standardCategoriesFile = str("standardCategoriesFile");
  c.spreadsheetId = str("spreadsheetId");
  if (o.windowDays !== undefined) {
    if (typeof o.windowDays !== "number" || !Number.isInteger(o.windowDays) || o.windowDays < 1) {
      throw new BadArgsError("config.windowDays must be a positive integer");
    }
    c.windowDays = o.windowDays;
  }
  if (o.usePublicCategories !== undefined) {
    if (typeof o.usePublicCategories !== "boolean") throw new BadArgsError("config.usePublicCategories must be a boolean");
    c.usePublicCategories = o.usePublicCategories;
  }
  if (o.staleIgnoreTypes !== undefined) {
    if (!Array.isArray(o.staleIgnoreTypes) || !o.staleIgnoreTypes.every((t) => typeof t === "string")) {
      throw new BadArgsError("config.staleIgnoreTypes must be an array of account type strings");
    }
    c.staleIgnoreTypes = o.staleIgnoreTypes as string[];
  }
  if (o.staleIgnoreAccounts !== undefined) {
    if (!Array.isArray(o.staleIgnoreAccounts) || !o.staleIgnoreAccounts.every((t) => typeof t === "string")) {
      throw new BadArgsError("config.staleIgnoreAccounts must be an array of account ids");
    }
    c.staleIgnoreAccounts = o.staleIgnoreAccounts as string[];
  }
  if (o.historyExclusions !== undefined) {
    if (!Array.isArray(o.historyExclusions)) throw new BadArgsError("config.historyExclusions must be an array");
    c.historyExclusions = o.historyExclusions.map((e, i) => {
      const at = `config.historyExclusions[${i}]`;
      if (typeof e !== "object" || e === null || Array.isArray(e)) throw new BadArgsError(`${at} must be an object`);
      const x = e as Record<string, unknown>;
      if (typeof x.account !== "string" || x.account === "") throw new BadArgsError(`${at}.account must be an account id`);
      for (const k of ["from", "to"]) {
        if (typeof x[k] !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(x[k] as string)) throw new BadArgsError(`${at}.${k} must be YYYY-MM-DD`);
      }
      if ((x.from as string) > (x.to as string)) throw new BadArgsError(`${at}: from is after to`);
      if (x.reason !== undefined && typeof x.reason !== "string") throw new BadArgsError(`${at}.reason must be a string`);
      return { account: x.account, from: x.from as string, to: x.to as string, ...(x.reason !== undefined ? { reason: x.reason as string } : {}) };
    });
  }
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: c.timezone });
  } catch {
    throw new BadArgsError(`config.timezone '${c.timezone}' is not a valid time zone`);
  }
  return c;
}

/** Load config from --config, else WPS_CONFIG, else defaults (API settings then missing). */
export function loadConfig(path: string | undefined, env: NodeJS.ProcessEnv = process.env): Config {
  const p = path ?? env.WPS_CONFIG;
  if (!p) return { ...DEFAULT_CONFIG };
  let text: string;
  try {
    text = readFileSync(p, "utf8");
  } catch {
    throw new BadArgsError(`cannot read config file '${p}'`);
  }
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new BadArgsError(`config file '${p}' is not valid JSON`);
  }
  return parseConfig(obj);
}

/** The API backend needs these; checked lazily when it is created. */
export function requireApiConfig(c: Config): void {
  const missing = (["apiBase", "webOrigin", "tenantId"] as const).filter((k) => !c[k]);
  if (missing.length) throw new BadArgsError(`config is missing: ${missing.join(", ")} (use --config or WPS_CONFIG)`);
}
