import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureDir, here, root } from "./helpers.ts";
import { SheetsSink, MAX_JSON_BYTES } from "../src/sinks/sheets.ts";
import { canonicalIso, dateToSerial, isoToSerial, serialToDate, serialToIso } from "../src/sinks/serial.ts";
import { ACCOUNTS, CATEGORIES, PROJECTS, RAW_BALANCES, RAW_SNAPSHOTS, TRANSACTIONS, colLetter, type TableDef } from "../src/sinks/tables.ts";
import { DEFAULT_LAYOUT, networthFormula, transactionsFormula } from "../src/sinks/dashboard.ts";
import { SinkError } from "../src/errors.ts";

const FAKE_GWS = join(here, "fake-gws.mjs");

function env(dir: string, extra: Record<string, string> = {}) {
  return { FAKE_GWS_STATE: join(dir, "state.json"), WPS_GWS_BIN: FAKE_GWS, WPS_GWS_BACKOFF_MS: "5", WPS_GWS_QUOTA_BACKOFF_MS: "5", ...extra };
}
function newDir(): string {
  return mkdtempSync(join(tmpdir(), "wps-sheets-"));
}
const state = (dir: string) => JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
const calls = (dir: string): any[] => {
  const p = join(dir, "state.json.log");
  return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const sheet = (dir: string, title: string) => state(dir).sheets.find((s: any) => s.title === title);
const grid = (dir: string, title: string) => sheet(dir, title).values.map((r: any[]) => r.map((v) => v ?? ""));
function seed(dir: string, sheets: { title: string; values?: unknown[][] }[]) {
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({ nextId: 10, sheets: sheets.map((s, i) => ({ sheetId: i + 1, title: s.title, hidden: false, rowCount: 1000, columnCount: 26, frozenRowCount: 0, values: s.values ?? [], formats: [] })) }),
  );
}

function wps(args: string[], dir: string, extra: Record<string, string> = {}, backend = fixtureDir, now = "2026-10-21T12:00:00Z") {
  const r = spawnSync(join(root, "bin", "wps"), args, {
    input: "", encoding: "utf8", cwd: root,
    env: { PATH: process.env.PATH!, HOME: process.env.HOME ?? "/tmp", WPS_FAKE_BACKEND: backend, WPS_FAKE_NOW: now, ...env(dir, extra) },
  });
  return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
}
const sink = (dir: string, o: Record<string, unknown> = {}) => new SheetsSink({ spreadsheetId: "X", bin: FAKE_GWS, backoffMs: 5, ...o });

test("serial numbers: dates, and datetimes across the BST/GMT boundary", () => {
  assert.equal(dateToSerial("1970-01-01"), 25569);
  assert.equal(dateToSerial("2026-10-25"), 46320);
  assert.equal(serialToDate(46320), "2026-10-25");
  // 2026-10-25 00:30Z is 01:30 BST; 02:30Z is 02:30 GMT (clocks went back at 02:00 BST = 01:00Z)
  assert.ok(Math.abs(isoToSerial("2026-10-25T00:30:00Z", "Europe/London") - (46320 + 1.5 / 24)) < 1e-9);
  assert.ok(Math.abs(isoToSerial("2026-10-25T02:30:00Z", "Europe/London") - (46320 + 2.5 / 24)) < 1e-9);
  assert.ok(Math.abs(isoToSerial("2026-10-24T23:30:00Z", "Europe/London") - (46319 + 24.5 / 24)) < 1e-9); // BST: 00:30 on the 25th
  assert.equal(serialToIso(isoToSerial("2026-10-25T02:30:00Z", "Europe/London"), "Europe/London"), "2026-10-25T02:30:00.000Z");
  assert.equal(serialToIso(isoToSerial("2026-07-01T12:00:00.123Z", "Europe/London"), "Europe/London"), "2026-07-01T12:00:00.123Z");
  // spring forward: 01:30Z on 2026-03-29 is 02:30 BST
  assert.ok(Math.abs(isoToSerial("2026-03-29T01:30:00Z", "Europe/London") - (dateToSerial("2026-03-29") + 2.5 / 24)) < 1e-9);
  assert.equal(canonicalIso("2026-03-29T01:30:00Z", "Europe/London"), "2026-03-29T01:30:00.000Z");
  // the repeated hour is ambiguous but the canonical form is stable
  const c = canonicalIso("2026-10-25T00:30:00Z", "Europe/London");
  assert.equal(canonicalIso(c, "Europe/London"), c);
  assert.equal(canonicalIso("2026-10-25T00:30:00Z", "UTC"), "2026-10-25T00:30:00.000Z");
});

