import { existsSync, readFileSync } from "node:fs";
import { UpstreamError } from "./errors.ts";
import { buildCategoryIndex, type CategoryIndex } from "./domain/categories.ts";
import type { ExtractedCategory } from "./model.ts";
import type { CommandContext } from "./commands/types.ts";

/** Read the generated numeric-id table; warn (once) and return [] if it is missing. */
export function loadExtracted(path: string | undefined, warn: (m: string) => void): ExtractedCategory[] {
  if (!path || !existsSync(path)) {
    warn(`standard categories file ${path ? `'${path}' not found` : "not configured"}; numeric category ids map to std-numeric:<id> with no name (run 'wps dev extract-categories')`);
    return [];
  }
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new UpstreamError(`standard categories file '${path}' is not valid JSON`);
  }
  if (!Array.isArray(data)) throw new UpstreamError(`standard categories file '${path}' must be a JSON array`);
  return data.flatMap((e: any) =>
    e && typeof e.uid === "number" && typeof e.key === "string" && typeof e.group === "number"
      ? [{ uid: e.uid, key: e.key, group: e.group, externalId: typeof e.externalId === "string" ? e.externalId : null }]
      : [],
  );
}

/** Merge extracted table + public lists + text resource names + custom categories. */
export async function loadCategoryIndex(ctx: CommandContext): Promise<CategoryIndex> {
  const backend = await ctx.backend();
  const [custom, names, pub] = await Promise.all([backend.listCustomCategories(), backend.getCategoryNames(), ctx.publicCategories()]);
  const extracted = loadExtracted(ctx.config.standardCategoriesFile, (m) => ctx.log.warn(m));
  return buildCategoryIndex({ extracted, publicCategories: pub, names, custom, warn: (m) => ctx.log.warn(m) });
}
