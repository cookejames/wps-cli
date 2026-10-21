import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, isDateString, toLondonDate } from "../src/domain/dates.ts";
import { buildCategoryIndex, normaliseCategoryId, resolveCategoryRef, titleCase } from "../src/domain/categories.ts";
import { mapTransaction, toMinor } from "../src/domain/transactions.ts";
import { accountDisplayName, archiveOf, balanceForDate, currentValue, netWorthTotal, netWorthValue, filterStale, mapAccount, sortByStaleness } from "../src/domain/accounts.ts";
import { mergeByUid } from "../src/domain/merge.ts";
import { extractCategories } from "../src/domain/extract.ts";
import { parsePublicCategories } from "../src/backends/public-categories.ts";
import { parseTextResources } from "../src/backends/internal-web/index.ts";
import { fixture, NOW, here } from "./helpers.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { accountRow, trackIncomeLastChanged } from "../src/sinks/tables.ts";

const index = (warn?: (m: string) => void) =>
  buildCategoryIndex({
    extracted: fixture("standard-categories.json"),
    publicCategories: parsePublicCategories(fixture("public-categories.json"), fixture("public-category-groups.json")),
    names: parseTextResources({ data: fixture("text-resources.json") }),
    custom: fixture("custom-categories.json"),
    warn,
  });

test("toLondonDate: BST/GMT boundary around 2026-10-25", () => {
  // clocks go back at 01:00 UTC on 2026-10-25 (BST ends)
  assert.equal(toLondonDate("2026-10-24T22:59:59Z"), "2026-10-24"); // 23:59 BST
  assert.equal(toLondonDate("2026-10-24T23:00:00Z"), "2026-10-25"); // 00:00 BST
  assert.equal(toLondonDate("2026-10-24T23:30:00Z"), "2026-10-25");
  assert.equal(toLondonDate("2026-10-25T00:30:00Z"), "2026-10-25"); // 01:30 BST
  assert.equal(toLondonDate("2026-10-25T01:30:00Z"), "2026-10-25"); // 01:30 GMT
  assert.equal(toLondonDate("2026-10-25T23:30:00Z"), "2026-10-25"); // 23:30 GMT
  assert.equal(toLondonDate("2026-10-26T00:00:00Z"), "2026-10-26");
});

test("toLondonDate: spring forward and other zones", () => {
  assert.equal(toLondonDate("2026-03-28T23:30:00Z"), "2026-03-28"); // GMT
  assert.equal(toLondonDate("2026-03-29T23:30:00Z"), "2026-03-30"); // BST
  assert.equal(toLondonDate("2026-10-21T23:30:00Z", "UTC"), "2026-10-21");
  assert.equal(toLondonDate("2026-10-21T23:30:00Z", "Asia/Tokyo"), "2026-10-22");
  assert.throws(() => toLondonDate("not a date"));
});

test("date helpers", () => {
  assert.equal(addDays("2026-10-21", -45), "2026-09-06");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.ok(isDateString("2026-02-28"));
  assert.ok(!isDateString("2026-02-30x"));
  assert.ok(!isDateString("26-1-1"));
});

test("normaliseCategoryId", () => {
  const idx = index();
  assert.deepEqual(normaliseCategoryId("12", idx), {
    categoryId: "std:00000000-0000-4000-8000-000000000001",
    internalCategoryId: "12",
  });
  assert.deepEqual(normaliseCategoryId(12, idx).categoryId, "std:00000000-0000-4000-8000-000000000001");
  // entry without an externalId and not in the public list by key
  assert.deepEqual(normaliseCategoryId("99", idx), { categoryId: "std-numeric:99", internalCategoryId: "99" });
  assert.deepEqual(normaliseCategoryId("4242", idx), { categoryId: "std-numeric:4242", internalCategoryId: "4242" });
  assert.deepEqual(normaliseCategoryId("00000000-0000-4000-8000-000000000100", idx), {
    categoryId: "cus:00000000-0000-4000-8000-000000000100",
  });
  assert.deepEqual(normaliseCategoryId("00000000-0000-4000-8000-0000000009ff", idx), { categoryId: "00000000-0000-4000-8000-0000000009ff" });
  assert.deepEqual(normaliseCategoryId("std:abc", idx), { categoryId: "std:abc" });
  assert.deepEqual(normaliseCategoryId(null, idx), { categoryId: null });
  assert.deepEqual(normaliseCategoryId(undefined, idx), { categoryId: null });
});

