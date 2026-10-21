import type { CommandDef } from "./types.ts";

export const projectsList: CommandDef = {
  group: "projects",
  name: "list",
  summary: "List projects",
  options: {},
  needsSession: true,
  columns: ["id", "name", "type"],
  async run(ctx) {
    const projects = await (await ctx.backend()).listProjects();
    return { data: projects, meta: { count: projects.length } };
  },
};