test("chunking keeps every --json under 100,000 bytes", async () => {
  const dir = newDir();
  const rows = Array.from({ length: 4000 }, (_, i) => ({
    id: `id-${i}`, bookingDate: "2026-10-01", date: "2026-10-01T10:00:00.000Z", accountId: "a", amount: -i,
    longDescription: "é".repeat(150) + " " + i, // multi-byte on purpose
  }));
  const s = sink(dir);
  Object.assign(process.env, env(dir));
  await s.rewriteTable(TRANSACTIONS, rows);
  const writes = calls(dir).filter((c) => c.method === "values update");
  assert.ok(writes.length > 5, `expected several chunks, got ${writes.length}`);
  for (const c of calls(dir)) assert.ok(c.jsonBytes < MAX_JSON_BYTES, `${c.method}: ${c.jsonBytes}`);
  assert.equal(grid(dir, "raw_transactions").length, 4001);
  assert.equal(grid(dir, "raw_transactions")[4000][0], "id-3999");
  // pure chunker
  const chunks = s.chunkRows(Array.from({ length: 1000 }, () => ["x".repeat(500)]));
  assert.ok(chunks.length > 4);
  assert.equal(chunks.flat().length, 1000);
  for (const ch of chunks) assert.ok(Buffer.byteLength(JSON.stringify({ values: ch })) < MAX_JSON_BYTES);
  assert.throws(() => s.chunkRows([["x".repeat(MAX_JSON_BYTES)]]), SinkError);
});

test("atomic rewrite order: staging writes, then one batchUpdate with copyPaste, then cleanup", async () => {
  const dir = newDir();
  Object.assign(process.env, env(dir));
  const s = sink(dir);
  const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `Project ${i}`, type: "GenericProject" }));
  await s.rewriteTable(PROJECTS, mk(5));
  const log = calls(dir);
  const iCopy = log.findIndex((c) => c.method === "batchUpdate" && c.body.requests.some((r: any) => r.copyPaste));
  assert.ok(iCopy > 0);
  const updates = log.map((c, i) => [c, i] as const).filter(([c]) => c.method === "values update");
  assert.ok(updates.length >= 1);
  for (const [c, i] of updates) {
    assert.ok(i < iCopy, "all writes happen before the copy");
    assert.ok(c.params.range.startsWith("'_staging_ref_projects'!"), `write went to ${c.params.range}`);
  }
  const iClearStaging = log.findIndex((c) => c.method === "values clear" && c.params.range === "'_staging_ref_projects'");
  assert.ok(iClearStaging >= 0 && iClearStaging < updates[0]![1], "staging is cleared before it is filled");
  const after = log.slice(iCopy + 1);
  assert.equal(after[0].method, "values clear");
  assert.equal(after[1].method, "batchUpdate");
  assert.equal(after.length, 2);
  const reqs = log[iCopy].body.requests;
  assert.deepEqual(Object.keys(reqs[0]), ["updateSheetProperties"]);
  assert.equal(reqs[0].updateSheetProperties.properties.gridProperties.frozenRowCount, 1);
  assert.equal(reqs[1].copyPaste.pasteType, "PASTE_VALUES");
  assert.equal(JSON.stringify(log).includes("deleteSheet"), false);
  assert.equal(JSON.stringify(log.filter((c) => c.method === "batchUpdate").flatMap((c) => c.body.requests.map((r: any) => Object.keys(r)[0]))).includes("deleteDimension"), false);
  // staging exists, is hidden, emptied and shrunk; target holds the data
  const st = sheet(dir, "_staging_ref_projects");
  assert.equal(st.hidden, true);
  assert.deepEqual(st.values, []);
  assert.equal(st.rowCount, 1);
  assert.equal(grid(dir, "ref_projects").length, 6);
  const targetId = sheet(dir, "ref_projects").sheetId;

  // rewrite with fewer rows: leftovers are blanked, the target keeps its sheetId (never recreated/renamed)
  await s.rewriteTable(PROJECTS, mk(2));
  const g = grid(dir, "ref_projects");
  assert.deepEqual(g.slice(0, 3).map((r: any[]) => r[0]), ["id", "p0", "p1"]);
  assert.ok(g.slice(3).every((r: any[]) => r.every((v) => v === "")));
  assert.equal(sheet(dir, "ref_projects").sheetId, targetId);
  assert.equal(sheet(dir, "ref_projects").frozenRowCount, 1);
});

