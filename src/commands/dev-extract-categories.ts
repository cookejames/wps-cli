import { readFileSync, writeFileSync } from "node:fs";
import { BadArgsError, UpstreamError } from "../errors.ts";
import { extractCategories } from "../domain/extract.ts";
import type { ExtractedCategory } from "../model.ts";
import type { CommandDef } from "./types.ts";

export const devExtractCategories: CommandDef = {
  group: "dev",
  name: "extract-categories",
  summary: "Extract the numeric standard-category table from the web app's JS bundle",
  options: {
    "bundle-url": { type: "string", multiple: true },
    "bundle-file": { type: "string", multiple: true },
    out: { type: "string" },
  },
  needsSession: false,
  columns: ["uid", "key", "group", "externalId"],
  async run(ctx) {
    const urls = (ctx.args["bundle-url"] as string[] | undefined) ?? [];
    const files = (ctx.args["bundle-file"] as string[] | undefined) ?? [];
    if (urls.length + files.length === 0) throw new BadArgsError("give at least one --bundle-url or --bundle-file");
    const sources: string[] = [];
    for (const f of files) {
      try {
        sources.push(readFileSync(f, "utf8"));
      } catch {
        throw new BadArgsError(`cannot read bundle file '${f}'`);
      }
    }
    for (const u of urls) {
      if (!/^https:\/\//.test(u)) throw new BadArgsError("--bundle-url must be an https URL");
      ctx.log.info(`fetching bundle ${u.split("?")[0]}`);
      const res = await fetch(u, { headers: { accept: "*/*" }, signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new UpstreamError(`bundle fetch returned HTTP ${res.status}`);
      sources.push(await res.text());
    }
    // Merge across bundles: prefer entries that have an externalId.
    const merged = new Map<number, ExtractedCategory>();
    for (const s of sources) {
      for (const e of extractCategories(s)) {
        const prev = merged.get(e.uid);
        if (!prev || (!prev.externalId && e.externalId)) merged.set(e.uid, e);
      }
    }
    const list = [...merged.values()].sort((a, b) => a.uid - b.uid);
    if (list.length === 0) throw new UpstreamError("no category objects found in the bundle(s)");
    const out = ctx.args.out as string | undefined;
    if (out) {
      writeFileSync(out, JSON.stringify(list, null, 2) + "\n");
      return { data: { count: list.length, withExternalId: list.filter((e) => e.externalId).length, out } };
    }
    return { data: list, meta: { count: list.length } };
  },
};
