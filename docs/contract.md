# The `wps` contract

Stable interface for any caller (cron, a human, an AI agent).

## Invocation

    wps <group> <command> [flags]

Global flags (given after the command): `--config <path>` (or env `WPS_CONFIG`),
`--format json|table` (default `json`), `--help`.

`wps --help` lists all commands (generated from the command registry);
`wps <group> <command> --help` shows one command's flags.

## Session input

Commands that talk to the API read a session as JSON on **stdin**:

    {"cookie":"<Cookie header value>","csrf":"<csrf token>"}

If stdin is a TTY or empty, the JSON is invalid, or a field is missing or empty,
the result is `auth_failed` (exit 2). The session is held in memory only: it is
never written to disk, logged, or put in an error message. Every string sent to
stderr or into an error output passes through a redaction helper that removes
the cookie value, the csrf value, each cookie pair's value, and anything
JWT-shaped.

Sessions are short-lived (a sliding expiry of the order of 15 minutes); obtain a
fresh one right before running.

## Output

stdout carries exactly ONE JSON document.

Success:

    {"status":"ok","command":"accounts list","data":[...],"meta":{...}}

Failure:

    {"status":"auth_failed","command":"session check","reason":"..."}

`status` is one of `ok`, `auth_failed`, `upstream_error`, `sink_error`,
`bad_args`, `error`.

With `--format table` a plain aligned text table is printed instead (errors are
printed as `<status>: <reason>`); exit codes are unchanged. Logs and progress go
to stderr, redacted.

## Exit codes

| code | status          | meaning |
|-----:|-----------------|---------|
| 0    | `ok`            | success |
| 1    | `error`         | anything else |
| 2    | `auth_failed`   | missing/invalid session; HTTP 401/403; "Invalid csrf"; "No csrf found in headers" |
| 3    | `upstream_error`| unexpected status or response shape from the API |
| 4    | `sink_error`    | a sink (e.g. Sheets) failed |
| 5    | `bad_args`      | bad flags, bad config |

## Config

JSON file from `--config` or `WPS_CONFIG` (see `config.example.json`): `apiBase`,
`webOrigin`, `tenantId`, `timezone` (default `Europe/London`), `windowDays`
(default 45), `logDir` (default `./logs`), `standardCategoriesFile`,
`usePublicCategories` (default true). The config lives outside the repo.

## Mutating commands

A command definition may set `mutating: true`. Such a command:

- defaults to **dry-run**: it prints the request it would send
  (`meta.dryRun: true`, `data.request`) and sends nothing;
- only acts when `--yes` is given (the flag is added automatically);
- appends an audit line to `<logDir>/audit.log`:
  `{"ts","command","target","change"}` (no secrets).

Implemented by `ctx.mutate({target, change, request}, apply)`. No command uses it
in this phase.

## Command registry

Each `src/commands/*.ts` exports

    { group, name, summary, options, needsSession, mutating?, columns?, run(ctx) }

`options` is a `node:util` `parseArgs` options object. `ctx` provides `config`,
`args`, `backend()` (lazy; reads the session), `log` (redacted stderr logger),
`now()`, `mutate()`. `run` returns `{data, meta?}`.

To add a command: create one file in `src/commands/` and register it in
`src/commands/index.ts`. Help text is generated.

## Commands (phase 1)

- `session check`
- `transactions list --from --to [--account] [--project] [--category] [--text] [--include-deleted] [--raw] [--limit]`
- `accounts list [--type] [--manual] [--stale-days N] [--include-deleted]`
- `categories list [--custom-only]`
- `projects list`
- `dev extract-categories (--bundle-url <url>... | --bundle-file <path>...) [--out <path>]` (no session)

## Test-only: fake backend

`WPS_FAKE_BACKEND=<fixture dir>` replaces the network backend with JSON fixtures
(no session needed); `WPS_FAKE_NOW=<ISO>` fixes "now". For automated tests only.