test("user strings go out as RAW, never as formulas; dates are serial numbers with formats", async () => {
  const dir = newDir();
  Object.assign(process.env, env(dir));
  const evil = '=HYPERLINK("x")';
  await sink(dir).rewriteTable(TRANSACTIONS, [
    { id: "t1", bookingDate: "2026-10-25", date: "2026-10-24T23:30:00.000Z", accountId: "a", amount: -1.5, currency: "GBP", shortDescription: evil, longDescription: "+1 or -2", notes: "@SUM(1)", deleted: false, categoryIdConfirmed: true },
  ]);
  const updates = calls(dir).filter((c) => c.method === "values update");
  assert.ok(updates.every((c) => c.params.valueInputOption === "RAW"));
  const sent = updates.flatMap((c) => c.body.values).find((r: any[]) => r[0] === "t1");
  assert.equal(sent[6], evil);
  assert.equal(typeof sent[6], "string");
  assert.equal(sent[1], 46320);
  assert.ok(Math.abs(sent[2] - (46320 + 0.5 / 24)) < 1e-9);
  assert.equal(sent[4], -1.5);
  assert.equal(sent[13], true);
  assert.equal(grid(dir, "raw_transactions")[1][6], evil);
  const formats = sheet(dir, "raw_transactions").formats.map((f: any) => [f.range.startColumnIndex, f.cell.userEnteredFormat.numberFormat?.pattern]).filter((x: any[]) => x[1]);
  assert.ok(formats.some(([i, p]: any) => i === 1 && p === "yyyy-mm-dd"));
  assert.ok(formats.some(([i, p]: any) => i === 2 && p === "yyyy-mm-dd hh:mm"));
  assert.ok(formats.some(([i, p]: any) => i === 4 && p === "#,##0.00"));
});

test("sync: backfill, then a window sync merges and keeps rows outside the window byte-identical", () => {
  const dir = newDir();
  const backend = mkdtempSync(join(tmpdir(), "wps-backend-"));
  cpSync(fixtureDir, backend, { recursive: true });
  const common = ["sheets", "sync", "--spreadsheet", "SHEET"];

  // window sync before any backfill is refused
  const early = wps(common, dir, {}, backend);
  assert.equal(early.code, 5);
  assert.match(early.json().reason, /raw_transactions is empty; run with --backfill first/);

  const b = wps([...common, "--backfill", "--to", "2026-10-31"], dir, {}, backend, "2026-10-21T12:00:00Z");
  assert.equal(b.code, 0, b.out + b.err);
  assert.equal(b.json().command, "sheets sync");
  const bj = b.json().data;
  assert.equal(bj.mode, "backfill");
  assert.equal(bj.transactions.total, 6);
  assert.equal(bj.projects, 2);
  assert.equal(bj.accounts, 5);
  const g1 = grid(dir, "raw_transactions");
  assert.equal(g1.length, 7);
  assert.deepEqual(g1[0], TRANSACTIONS.cols.map((c) => c.key));
  // newest booking date first (tx-2 books on 2026-10-25 local), ties by id
  assert.deepEqual(g1.slice(1).map((r: any[]) => r[0]), ["tx-2", "tx-3", "tx-5", "tx-6", "tx-1", "tx-4"]);
  const oldSynced = g1[1][TRANSACTIONS.cols.findIndex((c) => c.key === "synced_at")];
  assert.equal(typeof oldSynced, "number");
  const meta = Object.fromEntries(grid(dir, "meta").slice(1).map((r: any[]) => [r[0], r[1]]));
  assert.equal(meta.mode, "backfill");
  assert.equal(meta.transactions_total, 6);
  assert.equal(meta.status, "ok");
  assert.equal(meta.window_from, "2015-01-01");
  assert.equal(typeof meta.net_worth, "number");
  assert.equal(meta.net_worth_as_of, "2026-10-21");
  const ah = grid(dir, "raw_accounts")[0];
  assert.deepEqual(ah.slice(15, 22), ["archived", "archivedAt", "value", "netWorthValue", "netWorthEnabled", "yearlyAppreciation", "active"]);
  assert.deepEqual(ah.slice(22, 27), ["subType", "income", "incomeDate", "incomeLastChanged", "dateBenefitStarts"]);
  // no sensitive account fields reach the sheet
  const dump = JSON.stringify(state(dir).sheets.map((s: any) => s.values));
  for (const bad of ["SENSITIVE", "iban", "sortCode", "parties"]) assert.ok(!dump.includes(bad), bad);
  assert.deepEqual(grid(dir, "raw_accounts")[0], ACCOUNTS.cols.map((c) => c.key));
  assert.equal(grid(dir, "ref_categories")[0][0], "categoryId");
  assert.ok(grid(dir, "ref_categories").some((r: any[]) => r[2] === "mystery" && r[3] === "Mystery"));

  // change the backend: tx-3 edited, tx-5 gone, tx-7 new
  const txs = JSON.parse(readFileSync(join(backend, "transactions.json"), "utf8")).filter((t: any) => t.uid !== "tx-5");
  txs.find((t: any) => t.uid === "tx-3").notes = "edited";
  txs.push({ uid: "tx-7", accountUid: "acc-auto", amount: -3, currency: "GBP", date: "2026-10-21T09:00:00.000Z", description: "New", cleanDescription: "New", notes: "", categoryId: "1", categoryIdConfirmed: false, status: "posted", deleted: false, dateModified: "2026-10-21T09:00:00.000Z" });
  writeFileSync(join(backend, "transactions.json"), JSON.stringify(txs));

  const w = wps([...common, "--from", "2026-10-20", "--to", "2026-10-22"], dir, {}, backend, "2026-10-22T08:00:00Z");
  assert.equal(w.code, 0, w.out + w.err);
  const wj = w.json().data;
  assert.equal(wj.mode, "window");
  assert.deepEqual(wj.window, { from: "2026-10-20", to: "2026-10-22" });
  assert.deepEqual(wj.transactions, { total: 7, added: 1, updated: 1, unchanged: 2, missingFromSource: 1 });
  const g2 = grid(dir, "raw_transactions");
  const row = (g: any[][], id: string) => g.find((r) => r[0] === id)!;
  const col = (k: string) => TRANSACTIONS.cols.findIndex((c) => c.key === k);
  // outside the window: identical to before (including synced_at)
  for (const id of ["tx-4", "tx-2"]) assert.deepEqual(row(g2, id), row(g1, id), id);
  // unchanged in window keeps synced_at; updated and added get the new one
  for (const id of ["tx-1", "tx-6"]) assert.equal(row(g2, id)[col("synced_at")], row(g1, id)[col("synced_at")], id);
  for (const id of ["tx-3", "tx-7"]) assert.ok(row(g2, id)[col("synced_at")] > oldSynced, id);
  assert.equal(row(g2, "tx-3")[col("notes")], "edited");
  assert.equal(row(g2, "tx-5")[col("missingFromSource")], true);
  assert.equal(row(g2, "tx-1")[col("missingFromSource")], false);
  assert.equal(new Set(g2.slice(1).map((r: any[]) => r[0])).size, 7);
  assert.equal(grid(dir, "meta").find((r: any[]) => r[0] === "added")![1], 1);

  // an immediate repeat changes nothing
  const again = wps([...common, "--from", "2026-10-20", "--to", "2026-10-22"], dir, {}, backend, "2026-10-23T08:00:00Z");
  assert.deepEqual(again.json().data.transactions, { total: 7, added: 0, updated: 0, unchanged: 4, missingFromSource: 1 });
});

