import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const here = dirname(fileURLToPath(import.meta.url));
export const root = join(here, "..");
export const fixtureDir = join(here, "fixtures", "backend");
export const fixture = <T = any>(name: string): T => JSON.parse(readFileSync(join(fixtureDir, name), "utf8"));
export const NOW = new Date("2026-10-21T12:00:00Z");
