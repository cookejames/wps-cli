import type { ParseArgsConfig } from "node:util";
import type { Backend } from "../backends/backend.ts";
import type { Config } from "../config.ts";
import type { Logger } from "../log.ts";
import type { MutationResult, MutationSpec } from "../mutation.ts";
import type { PublicCategories } from "../backends/public-categories.ts";

export interface CommandContext {
  config: Config;
  /** parsed flags (global + command-specific) */
  args: Record<string, string | boolean | (string | boolean)[] | undefined>;
  log: Logger;
  env: NodeJS.ProcessEnv;
  /** Lazily creates the backend (reads the session from stdin unless in fake mode). */
  backend(): Promise<Backend>;
  /** Public unauthenticated category lists, or null if disabled/unavailable. */
  publicCategories(): Promise<PublicCategories | null>;
  now(): Date;
  mutate<T>(spec: Omit<MutationSpec, "command">, apply: () => Promise<T>): Promise<MutationResult<T>>;
}

export interface CommandResult {
  data: unknown;
  meta?: Record<string, unknown>;
}

export interface CommandDef {
  group: string;
  name: string;
  summary: string;
  options: NonNullable<ParseArgsConfig["options"]>;
  needsSession: boolean;
  mutating?: boolean;
  /** columns for --format table (dotted paths allowed) */
  columns?: string[];
  run(ctx: CommandContext): Promise<CommandResult>;
}
