# wps-cli

An **unofficial** command-line tool for Moneyhub-based personal finance web apps
(white-label apps built on Moneyhub). It talks to the web app's own **undocumented**
API using a browser session, so it can break whenever the vendor changes it. It is
**not affiliated with or endorsed by** Moneyhub or any white-label operator, and
using it may not fit your provider's terms. Use it on your own data only.

It emits machine-readable JSON (or a plain table), so cron, scripts and AI agents can
call it equally well. Output uses the naming of the public Moneyhub Data API
(`id`, `accountId`, `amount.value` in minor units, `std:`/`cus:` category IDs), so a
second backend could be added later.

## Install

    npm install
    npm run typecheck && npm test
    npm run hooks          # installs the leak-check pre-commit hook
    cp config.example.json /somewhere/outside/the/repo/config.json   # edit it

Needs Node 22+. Run via `bin/wps` (a shim that runs the TypeScript through `tsx`).

## The session model

The tool never logs in. You pipe a session on stdin, as JSON, taken from a logged-in
browser:

    {"cookie":"<Cookie header value>","csrf":"<csrf token>","userAgent":"<optional>"}

It is held in memory only: never written to disk, logged or printed (all stderr and
error text is redacted). Sessions are short-lived, so fetch one just before each run.
No/invalid session gives `auth_failed` and exit code 2.

## Examples

    my-session-helper | bin/wps --config ~/wps.json session check
    my-session-helper | bin/wps accounts list --manual --stale-days 30 --format table
    my-session-helper | bin/wps transactions list --from 2026-10-01 --to 2026-10-21 --category groceries
    bin/wps dev extract-categories --bundle-file app.js --out ~/standard-categories.json
    bin/wps --help

Output is one JSON document on stdout:
`{"status":"ok","command":"...","data":...,"meta":...}`; see `docs/contract.md`
for exit codes and the full contract, and `docs/api-notes.md` for the endpoints.

## Google Sheets

`wps sheets sync [--backfill]` copies transactions, accounts, categories and projects into `raw_*`, `ref_*` and
`meta` sheets of a Google spreadsheet (set `spreadsheetId` in the config or pass `--spreadsheet`), using the
[`gws`](https://github.com/googleworkspace/cli) CLI, which must be installed and logged in with the Sheets scope.
`wps sheets init-dashboard` creates a `Transactions` sheet built on those sheets, once. The app owns the
`raw_*`/`ref_*`/`meta` sheets; you own everything else. Run `--backfill` first, then run the plain sync daily.

    my-session-helper | bin/wps sheets sync --backfill
    my-session-helper | bin/wps sheets sync            # rolling window (windowDays)
    bin/wps sheets init-dashboard

## Adding a command

1. Create `src/commands/<group>-<name>.ts` exporting `{group, name, summary, options, needsSession, mutating?, columns?, run(ctx)}`.
2. Register it in `src/commands/index.ts`.
3. Add a test. Commands that change data set `mutating: true` and use `ctx.mutate(...)`, which gives dry-run by default, `--yes` to act, and an audit log.

## Tests and privacy

Tests use synthetic fixtures only (`test/fixtures`). `WPS_FAKE_BACKEND` is a test-only
switch. `scripts/leak-check.sh [--all]` scans for tokens, tenant-shaped IDs, account
numbers, emails and personal names, and runs as a pre-commit hook.

## Licence

MIT.