test("sync --dry-run fetches and computes but writes nothing", () => {
  const dir = newDir();
  seed(dir, [{ title: "Sheet1" }]);
  const r = wps(["sheets", "sync", "--spreadsheet", "S", "--backfill", "--to", "2026-10-31", "--dry-run"], dir);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.json().data.dryRun, true);
  assert.equal(r.json().data.transactions.total, 6);
  assert.ok(calls(dir).every((c) => c.method === "get" || c.method === "values get"), "only reads");
});

test("sync needs a spreadsheet id; gws failures are sink errors (exit 4); one retry on 5xx", () => {
  const dir = newDir();
  assert.equal(wps(["sheets", "sync", "--backfill"], dir).code, 5);
  assert.equal(wps(["sheets", "sync", "--spreadsheet", "S", "--backfill", "--from", "2020-01-01"], dir).code, 5);
  const missing = wps(["sheets", "init-dashboard", "--spreadsheet", "S"], dir, { WPS_GWS_BIN: "/nonexistent/gws" });
  assert.equal(missing.code, 4);
  assert.equal(missing.json().status, "sink_error");

  seed(dir, [{ title: "Sheet1" }]);
  const st = state(dir);
  st.failNext = 1; // one 503, then fine
  writeFileSync(join(dir, "state.json"), JSON.stringify(st));
  const ok = wps(["sheets", "init-dashboard", "--spreadsheet", "S"], dir);
  assert.equal(ok.code, 0, ok.out + ok.err);
  const first = calls(dir)[0];
  assert.equal(calls(dir)[1].method, first.method);

  const st2 = state(dir);
  st2.failNext = 2;
  st2.failCode = 403;
  writeFileSync(join(dir, "state.json"), JSON.stringify(st2));
  const bad = wps(["sheets", "init-dashboard", "--spreadsheet", "S"], dir);
  assert.equal(bad.code, 4);
  const n = calls(dir).length;
  assert.ok(n > 0);
  assert.match(bad.json().reason, /403/);
});

