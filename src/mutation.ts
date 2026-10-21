import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface MutationSpec {
  command: string;
  target: string;
  change: unknown;
  /** The request that would be sent (shown in dry-run). Must not contain secrets. */
  request: unknown;
}

export interface MutationResult<T> {
  dryRun: boolean;
  request: unknown;
  result?: T;
}

/** Dry-run unless `yes`; when applied, append an audit line first. */
export async function runMutation<T>(
  spec: MutationSpec,
  opts: { yes: boolean; logDir: string; now?: () => Date },
  apply: () => Promise<T>,
): Promise<MutationResult<T>> {
  if (!opts.yes) return { dryRun: true, request: spec.request };
  mkdirSync(opts.logDir, { recursive: true });
  const line = JSON.stringify({
    ts: (opts.now ? opts.now() : new Date()).toISOString(),
    command: spec.command,
    target: spec.target,
    change: spec.change,
  });
  appendFileSync(join(opts.logDir, "audit.log"), line + "\n");
  const result = await apply();
  return { dryRun: false, request: spec.request, result };
}
