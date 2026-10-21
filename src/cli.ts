import { parseArgs } from "node:util";
import { loadConfig, type Config } from "./config.ts";
import { AuthError, BadArgsError, EXIT_CODES, WpsError, type Status } from "./errors.ts";
import { createLogger } from "./log.ts";
import { runMutation } from "./mutation.ts";
import { redact } from "./session.ts";
import { renderTable } from "./table.ts";
import { createBackend, fakeDir, fakePublicCategories } from "./backends/factory.ts";
import { fetchPublicCategories } from "./backends/public-categories.ts";
import { commands, findCommand } from "./commands/index.ts";
import type { CommandContext, CommandDef } from "./commands/types.ts";
import { join } from "node:path";
import { realpathSync } from "node:fs";

export interface Outcome { stdout: string; code: number }

const GLOBAL_OPTIONS = {
  config: { type: "string" },
  format: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

function optionLine(name: string, o: { type: string; multiple?: boolean }): string {
  const arg = o.type === "string" ? ` <${o.multiple ? "value>..." : "value>"}`.replace("<value>...>", "<value>...") : "";
  return `  --${name}${arg}`;
}

export function globalHelp(): string {
  const lines = [
    "wps - unofficial CLI for Moneyhub-based personal finance web apps",
    "",
    "Usage: wps <group> <command> [flags]",
    "",
    "Commands:",
  ];
  const w = Math.max(...commands.map((c) => `${c.group} ${c.name}`.trim().length));
  for (const c of commands) lines.push(`  ${`${c.group} ${c.name}`.trim().padEnd(w)}  ${c.summary}${c.needsSession ? "" : " (no session)"}`);
  lines.push(
    "",
    "Global flags (after the command):",
    "  --config <path>        config file (or env WPS_CONFIG)",
    "  --format json|table    output format (default json)",
    "  --help                 show help",
    "",
    "Session: JSON on stdin {\"cookie\":\"...\",\"csrf\":\"...\"} for commands that call the API.",
    "Exit codes: 0 ok, 1 error, 2 auth_failed, 3 upstream_error, 4 sink_error, 5 bad_args.",
    "See docs/contract.md.",
  );
  return lines.join("\n") + "\n";
}

export function commandHelp(c: CommandDef): string {
  const lines = [`wps ${c.group} ${c.name}`.replace(/ $/, "") + ` - ${c.summary}`, "", "Flags:"];
  for (const [n, o] of Object.entries(c.options)) lines.push(optionLine(n, o));
  if (c.mutating) lines.push("  --yes                  actually send (default is a dry run)");
  lines.push("  --config <path>", "  --format json|table", "  --help");
  lines.push("", c.needsSession ? "Needs a session JSON on stdin." : "Needs no session.");
  return lines.join("\n") + "\n";
}

function groupHelp(group: string): string {
  const cs = commands.filter((c) => c.group === group);
  return [`wps ${group} <command>`, "", ...cs.map((c) => `  ${c.name.padEnd(20)}${c.summary}`)].join("\n") + "\n";
}

function fail(command: string, status: Exclude<Status, "ok">, reason: string, format: string): Outcome {
  const msg = redact(reason);
  const stdout = format === "table" ? `${status}: ${msg}\n` : JSON.stringify({ status, command, reason: msg }) + "\n";
  return { stdout, code: EXIT_CODES[status] };
}

export async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  stdin: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
  stderrWrite: (s: string) => void = (s) => process.stderr.write(s),
): Promise<Outcome> {
  const wantsFormat = argv.find((a, i) => a === "--format" && argv[i + 1] === "table") ? "table" : "json";
  // a command with an empty name is a top-level one (`wps networth`)
  if (argv[0] && findCommand(argv[0], "") && (!argv[1] || argv[1].startsWith("-"))) argv = [argv[0], "", ...argv.slice(1)];
  const [group, name] = argv;
  if (!group || group === "--help" || group === "-h" || group === "help") return { stdout: globalHelp(), code: 0 };
  if (group.startsWith("-")) return fail("", "bad_args", "expected: wps <group> <command> [flags]", wantsFormat);
  if ((!name && name !== "") || name === "--help" || name === "-h") {
    if (!commands.some((c) => c.group === group)) return fail(group, "bad_args", `unknown group '${group}'`, wantsFormat);
    return name ? { stdout: groupHelp(group), code: 0 } : fail(group, "bad_args", `missing command; see 'wps ${group} --help'`, wantsFormat);
  }
  const label = `${group} ${name}`.trim();
  const cmd = findCommand(group, name);
  if (!cmd) return fail(label, "bad_args", `unknown command '${label}'; see 'wps --help'`, wantsFormat);

  try {
    const options: Record<string, any> = { ...cmd.options, ...GLOBAL_OPTIONS };
    if (cmd.mutating) options.yes = { type: "boolean" };
    let values: Record<string, any>;
    try {
      values = parseArgs({ args: argv.slice(2), options, strict: true, allowPositionals: false }).values;
    } catch (e) {
      throw new BadArgsError((e as Error).message);
    }
    if (values.help) return { stdout: commandHelp(cmd), code: 0 };
    const format = (values.format as string | undefined) ?? "json";
    if (format !== "json" && format !== "table") throw new BadArgsError("--format must be json or table");

    const log = createLogger(stderrWrite);
    const config: Config = loadConfig(values.config, env);
    const fdir = fakeDir(env);
    if (fdir && !config.standardCategoriesFile) config.standardCategoriesFile = join(fdir, "standard-categories.json");

    let backendP: Promise<import("./backends/backend.ts").Backend> | undefined;
    const now = () => (fdir && env.WPS_FAKE_NOW ? new Date(env.WPS_FAKE_NOW) : new Date());
    const ctx: CommandContext = {
      config,
      args: values,
      log,
      env,
      backend: () => (backendP ??= createBackend(config, env, stdin)),
      publicCategories: async () => {
        if (fdir) return fakePublicCategories(fdir);
        if (!config.usePublicCategories) return null;
        try {
          return await fetchPublicCategories();
        } catch (e) {
          log.warn(`public categories unavailable: ${(e as Error).message}`);
          return null;
        }
      },
      now,
      mutate: (spec, apply) => runMutation({ ...spec, command: label }, { yes: values.yes === true, logDir: config.logDir, now }, apply),
    };
    // Surface auth problems before doing any other work for API commands.
    if (cmd.needsSession) await ctx.backend();
    const result = await cmd.run(ctx);
    const meta = result.meta ?? {};
    const stdout =
      format === "table"
        ? (cmd.renderTable ? cmd.renderTable(result.data, values) : renderTable(result.data, cmd.columns))
        : JSON.stringify({ status: "ok", command: label, data: result.data, meta }) + "\n";
    return { stdout: redactOut(stdout), code: 0 };
  } catch (e) {
    if (e instanceof WpsError) return fail(label, e.status, e.message, wantsFormat === "table" ? "table" : "json");
    return fail(label, "error", (e as Error)?.message ?? "unknown error", wantsFormat === "table" ? "table" : "json");
  }
}

/** Defence in depth: output never contains session secrets or JWT-shaped strings. */
function redactOut(s: string): string {
  return redact(s);
}

async function main(): Promise<void> {
  const { stdout, code } = await runCli(process.argv.slice(2));
  process.stdout.write(stdout);
  process.exitCode = code;
}

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().catch((e) => {
    process.stderr.write(redact(`wps: fatal: ${(e as Error)?.message ?? e}`) + "\n");
    process.exitCode = 1;
  });
}
