import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { requireApiConfig, type Config } from "../config.ts";
import { readSession } from "../session.ts";
import { parsePublicCategories, type PublicCategories } from "./public-categories.ts";
import type { Backend } from "./backend.ts";
import { FakeBackend } from "./fake.ts";
import { InternalWebBackend } from "./internal-web/index.ts";

/** TEST ONLY: WPS_FAKE_BACKEND=<fixture dir> replaces the network backend with JSON fixtures. */
export function fakeDir(env: NodeJS.ProcessEnv): string | undefined {
  return env.WPS_FAKE_BACKEND || undefined;
}

export async function createBackend(config: Config, env: NodeJS.ProcessEnv, stdin: NodeJS.ReadableStream & { isTTY?: boolean }): Promise<Backend> {
  const dir = fakeDir(env);
  if (dir) return new FakeBackend(dir);
  const session = await readSession(stdin);
  requireApiConfig(config);
  return new InternalWebBackend(config, session);
}

export function fakePublicCategories(dir: string): PublicCategories | null {
  const a = join(dir, "public-categories.json");
  const b = join(dir, "public-category-groups.json");
  if (!existsSync(a) || !existsSync(b)) return null;
  return parsePublicCategories(JSON.parse(readFileSync(a, "utf8")), JSON.parse(readFileSync(b, "utf8")));
}
