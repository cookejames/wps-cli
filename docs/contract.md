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

    {"cookie":"<Cookie header value>","csrf":"<csrf token>","userAgent":"<optional>"}

An optional third field `"userAgent"` is sent verbatim as the `user-agent` header
(it is not secret); otherwise a current desktop Firefox UA is used.

If stdin is a TTY or empty, the JSON is invalid, or a field is missing or empty,
the result is `auth_failed` (exit 2). The session is held in memory only: it is
never written to disk, logged, or put in an error message. Every string sent to
stderr or into an error output passes through a redaction helper that removes
the cookie value, the csrf value, each cookie pair's value, and anything
JWT-shaped.

Sessions are short-lived (a sliding expiry of the order of 15 minutes); obtain a
fresh one right before running.

## Request headers and pacing

Every API request is built by one shared header builder: `cookie`, `csrf-token`,
`accept: application/json, text/plain, */*`, `accept-language: en-GB,en;q=0.9`,
`user-agent`, `origin: <webOrigin>` (mandatory: without it the API answers 403/401)
and `referer: <webOrigin>/`. Requests within one command run sequentially with a
random 300-600 ms pause between them.

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
`usePublicCategories` (default true), `spreadsheetId` (optional; Google spreadsheet for the `sheets` commands, overridden by `--spreadsheet`). The config lives outside the repo.

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

## Principle: same data as the dashboard

The wps CLI should always attempt to provide the same data as the web app's dashboard. Account values must match
what the web app shows, and the CLI must reproduce the dashboard's net worth figure. Rules (implemented in
`src/domain/accounts.ts`):

- *Balance for a date*, from the account's `balances` array (not `currentBalance`): sort by date (`date.slice(0,10)`; an
  `initial`-tagged entry first on equal dates); before the first date there is none; on or after the last date it is the
  last entry; otherwise the latest entry dated on or before the date (the last of several on that date). With no dated
  entries it is the last entry; with an empty array, none. CLI fallback: if `balances` is missing or empty,
  `currentBalance` is used so that no data is lost.
- *Current value*: archived (`closed` in the past) is 0. Types `properties` and `asset`: the balance for today times
  `(1 + yearlyAppreciation/100)^p`, with `p = floor(days / (365/12)) / 12` and `days` the whole calendar days (config
  timezone) from the balance date to today (never negative). Any other type: the balance for today.
- *Net worth contribution*: 0 for non-GBP (a missing currency counts as GBP), `netWorthEnabled === false` or
  `netWorthContribution === 0`; otherwise the value (0 if none) times `netWorthContribution/100` (null means 100%).
- *Net worth*: the sum of the contributions of active accounts (`deleted !== true` and `deletedConnection !== true`),
  summed unrounded and rounded once to pence. Archived accounts are active but contribute 0.

`Account.balance`/`balanceDate` are the last recorded balance; `Account.value` is the dashboard value.

## Commands (phase 1)

