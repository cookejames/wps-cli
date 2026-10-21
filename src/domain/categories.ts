import type { ExtractedCategory, Category } from "../model.ts";
import type { CategoryNames, SourceCustomCategory } from "../backends/backend.ts";
import type { PublicCategories } from "../backends/public-categories.ts";

export interface CategoryIndex {
  categories: Category[];
  byId: Map<string, Category>;
  /** internal numeric id -> category */
  byInternal: Map<string, Category>;
  /** custom uuid -> category */
  customByUuid: Map<string, Category>;
}

export const titleCase = (key: string): string =>
  key
    .replace(/[-_]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase());

export interface IndexInput {
  extracted?: ExtractedCategory[];
  publicCategories?: PublicCategories | null;
  names?: CategoryNames;
  custom?: SourceCustomCategory[];
  warn?: (msg: string) => void;
}

export function buildCategoryIndex(input: IndexInput): CategoryIndex {
  const warn = input.warn ?? (() => {});
  const names = input.names ?? { categories: {}, groups: {} };
  const pub = input.publicCategories ?? null;
  const groupKeyById = new Map<string, string>();
  for (const g of pub?.groups ?? []) groupKeyById.set(g.id, g.key);
  const pubById = new Map((pub?.categories ?? []).map((c) => [c.categoryId, c]));
  const pubByKey = new Map((pub?.categories ?? []).map((c) => [c.key, c]));

  const groupInfo = (groupId: string | null) => {
    const groupKey = groupId ? (groupKeyById.get(groupId) ?? null) : null;
    const groupName = groupKey ? (names.groups[groupKey] ?? titleCase(groupKey)) : null;
    return { groupKey, groupName };
  };
  const nameFor = (key?: string): string | null => (key ? (names.categories[key] ?? null) : null);

  const categories: Category[] = [];
  const seen = new Set<string>();

  for (const e of input.extracted ?? []) {
    let externalId = e.externalId || undefined;
    const groupId = `group:${e.group}`;
    const p = externalId ? pubById.get(`std:${externalId}`) : pubByKey.get(e.key);
    if (p) {
      if (!externalId) externalId = p.categoryId.replace(/^std:/, "");
      if (p.key !== e.key) warn(`category ${e.uid}: key '${e.key}' differs from public key '${p.key}'`);
      if (p.group && p.group !== groupId) warn(`category ${e.uid} (${e.key}): group ${groupId} differs from public ${p.group}`);
    } else if (pub && externalId) {
      warn(`category ${e.uid} (${e.key}): externalId not found in public standard categories`);
    }
    const categoryId = externalId ? `std:${externalId}` : `std-numeric:${e.uid}`;
    if (seen.has(categoryId)) continue;
    seen.add(categoryId);
    categories.push({ categoryId, internalId: String(e.uid), key: e.key, name: nameFor(e.key), groupId, ...groupInfo(groupId), custom: false });
  }

  for (const p of pub?.categories ?? []) {
    if (seen.has(p.categoryId)) continue;
    seen.add(p.categoryId);
    categories.push({ categoryId: p.categoryId, key: p.key, name: nameFor(p.key), groupId: p.group || null, ...groupInfo(p.group || null), custom: false });
  }

  for (const c of input.custom ?? []) {
    const groupId = Number.isFinite(c.categoryGroup) ? `group:${c.categoryGroup}` : null;
    categories.push({ categoryId: `cus:${c.uid}`, name: c.name, groupId, ...groupInfo(groupId), custom: true });
  }

  const byId = new Map(categories.map((c) => [c.categoryId, c]));
  const byInternal = new Map(categories.filter((c) => c.internalId).map((c) => [c.internalId!, c]));
  const customByUuid = new Map(categories.filter((c) => c.custom).map((c) => [c.categoryId.slice(4), c]));
  return { categories, byId, byInternal, customByUuid };
}

export interface NormalisedCategoryId {
  categoryId: string | null;
  internalCategoryId?: string;
}

/** "12" -> std:<externalId> (or std-numeric:12); custom UUID -> cus:<uuid>; else unchanged. */
export function normaliseCategoryId(raw: string | number | null | undefined, index: CategoryIndex): NormalisedCategoryId {
  if (raw === null || raw === undefined || raw === "") return { categoryId: null };
  const s = String(raw);
  if (/^\d+$/.test(s)) {
    const c = index.byInternal.get(s);
    return { categoryId: c ? c.categoryId : `std-numeric:${s}`, internalCategoryId: s };
  }
  if (index.customByUuid.has(s.toLowerCase()) || index.customByUuid.has(s)) return { categoryId: `cus:${s}` };
  return { categoryId: s };
}

/** Resolve a user-supplied reference (id, internal id, key or name) to category ids. */
export function resolveCategoryRef(ref: string, index: CategoryIndex): string[] {
  const r = ref.trim().toLowerCase();
  return index.categories
    .filter(
      (c) =>
        c.categoryId.toLowerCase() === r ||
        c.internalId === ref.trim() ||
        c.key?.toLowerCase() === r ||
        c.name?.toLowerCase() === r,
    )
    .map((c) => c.categoryId);
}
