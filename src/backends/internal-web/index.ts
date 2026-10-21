import type { Config } from "../../config.ts";
import { UpstreamError } from "../../errors.ts";
import type { Project, ProjectType } from "../../model.ts";
import type { Session } from "../../session.ts";
import { redact } from "../../session.ts";
import type { Backend, CategoryNames, SourceAccount, SourceCustomCategory, SourceTransaction } from "../backend.ts";
import { HttpClient } from "./http.ts";
import { isRec, requireString, resultArray, type Rec } from "./guards.ts";

const PROJECTS_QUERY =
  "query { genericProjects: projects(type: GenericProject) { id name __typename } propertyProjects: projects(type: PropertyProject) { id name __typename } }";

export class InternalWebBackend implements Backend {
  private readonly http: HttpClient;
  private readonly config: Config;

  constructor(config: Config, session: Session, fetchImpl?: typeof fetch, pauseMs?: [number, number]) {
    this.config = config;
    this.http = new HttpClient(config, session, fetchImpl, pauseMs);
  }

  async checkSession(): Promise<void> {
    await this.http.request("GET", "/apiv2/profile");
  }

  async listTransactions(from: string, to: string): Promise<SourceTransaction[]> {
    const body = await this.http.request("GET", `/apiV2/transactions?startDate=${from}&endDate=${to}`);
    const items = resultArray(body, "transactions");
    items.forEach((it, i) => {
      requireString(it, "uid", "transactions", i);
      requireString(it, "date", "transactions", i);
      if (typeof it.amount !== "number") throw new UpstreamError(`transactions: item ${i} has no numeric 'amount'`);
    });
    return items as SourceTransaction[];
  }

  async listCustomCategories(): Promise<SourceCustomCategory[]> {
    const items = resultArray(await this.http.request("GET", "/apiV2/customCategories"), "customCategories");
    items.forEach((it, i) => {
      requireString(it, "uid", "customCategories", i);
      requireString(it, "name", "customCategories", i);
    });
    return items.map((it) => ({ uid: it.uid as string, name: it.name as string, categoryGroup: Number(it.categoryGroup) }));
  }

  async listAccounts(): Promise<SourceAccount[]> {
    const items = resultArray(await this.http.request("GET", "/apiv2/accounts"), "accounts");
    items.forEach((it, i) => requireString(it, "uid", "accounts", i));
    return items as SourceAccount[];
  }

  async listProjects(): Promise<Project[]> {
    const body = await this.http.request("POST", "/graphql", { query: PROJECTS_QUERY, variables: {} });
    if (!isRec(body)) throw new UpstreamError("graphql: unexpected response shape");
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      const first = body.errors[0];
      const msg = isRec(first) && typeof first.message === "string" ? first.message : "unknown";
      throw new UpstreamError(redact(`graphql error: ${msg}`));
    }
    if (!isRec(body.data)) throw new UpstreamError("graphql: response has no data");
    const out: Project[] = [];
    const take = (list: unknown, type: ProjectType) => {
      if (list === null || list === undefined) return;
      if (!Array.isArray(list)) throw new UpstreamError("graphql: project list is not an array");
      for (const p of list) {
        if (!isRec(p) || typeof p.id !== "string" || typeof p.name !== "string") throw new UpstreamError("graphql: malformed project");
        out.push({ id: p.id, name: p.name, type });
      }
    };
    take(body.data.genericProjects, "GenericProject");
    take(body.data.propertyProjects, "PropertyProject");
    return out;
  }

  async getCategoryNames(): Promise<CategoryNames> {
    const body = await this.http.request(
      "GET",
      `/text/resources?tenantId=${encodeURIComponent(this.config.tenantId)}&type=postlogin`,
    );
    return parseTextResources(body);
  }
}

const strMap = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (isRec(v)) for (const [k, val] of Object.entries(v)) if (typeof val === "string") out[k] = val;
  return out;
};

/** data.categories[key] = display name; optionally a category-groups section. */
export function parseTextResources(body: unknown): CategoryNames {
  if (!isRec(body) || !isRec(body.data)) throw new UpstreamError("text resources: unexpected response shape");
  const data: Rec = body.data;
  const categories = strMap(data.categories);
  let groups: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    if (/category-?groups/i.test(k)) groups = { ...groups, ...strMap(v) };
  }
  return { categories, groups };
}
