import { UpstreamError } from "../errors.ts";

export interface PublicCategory { categoryId: string; group: string; key: string }
export interface PublicGroup { id: string; key: string }
export interface PublicCategories { categories: PublicCategory[]; groups: PublicGroup[] }

const BASE = "https://api.moneyhub.co.uk/v2.0";

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function parsePublicCategories(catsBody: unknown, groupsBody: unknown): PublicCategories {
  const cats = isRec(catsBody) && Array.isArray(catsBody.data) ? catsBody.data : null;
  const groups = isRec(groupsBody) && Array.isArray(groupsBody.data) ? groupsBody.data : null;
  if (!cats || !groups) throw new UpstreamError("unexpected shape from public categories endpoints");
  return {
    categories: cats.flatMap((c) =>
      isRec(c) && typeof c.categoryId === "string" && typeof c.key === "string"
        ? [{ categoryId: c.categoryId, group: String(c.group ?? ""), key: c.key }]
        : [],
    ),
    groups: groups.flatMap((g) => (isRec(g) && typeof g.id === "string" && typeof g.key === "string" ? [{ id: g.id, key: g.key }] : [])),
  };
}

export async function fetchPublicCategories(fetchImpl: typeof fetch = fetch): Promise<PublicCategories> {
  const get = async (p: string) => {
    const res = await fetchImpl(`${BASE}/${p}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new UpstreamError(`public ${p} returned HTTP ${res.status}`);
    return res.json();
  };
  const [c, g] = await Promise.all([get("standard-categories"), get("standard-category-groups")]);
  return parsePublicCategories(c, g);
}
