import { loadCategoryIndex } from "../catalog.ts";
import type { CommandDef } from "./types.ts";

export const categoriesList: CommandDef = {
  group: "categories",
  name: "list",
  summary: "List standard and custom categories",
  options: { "custom-only": { type: "boolean" } },
  needsSession: true,
  columns: ["categoryId", "internalId", "key", "name", "groupKey", "groupName", "custom"],
  async run(ctx) {
    const index = await loadCategoryIndex(ctx);
    const list = ctx.args["custom-only"] ? index.categories.filter((c) => c.custom) : index.categories;
    return { data: list, meta: { count: list.length } };
  },
};
