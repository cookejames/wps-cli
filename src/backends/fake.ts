// TEST ONLY: serves JSON fixtures from a directory (env WPS_FAKE_BACKEND).
import { existsSync, readFileSync } from "node:fs";
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
  async listProjects(): Promise<Project[]> {
    this.maybeFail();
    return this.load("projects.json", []);
  }
  async getCategoryNames(): Promise<CategoryNames> {
    this.maybeFail();
    return parseTextResources({ data: this.load("text-resources.json", {}) });
  }
}