test("per-minute quota errors (429) are retried up to 3 times, then are sink errors", () => {
  const dir = newDir();
  seed(dir, [{ title: "Sheet1" }]);
  const st = state(dir);
  st.failNext = 3;
  st.failCode = 429;
  writeFileSync(join(dir, "state.json"), JSON.stringify(st));
  const ok = wps(["sheets", "init-dashboard", "--spreadsheet", "S"], dir);
  assert.equal(ok.code, 0, ok.out + ok.err);
  assert.match(ok.err, /retry 3 of 3/);

  const dir2 = newDir();
  seed(dir2, [{ title: "Sheet1" }]);
  const st2 = state(dir2);
  st2.failNext = 4;
  st2.failCode = 429;
  writeFileSync(join(dir2, "state.json"), JSON.stringify(st2));
  const bad = wps(["sheets", "init-dashboard", "--spreadsheet", "S"], dir2);
  assert.equal(bad.code, 4);
  assert.match(bad.json().reason, /429/);
});

test("init-dashboard renames an empty Sheet1, refuses a non-empty Transactions without --force", () => {
  const dir = newDir();
  seed(dir, [{ title: "Sheet1" }]);
  const r = wps(["sheets", "init-dashboard", "--spreadsheet", "S"], dir);
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual(r.json().data, { sheet: "Transactions", renamed: true, netWorth: { sheet: "Net worth", created: true } });
  const s = state(dir);
  assert.deepEqual(s.sheets.map((x: any) => x.title), ["Transactions", "Net worth"]);
  assert.equal(s.sheets[0].sheetId, 1, "renamed in place, not recreated");
  assert.equal(s.sheets[0].frozenRowCount, 3);
  assert.ok(s.sheets[0].rowCount >= 30000);
  const g = grid(dir, "Transactions");
  assert.equal(g[0][0], "Transactions");
  assert.match(g[0][1], /Generated by wps sheets init-dashboard/);
  assert.deepEqual(g[2], ["Date", "Category", "Project", "Description", "Amount", "Account"]);
  assert.equal(g[3][0], transactionsFormula());
  const writes = calls(dir).filter((c) => c.method === "values update" && c.params.range.startsWith("'Transactions'"));
  assert.deepEqual(writes.map((c) => c.params.valueInputOption), ["RAW", "USER_ENTERED"]);
  assert.equal(writes[1].params.range, "'Transactions'!A4");

  // second run: content exists -> refuse, nothing written
  const before = calls(dir).length;
  const again = wps(["sheets", "init-dashboard", "--spreadsheet", "S"], dir);
  assert.equal(again.code, 5);
  assert.match(again.json().reason, /--force/);
  assert.ok(calls(dir).slice(before).every((c) => c.method === "get" || c.method === "values get"));
  const forced = wps(["sheets", "init-dashboard", "--spreadsheet", "S", "--force"], dir);
  assert.equal(forced.code, 0, forced.out + forced.err);
  assert.deepEqual(forced.json().data, { sheet: "Transactions", reused: true, netWorth: { sheet: "Net worth", existed: true } });
});

test("init-dashboard creates a new sheet when Sheet1 is not empty", () => {
  const dir = newDir();
  seed(dir, [{ title: "Sheet1", values: [["mine"]] }]);
  const r = wps(["sheets", "init-dashboard", "--spreadsheet", "S"], dir);
  assert.deepEqual(r.json().data, { sheet: "Transactions", created: true, netWorth: { sheet: "Net worth", created: true } });
  assert.deepEqual(state(dir).sheets.map((x: any) => x.title), ["Sheet1", "Transactions", "Net worth"]);
  assert.equal(grid(dir, "Sheet1")[0][0], "mine");
});

test("dashboard formula column letters come from the column lists", () => {
  const f = transactionsFormula();
  const L = (def: TableDef, key: string) => colLetter(def.cols.findIndex((c) => c.key === key));
  assert.equal(L(TRANSACTIONS, "bookingDate"), "B");
  assert.ok(f.startsWith("=IFERROR(SORT(FILTER({"));
  assert.ok(f.includes("'raw_transactions'!B2:B"));
  assert.ok(f.includes("'raw_transactions'!Q2:Q<>TRUE"));
  assert.ok(f.includes("VLOOKUP('raw_transactions'!L2:L, 'ref_categories'!A2:D, 4, FALSE)"));
  assert.ok(f.includes("VLOOKUP('raw_transactions'!O2:O, 'ref_projects'!A2:B, 2, FALSE)"));
  assert.ok(f.includes("VLOOKUP('raw_transactions'!D2:D, 'raw_accounts'!A2:B, 2, FALSE)"));
  // reorder: move 'id' to the end and swap two ref columns; the letters follow
  const tx: TableDef = { ...TRANSACTIONS, cols: [...TRANSACTIONS.cols.filter((c) => c.key !== "id"), TRANSACTIONS.cols.find((c) => c.key === "id")!] };
  const cats: TableDef = { ...CATEGORIES, cols: [CATEGORIES.cols[0]!, CATEGORIES.cols[1]!, CATEGORIES.cols[3]!, CATEGORIES.cols[2]!, ...CATEGORIES.cols.slice(4)] };
  const g = transactionsFormula({ ...DEFAULT_LAYOUT, tx, categories: cats });
  assert.ok(g.includes(`'raw_transactions'!${L(tx, "bookingDate")}2:${L(tx, "bookingDate")}`));
  assert.ok(g.includes(`'raw_transactions'!${L(tx, "id")}2:${L(tx, "id")}<>""`));
  assert.notEqual(L(tx, "bookingDate"), "B");
  assert.ok(g.includes("'ref_categories'!A2:C, 3, FALSE"));
  assert.notEqual(g, f);
});

