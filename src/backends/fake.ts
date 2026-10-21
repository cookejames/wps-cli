// TEST ONLY: serves JSON fixtures from a directory (env WPS_FAKE_BACKEND).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AuthError, UpstreamError } from "../errors.ts";
import type { Project } from "../model.ts";
import { parseTextResources } from "./internal-web/index.ts";
import type { Backend, CategoryNames, SourceAccount, SourceCustomCategory, SourceTransaction } from "./backend.ts";

export class FakeBackend implements Backend {
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }
  private load<T>(file: string, fallback: T): T {
    const p = join(this.dir, file);
    if (!existsSync(p)) return fallback;
    return JSON.parse(readFileSync(p, "utf8")) as T;
  }
  private maybeFail(): void {
    const f = this.load<{ mode?: string } | null>("fail.json", null);
    if (f?.mode === "auth") throw new AuthError("fake backend: auth failure");
    if (f?.mode === "upstream") throw new UpstreamError("fake backend: upstream failure");
  }
  async checkSession(): Promise<void> {
    this.maybeFail();
  }
  async listTransactions(from: string, to: string): Promise<SourceTransaction[]> {
    this.maybeFail();
    return this.load<SourceTransaction[]>("transactions.json", []).filter((t) => t.date.slice(0, 10) >= from && t.date.slice(0, 10) <= to);
  }
  async listCustomCategories(): Promise<SourceCustomCategory[]> {
    this.maybeFail();
    return this.load("custom-categories.json", []);
  }
  async listAccounts(): Promise<SourceAccount[]> {
    this.maybeFail();
    return this.load("accounts.json", []);
  }
  /** Upserts by date into accounts.json (so tests must use a copy of the fixture dir) and logs to set-balance.json. */
  async setBalance(accountId: string, entry: { amount: number; date: string }): Promise<void> {
    this.maybeFail();
    const accounts = this.load<SourceAccount[]>("accounts.json", []);
    const a = accounts.find((x) => x.uid === accountId);
    if (!a) throw new UpstreamError("fake backend: no such account");
    const balances = (Array.isArray(a.balances) ? a.balances : []) as { date?: string; amount?: number }[];
    a.balances = [...balances.filter((b) => b.date !== entry.date), { date: entry.date, amount: entry.amount }];
    writeFileSync(join(this.dir, "accounts.json"), JSON.stringify(accounts));
    writeFileSync(join(this.dir, "set-balance.json"), JSON.stringify([...this.load<unknown[]>("set-balance.json", []), { accountId, ...entry }]));
  }

  async listProjects(): Promise<Project[]> {
    this.maybeFail();
    return this.load("projects.json", []);
  }
  async getCategoryNames(): Promise<CategoryNames> {
    this.maybeFail();
    return parseTextResources({ data: this.load("text-resources.json", {}) });
  }
}