test("normaliseCategoryId without extracted table", () => {
  const idx = buildCategoryIndex({});
  assert.deepEqual(normaliseCategoryId("12", idx), { categoryId: "std-numeric:12", internalCategoryId: "12" });
});

test("buildCategoryIndex merges sources", () => {
  const idx = index();
  const home = idx.byId.get("std:00000000-0000-4000-8000-000000000001")!;
  assert.equal(home.key, "homeMaintenance");
  assert.equal(home.name, "Home maintenance");
  assert.equal(home.internalId, "12");
  assert.equal(home.groupId, "group:8");
  assert.equal(home.groupKey, "bills");
  assert.equal(home.groupName, "Bills");
  assert.equal(home.custom, false);
  // public-only category is present, without an internal id
  const salary = idx.byId.get("std:00000000-0000-4000-8000-000000000004")!;
  assert.equal(salary.internalId, undefined);
  assert.equal(salary.name, "Salary");
  // group key with camelCase title-cased
  assert.equal(idx.byId.get("std:00000000-0000-4000-8000-000000000003")!.groupName, "Daily Living");
  const mystery = idx.byId.get("std-numeric:99")!;
  assert.equal(mystery.name, "Mystery"); // no display name: title-cased key
  const cus = idx.byId.get("cus:00000000-0000-4000-8000-000000000100")!;
  assert.equal(cus.custom, true);
  assert.equal(cus.name, "Side project costs");
  assert.equal(cus.groupKey, "bills");
  assert.equal(titleCase("home-maintenance"), "Home Maintenance");
});

test("buildCategoryIndex fills a missing externalId from the public list and logs mismatches", () => {
  const warnings: string[] = [];
  const idx = buildCategoryIndex({
    extracted: [
      { uid: 12, key: "homeMaintenance", group: 8 },
      { uid: 5, key: "automotive", group: 9, externalId: "00000000-0000-4000-8000-000000000002" },
    ],
    publicCategories: parsePublicCategories(fixture("public-categories.json"), fixture("public-category-groups.json")),
    warn: (m) => warnings.push(m),
  });
  assert.equal(idx.byInternal.get("12")!.categoryId, "std:00000000-0000-4000-8000-000000000001");
  assert.ok(warnings.some((w) => /group/.test(w) && /automotive/.test(w)));
});

test("resolveCategoryRef by id, internal id, key and name", () => {
  const idx = index();
  const want = ["std:00000000-0000-4000-8000-000000000001"];
  assert.deepEqual(resolveCategoryRef("12", idx), want);
  assert.deepEqual(resolveCategoryRef("homemaintenance", idx), want);
  assert.deepEqual(resolveCategoryRef("Home maintenance", idx), want);
  assert.deepEqual(resolveCategoryRef(want[0], idx), want);
  assert.deepEqual(resolveCategoryRef("nope", idx), []);
});

test("mapTransaction", () => {
  const idx = index();
  const raws = fixture<any[]>("transactions.json");
  const t = mapTransaction(raws[0], { index: idx });
  assert.equal(t.id, "tx-1");
  assert.equal(t.accountId, "acc-auto");
  assert.deepEqual(t.amount, { value: -1250, major: -12.5, currency: "GBP" });
  assert.equal(t.shortDescription, "Example Hardware");
  assert.equal(t.longDescription, "EXAMPLE HARDWARE LTD 0001 CARD");
  assert.equal(t.categoryId, "std:00000000-0000-4000-8000-000000000001");
  assert.equal(t.internalCategoryId, "12");
  assert.equal(t.projectId, "proj-1");
  assert.equal(t.label, undefined); // empty string dropped
  assert.equal(t.raw, undefined);
  assert.equal(t.bookingDate, "2026-10-20");
  assert.equal(mapTransaction(raws[0], { index: idx, includeRaw: true }).raw, raws[0]);
  // London date differs from the UTC date
  assert.equal(mapTransaction(raws[1], { index: idx }).bookingDate, "2026-10-25");
  assert.equal(mapTransaction(raws[1], { index: idx }).amount.value, -29);
  assert.equal(mapTransaction(raws[2], { index: idx }).amount.value, 10010);
  assert.equal(mapTransaction(raws[2], { index: idx }).categoryId, "cus:00000000-0000-4000-8000-000000000100");
  assert.equal(mapTransaction(raws[3], { index: idx }).deleted, true);
  assert.equal(mapTransaction(raws[4], { index: idx }).categoryId, "std-numeric:9999");
  assert.equal(toMinor(0.29), 29);
  assert.equal(toMinor(-12.5), -1250);
});