test("sync: raw_balances and raw_networth are rebuilt each run; meta has the new keys", () => {
  const dir = newDir();
  const r = wps(["sheets", "sync", "--spreadsheet", "S", "--backfill", "--to", "2026-10-31"], dir);
  assert.equal(r.code, 0, r.out + r.err);
  const d = r.json().data;
  assert.equal(d.balances, 5); // 2 + 2 + 1 entries in the fixtures
  assert.deepEqual(d.networth, { days: 143, from: "2026-06-01", to: "2026-10-21" });
  assert.deepEqual(d.snapshots, { date: "2026-10-21", rows: 5 });
  assert.deepEqual(grid(dir, "raw_balances")[0], RAW_BALANCES.cols.map((c) => c.key));
  assert.equal(grid(dir, "raw_balances").length, 6);
  assert.equal(grid(dir, "raw_networth").length, 144);
  assert.deepEqual(grid(dir, "raw_networth")[0].slice(0, 3), ["date", "net_worth", "cash"]);
  const last = grid(dir, "raw_networth")[143];
  const meta = Object.fromEntries(grid(dir, "meta").slice(1).map((x: any[]) => [x[0], x[1]]));
  assert.equal(last[1], meta.net_worth); // today's point is the dashboard total
  assert.equal(meta.balances_total, 5);
  assert.equal(meta.networth_days, 143);
  assert.equal(meta.snapshots_appended, 5);
  assert.equal(meta.networth_from, "2026-06-01");
  // the series is written as date serials with date/amount formats
  assert.equal(grid(dir, "raw_networth")[1][0], dateToSerial("2026-06-01"));
  assert.ok(sheet(dir, "raw_networth").formats.some((f: any) => f.cell.userEnteredFormat.numberFormat?.pattern === "yyyy-mm-dd"));
});

test("sync: raw_account_snapshots is append-only across days; a same-day rerun replaces only today's rows", () => {
  const dir = newDir();
  const backend = mkdtempSync(join(tmpdir(), "wps-backend-"));
  cpSync(fixtureDir, backend, { recursive: true });
  const args = ["sheets", "sync", "--spreadsheet", "S", "--backfill", "--to", "2026-10-31"];
  const snaps = () => grid(dir, "raw_account_snapshots");
  const day = (g: any[][], iso: string) => g.slice(1).filter((r) => r[0] === dateToSerial(iso));

  // day 1: the sheet is created with its header and today's rows
  assert.equal(wps(args, dir, {}, backend, "2026-10-21T12:00:00Z").code, 0);
  assert.deepEqual(snaps()[0], RAW_SNAPSHOTS.cols.map((c) => c.key));
  assert.equal(sheet(dir, "raw_account_snapshots").frozenRowCount, 1);
  const g1 = snaps();
  assert.equal(g1.length, 6);
  assert.deepEqual(g1[1].slice(0, 2), [dateToSerial("2026-10-21"), "acc-manual-old"]);
  assert.equal(typeof g1[1][12], "number"); // synced_at
  const forDay1 = calls(dir).length;

  // day 2: appended after day 1; day 1's rows are untouched
  const accounts = JSON.parse(readFileSync(join(backend, "accounts.json"), "utf8"));
  accounts.find((a: any) => a.uid === "acc-auto").balances.push({ date: "2026-10-22", amount: 99 });
  writeFileSync(join(backend, "accounts.json"), JSON.stringify(accounts));
  assert.equal(wps(args, dir, {}, backend, "2026-10-22T05:40:00Z").code, 0);
  const g2 = snaps();
  assert.equal(g2.length, 11);
  assert.deepEqual(g2.slice(0, 6), g1);
  assert.equal(day(g2, "2026-10-22").length, 5);
  assert.equal(day(g2, "2026-10-22").find((r) => r[1] === "acc-auto")![4], 99);
  assert.equal(day(g2, "2026-10-21").find((r) => r[1] === "acc-auto")![4], 10.5);
  const day2Calls = calls(dir).slice(forDay1).filter((c) => JSON.stringify(c).includes("raw_account_snapshots"));
  assert.deepEqual([...new Set(day2Calls.map((c) => c.method))].sort(), ["values append", "values get"]);
  assert.ok(day2Calls.every((c) => c.method !== "values append" || c.body.values.length === 5 && c.body.values.every((r: any[]) => r[0] === dateToSerial("2026-10-22"))));

  // same day again with a new value: only day 2's rows change; still one set per day
  const before = calls(dir).length;
  accounts.find((a: any) => a.uid === "acc-auto").balances.push({ date: "2026-10-22", amount: 77 });
  writeFileSync(join(backend, "accounts.json"), JSON.stringify(accounts));
  assert.equal(wps(args, dir, {}, backend, "2026-10-22T17:00:00Z").code, 0);
  const g3 = snaps();
  assert.equal(g3.length, 11);
  assert.deepEqual(g3.slice(0, 6), g1);
  assert.equal(day(g3, "2026-10-22").find((r) => r[1] === "acc-auto")![4], 77);
  const rerun = calls(dir).slice(before).filter((c) => JSON.stringify(c).includes("raw_account_snapshots"));
  assert.ok(rerun.some((c) => c.method === "values clear" && c.params.range === "'raw_account_snapshots'!A7:O"));
  assert.ok(!rerun.some((c) => c.method === "values update"), "no rewrite of the table");
  const meta = Object.fromEntries(grid(dir, "meta").slice(1).map((x: any[]) => [x[0], x[1]]));
  assert.equal(meta.snapshots_appended, 5);
});

