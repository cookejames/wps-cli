import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { AuthError } from "../src/errors.ts";
import { clearSecrets, parseSession, readSession, redact } from "../src/session.ts";
import { runMutation } from "../src/mutation.ts";
import { renderTable } from "../src/table.ts";
import { parseConfig } from "../src/config.ts";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// built at runtime so no JWT-shaped literal sits in the source
const JWT = ["eyJ" + "hbGciOiJIUzI1NiJ9", "eyJ" + "zdWIiOiJ0ZXN0In0", "c2lnbmF0dXJl"].join(".");

test("redaction removes cookie, csrf and JWT-shaped strings from an error message", () => {
  const cookie = "sid-0123456789abcdef=ZZsecretcookievalueZZ; other=anothervalue1";
  const csrf = "CSRFtokenValue-123";
  parseSession(JSON.stringify({ cookie, csrf }));
  const msg = `failed with ${cookie} and header ${csrf}; value ZZsecretcookievalueZZ; token ${JWT}; plain text kept`;
  const out = redact(msg);
  for (const s of [cookie, csrf, "ZZsecretcookievalueZZ", "anothervalue1", JWT, "hbGciOi"]) assert.ok(!out.includes(s), `leaked: ${s}`);
  assert.ok(out.includes("plain text kept"));
  clearSecrets();
  // JWT-shaped strings are removed even with no session registered
  assert.ok(!redact(`x ${JWT} y`).includes("hbGciOi"));
});

test("parseSession validation", () => {
  const bad = ["", "  ", "not json", "[]", "null", "{}", '{"cookie":"a"}', '{"csrf":"b"}', '{"cookie":"","csrf":"b"}', '{"cookie":1,"csrf":"b"}'];
  for (const raw of bad) assert.throws(() => parseSession(raw), AuthError, raw);
  const s = parseSession('{"cookie":"abcd=1234567890","csrf":"tok-value","userAgent":" UA/1 "}');
  assert.deepEqual(s, { cookie: "abcd=1234567890", csrf: "tok-value", userAgent: "UA/1" });
  clearSecrets();
});

test("readSession: tty and empty stdin are auth failures", async () => {
  const tty = Object.assign(Readable.from([]), { isTTY: true });
  await assert.rejects(readSession(tty), AuthError);
  await assert.rejects(readSession(Readable.from([])), AuthError);
  const ok = await readSession(Readable.from(['{"cookie":"c=abcdefgh1","csrf":"csrf-1234"}']));
  assert.equal(ok.csrf, "csrf-1234");
  clearSecrets();
});

test("mutation: dry-run by default, audit line only with yes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wps-audit-"));
  let applied = 0;
  const spec = { command: "accounts set-balance", target: "acc-1", change: { from: 1, to: 2 }, request: { method: "PATCH", path: "/x" } };
  const dry = await runMutation(spec, { yes: false, logDir: dir }, async () => ++applied);
  assert.equal(dry.dryRun, true);
  assert.equal(applied, 0);
  assert.ok(!existsSync(join(dir, "audit.log")));
  const real = await runMutation(spec, { yes: true, logDir: dir, now: () => new Date("2026-10-21T12:00:00Z") }, async () => ++applied);
  assert.equal(real.dryRun, false);
  assert.equal(applied, 1);
  const line = JSON.parse(readFileSync(join(dir, "audit.log"), "utf8").trim());
  assert.deepEqual(line, { ts: "2026-10-21T12:00:00.000Z", command: "accounts set-balance", target: "acc-1", change: { from: 1, to: 2 } });
});

test("table rendering", () => {
  const t = renderTable([{ a: 1, b: { c: "x" } }, { a: 22, b: { c: null } }], ["a", "b.c"]);
  assert.equal(t, "a   b.c\n--  ---\n1   x\n22\n");
  assert.equal(renderTable([]), "(no rows)\n");
});

test("config parsing", () => {
  const c = parseConfig({ apiBase: "https://x.example.com/" });
  assert.equal(c.apiBase, "https://x.example.com");
  assert.equal(c.windowDays, 45);
  assert.equal(c.timezone, "Europe/London");
  assert.equal(c.logDir, "./logs");
  assert.throws(() => parseConfig({ windowDays: 0 }));
  assert.throws(() => parseConfig({ timezone: "Mars/Base" }));
  assert.throws(() => parseConfig([]));
  assert.deepEqual(c.historyExclusions, []);
  const ex = { account: "a1", from: "2026-01-01", to: "2026-02-01", reason: "duplicate" };
  assert.deepEqual(parseConfig({ historyExclusions: [ex] }).historyExclusions, [ex]);
  assert.throws(() => parseConfig({ historyExclusions: [{ ...ex, from: "2026-03-01" }] })); // from after to
  assert.throws(() => parseConfig({ historyExclusions: [{ ...ex, to: "1 Feb" }] }));
  assert.throws(() => parseConfig({ historyExclusions: [{ from: ex.from, to: ex.to }] }));
});