- `session check`
- `transactions list --from --to [--account] [--project] [--category] [--text] [--include-deleted] [--raw] [--limit]`
- `accounts list [--type] [--manual] [--stale-days N] [--include-deleted] [--include-archived | --archived]`. Archived accounts (the web app's "Archived on", i.e. the source `closed` date is in the past) are hidden by default; `--archived` lists only those. With `--stale-days`, account types in config `staleIgnoreTypes` (default `["properties"]`) are left out unless `--include-all-types`.
  Table columns: id, name, provider, type, manual, value.major, balanceDate, daysSinceUpdate, archived. JSON adds
  `value`, `netWorthValue`, `netWorthEnabled`, `netWorthContribution` (default 100), `yearlyAppreciation`, `active`.
- `networth [--by type|account] [--date YYYY-MM-DD]`. The dashboard's net worth (rules above); `--date` evaluates them
  as of that date. `data: {total: Money, asOf, accounts: [{id, name, type, value, netWorthValue, included, reason?}],
  byType: {type: total}}`, accounts sorted by `netWorthValue` descending. `reason` (when not included) is one of
  `deleted`, `archived`, `nonGBP`, `netWorthDisabled`, `zeroContribution`, `noBalance`. `byType` and `total` cover active
  accounts only. Table format: one line per account (or per type with `--by type`) and a TOTAL line.
- `categories list [--custom-only]`
- `projects list`
- `dev extract-categories (--bundle-url <url>... | --bundle-file <path>...) [--out <path>]` (no session)

- `sheets sync [--backfill] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--spreadsheet <id>] [--dry-run]`
- `sheets init-dashboard [--spreadsheet <id>] [--sheet Transactions] [--force]` (no session)

## Google Sheets (the `gws` sink)

The sink shells out to the `gws` CLI (`gws sheets spreadsheets <method> --params '<json>' [--json '<json>']`,
spawned with an argument array, no shell); `wps` never handles Google OAuth. Set env `WPS_GWS_BIN` to use another
executable. Failures (non-zero exit, JSON `error`, missing binary) are `sink_error` (exit 4) with redacted, truncated text;
429/5xx-looking failures are retried once after 2 s.

**Ownership rule: the app owns `raw_*`, `ref_*` and `meta`; humans own every other sheet.** `wps` rewrites its sheets in
full and never touches the others (the dashboard is written once by `init-dashboard`, then left alone). Do not edit
the app's sheets by hand.

**Atomic rewrite.** Each app sheet is replaced like this, so dashboards never see half-written data and formulas
that reference a sheet by name keep working (a sheet is never deleted or renamed):
1. ensure the target sheet exists; ensure a hidden `_staging_<name>` sheet exists, sized to the data;
2. clear the staging sheet and write the whole table into it, in chunks (every `--json` argument stays under
   100,000 bytes; Linux caps one argument at about 128 KB) with `valueInputOption=RAW`;
3. one `spreadsheets.batchUpdate`: grow the target if needed, `copyPaste` (`PASTE_VALUES`) staging over the target's A1,
   blank any rows left below the new data, set number formats, bold header, freeze row 1;
4. clear and shrink the staging sheet (it stays hidden).

**Value typing.** Everything is written `RAW`, so nothing user-controlled (e.g. a description starting with `=`) can
become a formula. Numbers and booleans are JSON numbers/booleans. Dates are Sheets serial numbers (days since
1899-12-30); datetimes are serials of the wall-clock time in the configured `timezone`, shown with a number format
(`yyyy-mm-dd`, `yyyy-mm-dd hh:mm`). Amounts use `#,##0.00`. Empty values are empty cells.

**Sheets** (header in row 1, columns in this order):
- `raw_transactions`: id, bookingDate (date), date (datetime), accountId, amount, currency, shortDescription,
  longDescription, merchantName, notes, label, categoryId, internalCategoryId, categoryIdConfirmed, projectId, status,
  deleted, missingFromSource, dateOnStatement, dateModified (datetime), counterpartyId, synced_at (datetime).
- `ref_categories`: categoryId, internalId, key, name, groupId, groupKey, groupName, custom.
- `ref_projects`: id, name, type.
- `raw_accounts`: id, name, provider, type, accountType, auto, manual, balance, currency, balanceDate (date),
  providerLastUpdated (datetime), lastUpdated (date), daysSinceUpdate, deleted, netWorthContribution, archived, archivedAt (datetime), value,
  netWorthValue, netWorthEnabled, yearlyAppreciation, active (appended after the older columns; `balance` is the last recorded
  balance, `value` the dashboard value)
  (no parties, sort codes, IBANs or account numbers).
- `meta` (key | value): last_run_at, mode, window_from, window_to, transactions_total, added, updated, unchanged,
  missing_from_source, accounts_total, categories_total, projects_total, net_worth (the net worth total), net_worth_as_of, wps_cli_version, status.

**`sheets sync`.** Fetches transactions, accounts, categories and projects with the same code as the list commands.
- `--backfill`: transactions from 2015-01-01 to `--to` (default today); `raw_transactions` becomes exactly the fresh
  rows (all `added`).
- Window mode (default: today minus `windowDays` .. today, or `--from/--to`): the existing sheet is read back, parsed
  to typed rows and merged by `id` with `mergeByUid`: rows outside the window are untouched; in-window rows missing
  from the source are kept and flagged `missingFromSource=true`; `synced_at` is set only on added/updated rows.
  If `raw_transactions` is missing or empty this is `bad_args` ("raw_transactions is empty; run with --backfill first").
- Rows are sorted by bookingDate descending, then id. `ref_*` and `raw_accounts` are rewritten every run; `meta` last.
- `--dry-run` computes everything and writes nothing (it still reads the sheet in window mode).
- Output: `data: {mode, window:{from,to}, transactions:{total,added,updated,unchanged,missingFromSource}, accounts, categories, projects}`.

**`sheets init-dashboard`.** Writes the `Transactions` sheet once: title and note in row 1, headers
`Date | Category | Project | Description | Amount | Account` in row 3, and one spilling formula in A4
(`IFERROR(SORT(FILTER({...}, id<>"", deleted<>TRUE), 1, FALSE), "")`, lookups via `ARRAYFORMULA(IFERROR(VLOOKUP(...)))`,
column letters derived from the column lists in code). An empty default `Sheet1` is renamed; a non-empty
`Transactions` sheet is refused (`bad_args`) unless `--force`. The grid is grown to 30,000 rows so the formula can
spill; rows 1-3 are frozen. Output: `data: {sheet, created|renamed|reused: true}`.

## Test-only: fake backend

`WPS_FAKE_BACKEND=<fixture dir>` replaces the network backend with JSON fixtures
(no session needed); `WPS_FAKE_NOW=<ISO>` fixes "now". For automated tests only. Sheets tests use `test/fake-gws.mjs`
(an in-memory fake `gws`, selected with `WPS_GWS_BIN`).