test("snapshots: today's rows not at the end fall back to a rewrite; a foreign header is never touched", async () => {
  const dir = newDir();
  Object.assign(process.env, env(dir));
  const row = (d: string, id: string) => ({ snapshot_date: d, accountId: id, name: id, type: "cash", balance: 1, balanceDate: "2026-01-01", value: 1, netWorthValue: 1, netWorthEnabled: true, netWorthContribution: 100, archived: false, active: true, synced_at: "2026-10-20T05:00:00.000Z" });
  const s = sink(dir);
  await s.appendTable(RAW_SNAPSHOTS, [row("2026-10-21", "a"), row("2026-10-21", "b")], { key: "snapshot_date", value: "2026-10-21" });
  await s.appendTable(RAW_SNAPSHOTS, [row("2026-10-22", "a")], { key: "snapshot_date", value: "2026-10-22" });
  // today's (10-21) rows are now in the middle
  const r = await s.appendTable(RAW_SNAPSHOTS, [row("2026-10-21", "c")], { key: "snapshot_date", value: "2026-10-21" });
  assert.equal(r.rewrote, true);
  assert.deepEqual(grid(dir, "raw_account_snapshots").slice(1).map((x: any[]) => x[1]).filter(Boolean), ["a", "c"]); // 10-22's "a" kept, 10-21 replaced by "c"
  seed(dir, [{ title: "raw_account_snapshots", values: [["something", "else"], ["x", "y"]] }]);
  await assert.rejects(() => s.appendTable(RAW_SNAPSHOTS, [row("2026-10-21", "a")]), SinkError);
  assert.deepEqual(grid(dir, "raw_account_snapshots"), [["something", "else"], ["x", "y"]]);
});

