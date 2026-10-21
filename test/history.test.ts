import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { netWorthTotal } from "../src/domain/accounts.ts";
import { BUCKETS, exclusionReport, firstBalanceDate, flattenBalances, networthSeries, seriesDays } from "../src/domain/history.ts";
import { fixtureDir, root } from "./helpers.ts";

const acc = (uid: string, type: string, balances: unknown[], extra: Record<string, unknown> = {}): any => ({ uid, type, currency: "GBP", deleted: false, balances, ...extra });
const accounts = (): any[] => [
  acc("cash", "cash", [{ date: "2026-01-01", amount: 100, type: "initial" }, { date: "2026-01-03", amount: 150 }]),
  acc("sav", "savings", [{ date: "2026-01-02", amount: 1000 }], { closed: "2026-01-05T00:00:00Z" }),
  acc("house", "properties", [{ date: "2026-01-01", amount: 200000 }], { yearlyAppreciation: 5, netWorthContribution: 50 }),
  acc("mort", "mortgage", [{ date: "2026-01-01", amount: -100000 }]),
  acc("coin", "crypto", [{ date: "2026-01-02", amount: 50 }]),
  acc("gone", "cash", [{ date: "2025-12-01", amount: 999 }], { deleted: true }),
];
const NOW = new Date("2026-03-10T12:00:00Z");
const at = (series: ReturnType<typeof networthSeries>, d: string) => series.find((p) => p.date === d)!;

test("series: step function per account, unknown types in other, deleted accounts excluded", () => {
  const s = networthSeries(accounts(), { now: NOW });
  assert.equal(s[0]!.date, "2026-01-01"); // the deleted account's earlier entry does not start the series
  assert.equal(s[s.length - 1]!.date, "2026-03-10");
  assert.equal(s.length, 31 + 28 + 10);
  assert.deepEqual(Object.keys(s[0]!), ["date", "net_worth", ...BUCKETS, "adjusted"]);
  assert.deepEqual([at(s, "2026-01-01").cash, at(s, "2026-01-02").cash, at(s, "2026-01-03").cash, at(s, "2026-01-20").cash], [100, 100, 150, 150]);
  assert.equal(at(s, "2026-01-01").savings, 0); // before the first entry
  assert.equal(at(s, "2026-01-02").savings, 1000);
  assert.equal(at(s, "2026-01-02").other, 50);
  assert.equal(at(s, "2026-01-01").other, 0);
  assert.equal(at(s, "2026-01-02").mortgage, -100000);
  assert.equal(at(s, "2026-01-01").net_worth, 100 + 100000 - 100000);
  for (const p of s) assert.ok(p.net_worth !== 999 + 100); // never includes the deleted 999
});

test("series: archive takes effect on the closed day (midday evaluation)", () => {
  const a = [acc("s", "savings", [{ date: "2026-01-01", amount: 10 }], { closed: "2026-01-05T09:00:00Z" })];
  const s = networthSeries(a, { to: "2026-01-07", now: NOW });
  assert.deepEqual(s.map((p) => p.savings), [10, 10, 10, 10, 0, 0, 0]);
});

test("series: property appreciation grows monthly from the last valuation, at the contribution share", () => {
  const s = networthSeries(accounts(), { now: NOW });
  assert.equal(at(s, "2026-01-30").properties, 100000);
  const feb1 = Math.round(200000 * Math.pow(1.05, 1 / 12) * 50) / 100;
  assert.equal(at(s, "2026-02-01").properties, feb1);
  assert.ok(at(s, "2026-03-10").properties > feb1);
  // a new valuation resets the base
  const a = accounts();
  a[2].balances.push({ date: "2026-02-15", amount: 300000 });
  assert.equal(at(networthSeries(a, { now: NOW }), "2026-02-15").properties, 150000);
});

test("series: today's point equals netWorthTotal, and so does every day (as `networth --date`)", () => {
  const raws = accounts();
  const s = networthSeries(raws, { now: NOW });
  assert.equal(at(s, "2026-03-10").net_worth, netWorthTotal(raws, NOW));
  for (const p of s) assert.equal(p.net_worth, netWorthTotal(raws, new Date(p.date + "T12:00:00Z")), p.date);
});

test("series: buckets add up to the total to the penny (the total wins), on awkward fractions", () => {
  // three buckets of 0.004: independent rounding gives 0.00 each but the total is 0.01
  const tiny = [acc("a", "cash", [{ date: "2026-01-01", amount: 0.004 }]), acc("b", "savings", [{ date: "2026-01-01", amount: 0.004 }]), acc("c", "card", [{ date: "2026-01-01", amount: 0.004 }])];
  const t = networthSeries(tiny, { to: "2026-01-01", now: NOW })[0]!;
  assert.equal(t.net_worth, 0.01);
  assert.equal(BUCKETS.reduce((n, b) => n + Math.round(t[b] * 100), 0), 1);
  // pseudo-random fractional accounts, with growth, over a few months
  let seed = 7;
  const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const types = [...BUCKETS, "weird"];
  const raws = Array.from({ length: 30 }, (_, i) =>
    acc(`r${i}`, types[i % types.length]!, [{ date: "2026-01-01", amount: Math.round(rnd() * 1e6) / 1000 - 300 }], { yearlyAppreciation: rnd() * 7, netWorthContribution: i % 3 === 0 ? 33.3 : 100 }),
  );
  const s = networthSeries(raws, { now: NOW });
  for (const p of s) {
    assert.equal(BUCKETS.reduce((n, b) => n + Math.round(p[b] * 100), 0), Math.round(p.net_worth * 100), p.date);
    assert.equal(p.net_worth, netWorthTotal(raws, p.date === "2026-03-10" ? NOW : new Date(p.date + "T12:00:00Z")), p.date);
  }
});