test("mapAccount: manual account uses the balance date", () => {
  const raws = fixture<any[]>("accounts.json");
  const a = mapAccount(raws[0], NOW);
  assert.equal(a.id, "acc-manual-old");
  assert.equal(a.manual, true);
  assert.equal(a.auto, false);
  assert.equal(a.name, "Example House");
  assert.equal(a.provider, null);
  assert.deepEqual(a.balance, { value: 25000000, major: 250000, currency: "GBP" });
  assert.equal(a.balanceDate, "2026-08-01");
  assert.equal(a.providerLastUpdated, null);
  assert.equal(a.lastUpdated, "2026-08-01");
  assert.equal(a.daysSinceUpdate, 81);
  assert.equal(a.netWorthContribution, 50);
  assert.equal(a.yearlyAppreciation, 2);
  // 81 days = 2 whole months of appreciation at 2%/year; 50% counts towards net worth
  assert.equal(a.value!.major, Math.round(250000 * Math.pow(1.02, 2 / 12) * 100) / 100);
  assert.equal(a.netWorthValue.major, Math.round(250000 * Math.pow(1.02, 2 / 12) * 50) / 100);
  assert.equal(a.netWorthEnabled, true);
  assert.equal(a.active, true);
  const json = JSON.stringify(a);
  assert.ok(!json.includes("SENSITIVE"));
  assert.ok(!("parties" in a));
});

test("mapAccount: auto account, fallback names and latest of the two dates", () => {
  const a = mapAccount(fixture<any[]>("accounts.json")[3], NOW);
  assert.equal(a.name, "Example Current");
  assert.equal(a.provider, "Example Bank");
  assert.equal(a.auto, true);
  assert.equal(a.lastUpdated, "2026-10-21T08:34:27.679+00:00");
  assert.equal(a.daysSinceUpdate, 0);
});

test("mapAccount: tolerant of missing and odd fields", () => {
  const a = mapAccount({ uid: "x" }, NOW);
  assert.equal(a.balance, null);
  assert.equal(a.balanceDate, null);
  assert.equal(a.lastUpdated, null);
  assert.equal(a.daysSinceUpdate, null);
  assert.equal(a.name, "");
  assert.equal(a.manual, true);
  // balances win over currentBalance (the web app's rule)
  const b = mapAccount({ uid: "y", currentBalance: 12.34, balances: [null, { date: "2026-10-01", amount: { value: 5 } }, { amount: 1 }] }, NOW);
  assert.equal(b.balance!.major, 5);
  // currentBalance is only a fallback when balances is missing or empty
  assert.equal(mapAccount({ uid: "y2", currentBalance: 12.34 }, NOW).balance!.major, 12.34);
  assert.equal(mapAccount({ uid: "y3", currentBalance: { amount: 7, date: "2026-10-02" }, balances: [] }, NOW).balanceDate, "2026-10-02");
  assert.equal(b.balanceDate, "2026-10-01");
  // falls back to the newest balances entry when currentBalance is absent
  const c = mapAccount({ uid: "z", balances: [{ date: "2026-09-01", amount: 1 }, { date: "2026-10-10", amount: 2 }] }, NOW);
  assert.equal(c.balance!.major, 2);
  assert.equal(c.balanceDate, "2026-10-10");
});

test("staleness filter and sort", () => {
  const accts = fixture<any[]>("accounts.json").map((r) => mapAccount(r, NOW));
  const stale30 = filterStale(accts, 30).map((a) => a.id);
  assert.deepEqual(stale30.sort(), ["acc-deleted", "acc-manual-never", "acc-manual-old"]);
  assert.ok(!stale30.includes("acc-auto")); // auto accounts are never "manual stale"
  assert.ok(!stale30.includes("acc-manual-new")); // 6 days
  assert.deepEqual(filterStale(accts, 6).map((a) => a.id).includes("acc-manual-new"), true);
  const order = sortByStaleness(accts).map((a) => a.daysSinceUpdate);
  assert.equal(order[0], null); // never updated first
  const nums = order.filter((n): n is number => n !== null);
  assert.deepEqual(nums, [...nums].sort((x, y) => y - x));
});