test("init-dashboard: Net worth sheet with a month-end formula and two charts, created once and then left alone", () => {
  const dir = newDir();
  seed(dir, [{ title: "Sheet1" }]);
  assert.equal(wps(["sheets", "init-dashboard", "--spreadsheet", "S"], dir).code, 0);
  const nw = sheet(dir, "Net worth");
  assert.equal(nw.frozenRowCount, 3);
  const g = grid(dir, "Net worth");
  assert.equal(g[0][0], "Net worth");
  assert.deepEqual(g[2], ["Month end", "Net worth", "Cash", "Savings", "Card", "Investment", "Pension", "Properties", "Asset", "Mortgage", "Loan", "Other"]);
  assert.equal(g[3][0], networthFormula());
  assert.ok(networthFormula().includes("'raw_networth'!A2:A"));
  assert.ok(networthFormula().includes("'raw_networth'!B2:B")); // net_worth is column B
  assert.ok(networthFormula().includes("'raw_networth'!L2:L")); // other is the last of 12 columns
  assert.equal(nw.charts.length, 2);
  const [line, area] = nw.charts.map((c: any) => c.spec.basicChart);
  assert.equal(line.chartType, "LINE");
  assert.equal(line.series.length, 1);
  assert.equal(line.series[0].series.sourceRange.sources[0].startColumnIndex, 1);
  assert.equal(area.chartType, "AREA");
  assert.equal(area.stackedType, "STACKED");
  assert.deepEqual(area.series.map((x: any) => x.series.sourceRange.sources[0].startColumnIndex), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  for (const b of [line, area]) {
    assert.equal(b.headerCount, 1);
    assert.equal(b.domains[0].domain.sourceRange.sources[0].startColumnIndex, 0);
    assert.equal(b.domains[0].domain.sourceRange.sources[0].startRowIndex, 2); // header row included, open-ended below
    assert.equal(b.domains[0].domain.sourceRange.sources[0].endRowIndex, undefined);
  }
  assert.ok(nw.charts.every((c: any) => c.position.overlayPosition.anchorCell.columnIndex < nw.columnCount));

  // re-run: the sheet exists, so nothing is written to it (even with --force)
  const before = calls(dir).length;
  const again = wps(["sheets", "init-dashboard", "--spreadsheet", "S", "--only", "networth", "--force"], dir);
  assert.deepEqual(again.json().data, { netWorth: { sheet: "Net worth", existed: true } });
  assert.ok(calls(dir).slice(before).every((c) => c.method === "get"));
  assert.equal(sheet(dir, "Net worth").charts.length, 2);
});

test("init-dashboard --only networth works on a spreadsheet whose Transactions already has content; bad --only is rejected", () => {
  const dir = newDir();
  seed(dir, [{ title: "Transactions", values: [["mine"]] }]);
  assert.equal(wps(["sheets", "init-dashboard", "--spreadsheet", "S"], dir).code, 5); // unchanged: refuses Transactions
  assert.deepEqual(state(dir).sheets.map((x: any) => x.title), ["Transactions"]);
  const r = wps(["sheets", "init-dashboard", "--spreadsheet", "S", "--only", "networth"], dir);
  assert.deepEqual(r.json().data, { netWorth: { sheet: "Net worth", created: true } });
  assert.equal(grid(dir, "Transactions")[0][0], "mine");
  const t = wps(["sheets", "init-dashboard", "--spreadsheet", "S", "--only", "transactions", "--force"], dir);
  assert.deepEqual(t.json().data, { sheet: "Transactions", reused: true });
  assert.equal(wps(["sheets", "init-dashboard", "--spreadsheet", "S", "--only", "x"], dir).code, 5);
});

test("backfill-snapshots: rebuilt month-end rows (then daily) before the first recorded day; recorded rows kept; re-runnable", () => {
  const dir = newDir();
  // a sheet from before the `source` column existed: the header is extended and these rows count as recorded
  const oldHeader = RAW_SNAPSHOTS.cols.map((c) => c.key).filter((k) => k !== "source");
  const recordedRow = [dateToSerial("2026-10-21"), "acc-auto", "Auto", "cash", 10.5, dateToSerial("2026-10-20"), 10.5, 10.5, true, 100, false, true, isoToSerial("2026-10-21T05:40:00Z", "Europe/London")];
  seed(dir, [{ title: "raw_account_snapshots", values: [oldHeader, recordedRow] }]);
  const r = wps(["sheets", "backfill-snapshots", "--spreadsheet", "S", "--from", "2026-08-15"], dir, {}, fixtureDir, "2026-10-22T12:00:00Z");
  assert.equal(r.code, 0, r.err);
  const d = r.json().data;
  assert.equal(d.firstRecorded, "2026-10-21");
  assert.equal(d.recordedKept, 1);
  const g = grid(dir, "raw_account_snapshots");
  assert.deepEqual(g[0], RAW_SNAPSHOTS.cols.map((c) => c.key));
  const src = g[0].indexOf("source");
  const days = [...new Set(g.slice(1).filter((x: any[]) => x[src] === "rebuilt").map((x: any[]) => serialToDate(x[0])))];
  // month ends of Aug and Sep, then every day of October up to the day before the first recorded snapshot
  assert.deepEqual(days, ["2026-08-31", "2026-09-30", ...Array.from({ length: 20 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`)]);
  const last = g[g.length - 1];
  assert.deepEqual([last[1], last[src]], ["acc-auto", "recorded"]);
  assert.deepEqual(last.slice(0, 13), recordedRow);
  // running it again replaces the rebuilt rows rather than adding more
  const again = wps(["sheets", "backfill-snapshots", "--spreadsheet", "S", "--from", "2026-08-15"], dir, {}, fixtureDir, "2026-10-22T12:00:00Z");
  assert.equal(again.json().data.replacedRebuilt, d.rebuilt);
  assert.equal(grid(dir, "raw_account_snapshots").length, g.length);
});
