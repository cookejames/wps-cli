import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureDir, root } from "./helpers.ts";

const NOW = "2026-10-21T12:00:00Z";

function wps(args: string[], opts: { input?: string; env?: Record<string, string> } = {}) {
  const r = spawnSync(join(root, "bin", "wps"), args, {
    input: opts.input ?? "",
    encoding: "utf8",
    cwd: root,
    env: { PATH: process.env.PATH!, HOME: process.env.HOME ?? "/tmp", ...opts.env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
}
const fake = { WPS_FAKE_BACKEND: fixtureDir, WPS_FAKE_NOW: NOW };

test("no session: exit 2 auth_failed", () => {
  for (const input of ["{}", "", "garbage", '{"cookie":"a"}']) {
    const r = wps(["session", "check"], { input });
    assert.equal(r.code, 2, input);
    const j = r.json();
    assert.equal(j.status, "auth_failed");
    assert.equal(j.command, "session check");
  }
});

test("valid-looking session but no config: bad_args (5), secrets never echoed", () => {
  const r = wps(["session", "check"], { input: '{"cookie":"sid=SECRETCOOKIE123","csrf":"SECRETCSRF456"}' });
  assert.equal(r.code, 5);
  assert.equal(r.json().status, "bad_args");
  assert.ok(!r.out.includes("SECRET") && !r.err.includes("SECRET"));
});

test("bad args: unknown command, unknown flag, bad values", () => {
  assert.equal(wps(["nope", "list"]).code, 5);
  assert.equal(wps(["accounts", "nope"]).code, 5);
  assert.equal(wps(["accounts"]).code, 5);
  assert.equal(wps(["accounts", "list", "--bogus"], { env: fake }).code, 5);
  assert.equal(wps(["accounts", "list", "--stale-days", "x"], { env: fake }).code, 5);
  assert.equal(wps(["accounts", "list", "--format", "xml"], { env: fake }).code, 5);
  assert.equal(wps(["transactions", "list", "--from", "2026-13-99"], { env: fake }).code, 5);
  assert.equal(wps(["transactions", "list", "--category", "nonexistent-cat", "--from", "2026-10-01", "--to", "2026-10-31"], { env: fake }).code, 5);
  assert.equal(wps(["accounts", "list"], { env: { ...fake, WPS_CONFIG: "/nonexistent.json" } }).code, 5);
});

test("fake backend failure modes map to exit codes", () => {
  for (const [mode, code, status] of [["auth", 2, "auth_failed"], ["upstream", 3, "upstream_error"]] as const) {
    const dir = mkdtempSync(join(tmpdir(), "wps-fake-"));
    writeFileSync(join(dir, "fail.json"), JSON.stringify({ mode }));
    const r = wps(["session", "check"], { env: { WPS_FAKE_BACKEND: dir } });
    assert.equal(r.code, code);
    assert.equal(r.json().status, status);
  }
});

test("session check in fake mode", () => {
  const r = wps(["session", "check"], { env: fake });
  assert.equal(r.code, 0);
  assert.equal(r.json().status, "ok");
});

test("--help lists commands from the registry", () => {
  const r = wps(["--help"]);
  assert.equal(r.code, 0);
  for (const c of ["session check", "transactions list", "accounts list", "categories list", "projects list", "dev extract-categories"]) {
    assert.ok(r.out.includes(c), c);
  }
  const h = wps(["transactions", "list", "--help"]);
  assert.equal(h.code, 0);
  assert.ok(h.out.includes("--include-deleted"));
});

test("accounts list --manual --stale-days 30 (json): property is left out by default", () => {
  const r = wps(["accounts", "list", "--manual", "--stale-days", "30"], { env: fake });
  assert.equal(r.code, 0);
  const j = r.json();
  assert.deepEqual(j.data.map((a: any) => a.id), ["acc-manual-never"]);
  assert.ok(!r.out.includes("SENSITIVE"));
});

test("accounts list --stale-days --include-all-types keeps property", () => {
  const r = wps(["accounts", "list", "--manual", "--stale-days", "30", "--include-all-types"], { env: fake });
  assert.equal(r.code, 0);
  const j = r.json();
  assert.deepEqual(j.data.map((a: any) => a.id), ["acc-manual-never", "acc-manual-old"]);
  assert.equal(j.data[1].daysSinceUpdate, 81);
});

test("accounts list table format, stdin from /dev/null-like empty input", () => {
  const r = wps(["accounts", "list", "--manual", "--stale-days", "30", "--include-all-types", "--format", "table"], { env: fake });
  assert.equal(r.code, 0);
  assert.match(r.out, /^id\s+name/);
  assert.ok(r.out.includes("Example House"));
  assert.ok(!r.out.includes("{"));
});

test("accounts list excludes deleted unless asked", () => {
  const ids = (a: string[]) => wps(["accounts", "list", ...a], { env: fake }).json().data.map((x: any) => x.id);
  assert.ok(!ids([]).includes("acc-deleted"));
  assert.ok(ids(["--include-deleted"]).includes("acc-deleted"));
  assert.deepEqual(ids(["--type", "pension"]), ["acc-manual-new"]);
});

test("transactions list", () => {
  const r = wps(["transactions", "list", "--from", "2026-10-01", "--to", "2026-10-31"], { env: fake });
  assert.equal(r.code, 0);
  const j = r.json();
  assert.deepEqual(j.data.map((t: any) => t.id), ["tx-2", "tx-3", "tx-5", "tx-6", "tx-1"]); // newest first, deleted excluded
  const tx1 = j.data.find((t: any) => t.id === "tx-1");
  assert.equal(tx1.categoryName, "Home maintenance");
  assert.equal(tx1.projectName, "Example renovation");
  assert.equal(tx1.raw, undefined);
  assert.equal(j.data.find((t: any) => t.id === "tx-3").categoryName, "Side project costs");
  assert.equal(j.data.find((t: any) => t.id === "tx-5").categoryName, null);
  assert.equal(j.meta.count, 5);
  assert.equal(j.meta.totalIn, 2100.1);
  assert.equal(j.meta.totalOut, -17.79);
});

test("transactions list filters", () => {
  const ids = (a: string[]) =>
    wps(["transactions", "list", "--from", "2026-10-01", "--to", "2026-10-31", ...a], { env: fake }).json().data.map((t: any) => t.id);
  assert.deepEqual(ids(["--category", "homeMaintenance"]), ["tx-1"]);
  assert.deepEqual(ids(["--category", "Home maintenance"]), ["tx-1"]);
  assert.deepEqual(ids(["--category", "12"]), ["tx-1"]);
  assert.deepEqual(ids(["--project", "proj-1"]), ["tx-1"]);
  assert.deepEqual(ids(["--account", "acc-manual-new"]), ["tx-3"]);
  assert.deepEqual(ids(["--text", "SIDE JOB"]), ["tx-3"]);
  assert.deepEqual(ids(["--include-deleted", "--text", "deleted"]), ["tx-4"]);
  assert.deepEqual(ids(["--limit", "2"]), ["tx-2", "tx-3"]);
  assert.deepEqual(ids(["--to", "2026-10-21"]), ["tx-5", "tx-6", "tx-1"]);
  const raw = wps(["transactions", "list", "--from", "2026-10-01", "--to", "2026-10-31", "--raw", "--limit", "1"], { env: fake }).json();
  assert.equal(raw.data[0].raw.uid, "tx-2");
});

test("transactions list defaults to the config window ending today", () => {
  const cfgPath = join(mkdtempSync(join(tmpdir(), "wps-cfg-")), "c.json");
  writeFileSync(cfgPath, JSON.stringify({ windowDays: 2 }));
  const j = wps(["transactions", "list", "--config", cfgPath], { env: fake }).json();
  assert.deepEqual(j.data.map((t: any) => t.id).sort(), ["tx-1", "tx-5", "tx-6"]); // 19th..21st, minus deleted
  assert.equal(j.meta.from, "2026-10-19");
  assert.equal(j.meta.to, "2026-10-21");
});

test("missing standard categories file still works with a warning", () => {
  const cfgPath = join(mkdtempSync(join(tmpdir(), "wps-cfg-")), "c.json");
  writeFileSync(cfgPath, JSON.stringify({ standardCategoriesFile: "/nonexistent/std.json" }));
  const r = wps(["transactions", "list", "--from", "2026-10-20", "--to", "2026-10-20", "--config", cfgPath], { env: fake });
  assert.equal(r.code, 0);
  assert.match(r.err, /not found/);
  // public categories do not know the numeric id, so it degrades to std-numeric
  assert.equal(r.json().data[0].categoryId, "std-numeric:12");
});

test("categories and projects", () => {
  const c = wps(["categories", "list"], { env: fake }).json();
  assert.ok(c.data.some((x: any) => x.key === "homeMaintenance" && x.name === "Home maintenance" && x.groupName === "Bills"));
  const custom = wps(["categories", "list", "--custom-only"], { env: fake }).json();
  assert.deepEqual(custom.data.map((x: any) => x.categoryId), ["cus:00000000-0000-4000-8000-000000000100"]);
  const p = wps(["projects", "list", "--format", "table"], { env: fake });
  assert.ok(p.out.includes("Example renovation") && p.out.includes("PropertyProject"));
});

test("dev extract-categories needs no session and writes the file", () => {
  const out = join(mkdtempSync(join(tmpdir(), "wps-out-")), "std.json");
  const r = wps(["dev", "extract-categories", "--bundle-file", join(root, "test/fixtures/bundle-snippet.js"), "--out", out]);
  assert.equal(r.code, 0);
  assert.equal(r.json().data.count, 4);
  const written = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(written.length, 4);
  assert.equal(wps(["dev", "extract-categories"]).code, 5);
  assert.equal(wps(["dev", "extract-categories", "--bundle-file", "/nonexistent.js"]).code, 5);
});

test("networth: dashboard rules over the fixtures", () => {
  const r = wps(["networth"], { env: fake });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().command, "networth");
  const d = r.json().data;
  const house = Math.round(250000 * Math.pow(1.02, 2 / 12) * 50) / 100;
  assert.equal(d.asOf, "2026-10-21");
  assert.equal(d.total.major, Math.round((house + 1234.56 + 10.5) * 100) / 100);
  assert.equal(d.total.value, Math.round(d.total.major * 100));
  assert.deepEqual(d.accounts.map((a: any) => a.id), ["acc-manual-old", "acc-manual-new", "acc-auto", "acc-manual-never", "acc-deleted"]);
  const by = Object.fromEntries(d.accounts.map((a: any) => [a.id, a]));
  assert.equal(by["acc-manual-old"].included, true);
  assert.equal(by["acc-manual-never"].reason, "noBalance");
  assert.equal(by["acc-manual-never"].value, null);
  assert.equal(by["acc-deleted"].reason, "deleted");
  assert.equal(d.byType.pension, 1234.56);
  assert.ok(!r.out.includes("SENSITIVE"));
});

test("networth --date evaluates as of that date; bad args", () => {
  const d = wps(["networth", "--date", "2026-09-20"], { env: fake }).json().data;
  assert.equal(d.asOf, "2026-09-20");
  const pension = d.accounts.find((a: any) => a.id === "acc-manual-new");
  assert.equal(pension.value.major, 1200);
  assert.equal(d.accounts.find((a: any) => a.id === "acc-auto").reason, "noBalance");
  assert.equal(wps(["networth", "--date", "20-09"], { env: fake }).code, 5);
  assert.equal(wps(["networth", "--by", "x"], { env: fake }).code, 5);
});

test("networth table format: lines and a TOTAL; --by type", () => {
  const t = wps(["networth", "--format", "table"], { env: fake });
  assert.equal(t.code, 0, t.err);
  assert.match(t.out, /^name\s+type\s+value\s+netWorthValue\s+included/);
  assert.ok(t.out.includes("Example Pension"));
  assert.ok(t.out.includes("noBalance"));
  assert.match(t.out, /TOTAL\s.*\n$/);
  const u = wps(["networth", "--by", "type", "--format", "table"], { env: fake });
  assert.match(u.out, /^type\s+netWorthValue/);
  assert.ok(u.out.includes("pension"));
  assert.ok(wps(["networth", "--help"]).out.includes("--date"));
  assert.ok(wps(["--help"]).out.includes("networth"));
});

test("accounts set-balance: dry-run by default, --yes writes, audits and reads back; refuses connected/deleted/ambiguous", async () => {
  const { cpSync } = await import("node:fs");
  const backend = mkdtempSync(join(tmpdir(), "wps-setbal-"));
  cpSync(fixtureDir, backend, { recursive: true });
  const logDir = mkdtempSync(join(tmpdir(), "wps-audit-"));
  const cfg = join(logDir, "config.json");
  writeFileSync(cfg, JSON.stringify({ logDir }));
  const env = { WPS_FAKE_BACKEND: backend, WPS_FAKE_NOW: NOW };
  const run = (...args: string[]) => wps(["accounts", "set-balance", "--config", cfg, ...args], { env });

  const dry = run("--set", "acc-manual-new=1,500.25");
  assert.equal(dry.code, 0, dry.err);
  assert.deepEqual(dry.json().data.map((c: any) => [c.id, c.oldBalance, c.amount, c.date, c.status]), [["acc-manual-new", 1234.56, 1500.25, "2026-10-21", "dry-run"]]);
  assert.equal(dry.json().meta.dryRun, true);
  assert.throws(() => readFileSync(join(backend, "set-balance.json"))); // nothing sent

  const yes = run("--set", "acc-manual-new=1500.25", "--set", "acc-manual-old=260000", "--date", "2026-10-20", "--yes");
  assert.equal(yes.code, 0, yes.err);
  assert.deepEqual(yes.json().data.map((c: any) => c.status), ["updated", "updated"]);
  assert.deepEqual(JSON.parse(readFileSync(join(backend, "set-balance.json"), "utf8")), [
    { accountId: "acc-manual-new", amount: 1500.25, date: "2026-10-20" },
    { accountId: "acc-manual-old", amount: 260000, date: "2026-10-20" },
  ]);
  const audit = readFileSync(join(logDir, "audit.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(audit.map((l) => [l.command, l.target, l.change.to]), [["accounts set-balance", "acc-manual-new", 1500.25], ["accounts set-balance", "acc-manual-old", 260000]]);

  for (const [args, msg] of [
    [["--set", "acc-auto00=5"], /no account/],
    [["--set", "acc-auto=5"], /connected account/],
    [["--set", "acc-deleted=5"], /deleted/],
    [["--set", "acc-manual=5"], /matches 3 accounts/],
    [["--set", "acc-manual-new=12.345"], /2 decimals/],
    [["--set", "acc-manual-new=5", "--date", "2030-01-01"], /future/],
    [[], /at least one/],
  ] as [string[], RegExp][]) {
    const r = run(...args, "--yes");
    assert.equal(r.code, 5, args.join(" "));
    assert.match(r.json().reason ?? r.json().error ?? JSON.stringify(r.json()), msg);
  }
});