test("mergeByUid", () => {
  const row = (uid: string, bookingDate: string, extra: Record<string, unknown> = {}): Record<string, any> => ({ uid, bookingDate, amount: 1, ...extra });
  const existing = [
    row("old", "2026-01-01"), // outside window, absent from fresh: untouched
    row("same", "2026-10-10"),
    row("changed", "2026-10-11", { category: "a" }),
    row("gone", "2026-10-12"), // in window, absent from fresh: kept + flagged
    row("del", "2026-10-13", { deleted: true }), // deleted stays flagged
    row("back", "2026-10-14", { missingFromSource: true }),
  ];
  const fresh = [
    row("same", "2026-10-10"),
    row("changed", "2026-10-11", { category: "b" }),
    row("new", "2026-10-15"),
    row("back", "2026-10-14"),
    row("del", "2026-10-13", { deleted: true }),
  ];
  const r = mergeByUid(existing, fresh, "2026-10-01", "2026-10-31");
  assert.deepEqual({ a: r.added, u: r.updated, n: r.unchanged, m: r.missing }, { a: 1, u: 2, n: 2, m: 1 });
  assert.deepEqual(r.rows.map((x) => x.uid), ["old", "same", "changed", "gone", "del", "back", "new"]);
  assert.equal(r.rows.find((x) => x.uid === "gone")!.missingFromSource, true);
  assert.equal(r.rows.find((x) => x.uid === "old")!.missingFromSource, undefined);
  assert.equal(r.rows.find((x) => x.uid === "changed")!.category, "b");
  assert.equal(r.rows.find((x) => x.uid === "back")!.missingFromSource, undefined);
  assert.equal(r.rows.find((x) => x.uid === "del")!.deleted, true);
  assert.equal(r.rows.length, 7);
  // idempotent
  const again = mergeByUid(r.rows, fresh, "2026-10-01", "2026-10-31");
  assert.deepEqual({ a: again.added, u: again.updated }, { a: 0, u: 0 });
  assert.equal(again.rows.length, 7);
  // inputs not mutated
  assert.equal(existing[3].missingFromSource, undefined);
});

test("extractCategories on a synthetic bundle", () => {
  const src = readFileSync(join(here, "fixtures", "bundle-snippet.js"), "utf8");
  const list = extractCategories(src);
  assert.deepEqual(list.map((e) => e.uid), [1, 5, 7, 12]);
  const home = list.find((e) => e.uid === 12)!;
  assert.deepEqual(home, { uid: 12, key: "homeMaintenance", group: 8, externalId: "00000000-0000-4000-8000-000000000001" }); // preferred the copy with externalId
  assert.equal(list.find((e) => e.uid === 5)!.externalId, "00000000-0000-4000-8000-000000000002"); // different field order
  assert.equal(list.find((e) => e.uid === 7)!.externalId, null); // quoted keys, no externalId
  assert.equal(list.find((e) => e.uid === 3), undefined);
});

test("categories without a display name fall back to a title-cased key", () => {
  const idx = buildCategoryIndex({
    extracted: [{ uid: 120, key: "dividends", group: 2 }, { uid: 12, key: "homeMaintenance", group: 8 }],
    names: { categories: { homeMaintenance: "Home upkeep" }, groups: {} },
  });
  assert.equal(idx.byInternal.get("120")!.name, "Dividends");
  assert.equal(idx.byInternal.get("12")!.name, "Home upkeep"); // a real name still wins
  assert.equal(titleCase("homeMaintenance"), "Home Maintenance");
});

test("accountDisplayName: holder names are replaced by the product name, else bank + type", () => {
  assert.equal(accountDisplayName({ uid: "a", accountName: "Everyday Saver" }), "Everyday Saver");
  assert.equal(accountDisplayName({ uid: "a", accountName: "MR A SMITH", productName: "Rewards Card" }), "Rewards Card");
  assert.equal(
    accountDisplayName({ uid: "a", accountName: "DR B SMITH & MR A SMITH", bankName: "Example Bank (sort code 00)", type: "savings" }),
    "Example Bank savings",
  );
  assert.equal(accountDisplayName({ uid: "a", accountName: "A Smith", parties: [{ name: "a smith" }], bankName: "Example Bank", type: "cash" }), "Example Bank current account");
  assert.equal(accountDisplayName({ uid: "a", accountName: "Dream fund", productName: "Ignored" }), "Dream fund");
});