test("series: --from/--to, default range, and nothing to report", () => {
  assert.equal(firstBalanceDate(accounts()), "2026-01-01");
  assert.equal(firstBalanceDate([acc("x", "cash", [], {})]), null);
  assert.deepEqual(networthSeries([acc("x", "cash", [])], { now: NOW }), []);
  const s = networthSeries(accounts(), { from: "2026-02-01", to: "2026-02-03", now: NOW });
  assert.deepEqual(s.map((p) => p.date), ["2026-02-01", "2026-02-02", "2026-02-03"]);
  assert.deepEqual(networthSeries(accounts(), { from: "2026-02-03", to: "2026-02-01", now: NOW }), []);
});

test("intervals: week = Sundays, month = month ends, always plus the --to day", () => {
  assert.deepEqual(seriesDays("2026-01-01", "2026-01-03"), ["2026-01-01", "2026-01-02", "2026-01-03"]);
  // 2026-01-04 is a Sunday
  assert.deepEqual(seriesDays("2026-01-01", "2026-01-20", "week"), ["2026-01-04", "2026-01-11", "2026-01-18", "2026-01-20"]);
  assert.deepEqual(seriesDays("2026-01-01", "2026-01-18", "week"), ["2026-01-04", "2026-01-11", "2026-01-18"]);
  assert.deepEqual(seriesDays("2026-01-15", "2026-04-10", "month"), ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-10"]);
  assert.deepEqual(seriesDays("2027-12-20", "2028-02-29", "month"), ["2027-12-31", "2028-01-31", "2028-02-29"]);
  const m = networthSeries(accounts(), { interval: "month", now: NOW });
  assert.deepEqual(m.map((p) => p.date), ["2026-01-31", "2026-02-28", "2026-03-10"]);
  assert.equal(m[0]!.cash, 150);
});

test("series: 1,300 days x 45 accounts is fast (histories are sorted once)", () => {
  const raws = Array.from({ length: 45 }, (_, i) =>
    acc(`p${i}`, BUCKETS[i % BUCKETS.length]!, Array.from({ length: i % 5 === 0 ? 1000 : 20 }, (_, k) => ({ date: new Date(Date.UTC(2023, 2, 1 + k)).toISOString().slice(0, 10), amount: k * 3.17 }))),
  );
  const t0 = Date.now();
  const s = networthSeries(raws, { from: "2023-03-01", to: "2026-10-21", now: new Date("2026-10-21T05:40:00Z") });
  assert.equal(s.length, 1331);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
});

test("flattenBalances: one entry per balances[] item with account context", () => {
  const raws = accounts();
  raws[0].balances[1].tag = "manual";
  raws[0].balances[1].type = "fix";
  const f = flattenBalances(raws, NOW);
  assert.equal(f.length, 2 + 1 + 1 + 1 + 1 + 1);
  assert.deepEqual(f.find((e) => e.accountId === "cash"), { accountId: "cash", accountName: "current account", accountType: "cash", date: "2026-01-01", amount: 100, entryType: "initial", tag: null, active: true, archived: false });
  assert.deepEqual(f.find((e) => e.date === "2026-01-03"), { accountId: "cash", accountName: "current account", accountType: "cash", date: "2026-01-03", amount: 150, entryType: "fix", tag: "manual", active: true, archived: false });
  assert.equal(f.find((e) => e.accountId === "gone")!.active, false);
  assert.equal(f.find((e) => e.accountId === "sav")!.archived, true);
  assert.deepEqual(f.map((e) => e.date), [...f.map((e) => e.date)].sort());
});

// ---- CLI: routing and commands (synthetic backend directory)
function backendWith(raws: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "wps-hist-"));
  cpSync(fixtureDir, dir, { recursive: true });
  writeFileSync(join(dir, "accounts.json"), JSON.stringify(raws));
  return dir;
}
function wps(args: string[], backend = fixtureDir) {
  const r = spawnSync(join(root, "bin", "wps"), args, {
    input: "", encoding: "utf8", cwd: root,
    env: { PATH: process.env.PATH!, HOME: process.env.HOME ?? "/tmp", WPS_FAKE_BACKEND: backend, WPS_FAKE_NOW: "2026-10-21T12:00:00Z" },
  });
  return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
}

