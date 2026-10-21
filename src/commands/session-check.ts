import type { CommandDef } from "./types.ts";

export const sessionCheck: CommandDef = {
  group: "session",
  name: "check",
  summary: "Check that the piped session is valid",
  options: {},
  needsSession: true,
  async run(ctx) {
    await (await ctx.backend()).checkSession();
    return { data: { valid: true } };
  },
};