test("archiveOf: closed in the past = archived; future or missing = not", () => {
  const now = new Date("2026-10-21T12:00:00Z");
  assert.deepEqual(archiveOf("2024-03-30T10:05:50.931Z", now), { archived: true, archivedAt: "2024-03-30T10:05:50.931Z" });
  assert.deepEqual(archiveOf("2027-01-01T00:00:00Z", now), { archived: false, archivedAt: "2027-01-01T00:00:00Z" });
  assert.deepEqual(archiveOf(undefined, now), { archived: false, archivedAt: null });
  assert.deepEqual(archiveOf(null, now), { archived: false, archivedAt: null });
  assert.equal(mapAccount({ uid: "a", closed: "2024-01-01T00:00:00Z" }, now).archived, true);
});

test("balanceForDate: sorting, initial tie-break, before/between/after, undated", () => {
  const bs = [
    { date: "2026-03-01T10:00:00Z", amount: 3 },
    { date: "2026-01-01", amount: 1 },
    { date: "2026-02-01", amount: 20 },
    { date: "2026-02-01", amount: 10, tag: "initial" },
  ];
  assert.equal(balanceForDate(bs, "2025-12-31"), undefined);
  assert.equal(balanceForDate(bs, "2026-01-01")!.amount, 1);
  // tie: the initial entry sorts first, so the other one on that date wins
  assert.equal(balanceForDate(bs, "2026-02-15")!.amount, 20);
  assert.equal(balanceForDate(bs, "2026-03-01")!.amount, 3);
  assert.equal(balanceForDate(bs, "2030-01-01")!.amount, 3);
  assert.equal(balanceForDate([{ amount: 1 }, { amount: 2 }], "2026-01-01")!.amount, 2);
  assert.equal(balanceForDate([], "2026-01-01"), undefined);
  assert.equal(balanceForDate(undefined, "2026-01-01"), undefined);
  // initial tie, where that entry is listed last in the source
  assert.equal(balanceForDate([{ date: "2026-02-01", amount: 2 }, { date: "2026-02-01", amount: 1, tag: "initial" }], "2026-02-01")!.amount, 2);
});

test("currentValue: property appreciation, archived, asset, other types", () => {
  const now = new Date("2026-10-21T12:00:00Z");
  const prop = { uid: "p", type: "properties", yearlyAppreciation: 2, balances: [{ date: "2026-04-06", amount: 845000 }] };
  // 198 days -> floor(198 / 30.4167) = 6 months
  assert.equal(currentValue(prop, now), 845000 * Math.pow(1.02, 0.5));
  assert.equal(currentValue({ ...prop, balances: [{ date: "2026-09-22", amount: 845000 }] }, now), 845000); // 29 days
  assert.equal(currentValue({ ...prop, type: "asset" }, now), 845000 * Math.pow(1.02, 0.5));
  assert.equal(currentValue({ ...prop, yearlyAppreciation: undefined }, now), 845000);
  assert.equal(currentValue({ ...prop, closed: "2026-01-01T00:00:00Z" }, now), 0);
  assert.equal(currentValue({ ...prop, balances: [] }, now), undefined);
  // other types use balances, not currentBalance, and do not appreciate
  const cash = { uid: "c", type: "cash", yearlyAppreciation: 5, currentBalance: { amount: 999, date: "2026-10-20" }, balances: [{ date: "2026-01-01", amount: 5 }, { date: "2026-10-01", amount: 7 }] };
  assert.equal(currentValue(cash, now), 7);
  assert.equal(currentValue({ ...cash, balances: undefined }, now), 999); // CLI fallback
});

test("netWorthValue: currency, disabled, contribution percentages", () => {
  const now = new Date("2026-10-21T12:00:00Z");
  const base = { uid: "a", type: "cash", balances: [{ date: "2026-10-01", amount: 1000 }] };
  assert.equal(netWorthValue(base, now), 1000);
  assert.equal(netWorthValue({ ...base, netWorthContribution: null }, now), 1000);
  assert.equal(netWorthValue({ ...base, netWorthContribution: 50 }, now), 500);
  assert.equal(netWorthValue({ ...base, netWorthContribution: 0 }, now), 0);
  assert.equal(netWorthValue({ ...base, netWorthEnabled: false }, now), 0);
  assert.equal(netWorthValue({ ...base, currency: "USD" }, now), 0);
  assert.equal(netWorthValue({ ...base, balances: [] }, now), 0);
});