test("router: `networth` still works, `networth history` and `accounts balances` route to their commands", () => {
  const plain = wps(["networth"]);
  assert.equal(plain.code, 0, plain.err);
  assert.equal(plain.json().command, "networth");
  const flagged = wps(["networth", "--by", "type"]);
  assert.equal(flagged.json().command, "networth");
  const h = wps(["networth", "history", "--from", "2026-10-19"]);
  assert.equal(h.code, 0, h.err);
  assert.equal(h.json().command, "networth history");
  assert.deepEqual(h.json().data.map((p: any) => p.date), ["2026-10-19", "2026-10-20", "2026-10-21"]);
  assert.equal(wps(["networth", "history", "--help"]).out.includes("--interval"), true);
  assert.equal(wps(["accounts", "balances"]).json().command, "accounts balances");
  assert.equal(wps(["networth", "nope"]).code, 5);
});

test("networth history: today equals `networth`, interval/by/args", () => {
  const total = wps(["networth"]).json().data.total.major;
  const h = wps(["networth", "history", "--interval", "month"]).json();
  assert.equal(h.data[h.data.length - 1].date, "2026-10-21");
  assert.equal(h.data[h.data.length - 1].net_worth, total);
  assert.equal(h.meta.interval, "month");
  assert.ok(Object.keys(h.data[0]).includes("pension"), "buckets are always in the JSON");
  assert.equal(wps(["networth", "history", "--interval", "year"]).code, 5);
  assert.equal(wps(["networth", "history", "--by", "account"]).code, 5);
  assert.equal(wps(["networth", "history", "--from", "2026-10-22"]).code, 5);
  assert.equal(wps(["networth", "history", "--to", "10/10"]).code, 5);
  const t = wps(["networth", "history", "--from", "2026-10-20", "--format", "table"]).out;
  assert.match(t, /^date\s+net_worth\n/);
  assert.ok(!t.includes("pension"));
  const u = wps(["networth", "history", "--from", "2026-10-20", "--by", "type", "--format", "table"]).out;
  assert.match(u, /^date\s+net_worth\s+cash\s+savings.*other\n/);
});

test("accounts balances: filters follow accounts list (deleted/archived hidden unless asked)", () => {
  const b = backendWith([
    acc("a", "cash", [{ date: "2026-01-01", amount: 1 }, { date: "2026-02-01", amount: 2 }]),
    acc("old", "savings", [{ date: "2026-01-15", amount: 5 }], { closed: "2026-03-01T00:00:00Z" }),
    acc("del", "cash", [{ date: "2026-01-20", amount: 9 }], { deleted: true }),
  ]);
  const ids = (args: string[]) => wps(["accounts", "balances", ...args], b).json().data.map((e: any) => `${e.accountId}@${e.date}`);
  assert.deepEqual(ids([]), ["a@2026-01-01", "a@2026-02-01"]);
  assert.deepEqual(ids(["--include-archived"]), ["a@2026-01-01", "old@2026-01-15", "a@2026-02-01"]);
  assert.deepEqual(ids(["--include-deleted", "--include-archived"]), ["a@2026-01-01", "old@2026-01-15", "del@2026-01-20", "a@2026-02-01"]);
  assert.deepEqual(ids(["--account", "a", "--from", "2026-02-01"]), ["a@2026-02-01"]);
  assert.deepEqual(ids(["--to", "2026-01-31"]), ["a@2026-01-01"]);
  assert.equal(wps(["accounts", "balances", "--from", "x"], b).code, 5);
  assert.match(wps(["accounts", "balances", "--format", "table"], b).out, /^date\s+accountName/);
});

test("series: history exclusions leave an account out on their days, never today, and mark them adjusted", () => {
  const raws = [
    acc("auto", "investment", [{ date: "2026-01-01", amount: 100 }, { date: "2026-01-06", amount: 140 }]),
    acc("manual", "investment", [{ date: "2026-01-03", amount: 120 }], { closed: "2026-01-06T09:00:00Z" }),
  ];
  const exclusions = [{ account: "auto", from: "2026-01-03", to: "2026-01-05" }];
  const s = networthSeries(raws, { to: "2026-01-07", now: NOW, exclusions });
  assert.deepEqual(s.map((p) => p.investment), [100, 100, 120, 120, 120, 140, 140]);
  assert.deepEqual(s.map((p) => p.adjusted), [false, false, true, true, true, false, false]);
  // covering today: ignored, so today's point still equals netWorthTotal
  const today = networthSeries(raws, { from: "2026-03-10", now: NOW, exclusions: [{ account: "auto", from: "2026-03-01", to: "2026-03-31" }] });
  assert.equal(today[0]!.net_worth, netWorthTotal(raws, NOW));
  assert.equal(today[0]!.adjusted, false);
  const rep = exclusionReport(raws, [...exclusions, { account: "nope", from: "2026-01-01", to: "2026-01-02" }], s.map((p) => p.date), "2026-03-10");
  assert.deepEqual(rep.map((r) => [r.accountFound, r.days]), [[true, 3], [false, 0]]);
});