test("netWorthTotal: deleted excluded, archived 0, disabled 0", () => {
  const now = new Date("2026-10-21T12:00:00Z");
  const bal = (amount: number) => [{ date: "2026-10-01", amount }];
  const raws = [
    { uid: "1", type: "cash", balances: bal(100.1) },
    { uid: "2", type: "savings", balances: bal(200.2), netWorthContribution: 50 },
    { uid: "3", type: "cash", balances: bal(5000), deleted: true },
    { uid: "4", type: "cash", balances: bal(5000), deletedConnection: true },
    { uid: "5", type: "cash", balances: bal(5000), closed: "2026-01-01T00:00:00Z" },
    { uid: "6", type: "cash", balances: bal(5000), netWorthEnabled: false },
  ];
  assert.equal(netWorthTotal(raws, now), 200.2);
});

test("mapAccount: deleted accounts contribute 0 to netWorthValue so column sums match the total", () => {
  const now = new Date("2026-10-21T12:00:00Z");
  const a = mapAccount({ uid: "d", deleted: true, type: "savings", currency: "GBP", balances: [{ date: "2026-10-01", amount: 12.27 }] }, now);
  assert.equal(a.netWorthValue.major, 0);
  assert.equal(a.value?.major, 12.27);
});

test("mapAccount: defined benefit pension fields and contributions", () => {
  const a = mapAccount({
    uid: "db-1", accountName: "DB scheme", type: "pension", subType: "definedBenefit", auto: false, currency: "GBP",
    dateCreated: "2025-07-22T12:58:57.683Z", income: 1234.5, dateBenefitStarts: "2051-01-07",
    balances: [{ date: "2025-07-22", amount: 0 }],
    employeeContribution: { type: "amount", value: 100 }, employerContribution: { type: "percent" },
  }, new Date("2026-10-21T12:00:00Z"));
  assert.equal(a.subType, "definedBenefit");
  assert.deepEqual(a.income, { value: 123450, major: 1234.5, currency: "GBP" });
  assert.equal(a.incomeDate, null);
  assert.equal(a.dateBenefitStarts, "2051-01-07");
  assert.deepEqual(a.employeeContribution, { type: "amount", value: 100 });
  assert.equal(a.employerContribution, null);
  const row = accountRow(a, "Europe/London");
  assert.equal(row.income, 1234.5);
  assert.equal(row.incomeLastChanged, "2025-07-22"); // first seen: the creation date
  assert.equal(row.employeeContributionType, "amount");
  const withDate = accountRow(mapAccount({ uid: "db-2", type: "pension", income: 10, incomeDate: "2026-03-31", dateCreated: "2025-01-01T00:00:00Z" }), "Europe/London");
  assert.equal(withDate.incomeLastChanged, "2026-03-31");
  const dc = accountRow(mapAccount({ uid: "dc-1", type: "pension", subType: "definedContribution", dateCreated: "2025-01-01T00:00:00Z" }), "Europe/London");
  assert.equal(dc.income, null);
  assert.equal(dc.incomeLastChanged, null);
});

test("trackIncomeLastChanged: carried over while unchanged, today when the income changes", () => {
  const rows = [
    { id: "a", income: 100, incomeDate: null, incomeLastChanged: "2025-07-22" },
    { id: "b", income: 250, incomeDate: null, incomeLastChanged: "2025-07-22" },
    { id: "c", income: 50, incomeDate: null, incomeLastChanged: "2025-01-01" },
    { id: "d", income: 75, incomeDate: "2026-03-31", incomeLastChanged: "2026-03-31" },
    { id: "e", income: null, incomeDate: null, incomeLastChanged: null },
  ];
  const previous = [
    { id: "a", income: 100, incomeLastChanged: "2026-05-01" },
    { id: "b", income: 200, incomeLastChanged: "2026-05-01" },
    { id: "d", income: 70, incomeLastChanged: "2026-05-01" },
  ];
  const out = trackIncomeLastChanged(rows, previous, "2026-10-21");
  assert.deepEqual(out.map((r) => r.incomeLastChanged), ["2026-05-01", "2026-10-21", "2025-01-01", "2026-03-31", null]);
});
