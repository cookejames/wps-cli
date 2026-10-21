import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthError, UpstreamError } from "../src/errors.ts";
import { InternalWebBackend } from "../src/backends/internal-web/index.ts";
import { parseConfig } from "../src/config.ts";
import { parseSession } from "../src/session.ts";

const config = parseConfig({ apiBase: "https://asm.example-tenant.com/", webOrigin: "https://www.example-tenant.com", tenantId: "tenant-x" });
const COOKIE = "sid-abcdef0123456789=secretvalue12345";
const CSRF = "csrf-token-value-9876";

function backend(handler: (url: string, init: RequestInit) => Response | Promise<Response>, ua?: string) {
  const calls: { url: string; init: RequestInit }[] = [];
  const session = parseSession(JSON.stringify({ cookie: COOKIE, csrf: CSRF, ...(ua ? { userAgent: ua } : {}) }));
  const f = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as typeof fetch;
  return { b: new InternalWebBackend(config, session, f, [0, 0]), calls };
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
const wrap = (result: unknown[]) => ({ data: { result, meta: {} } });

test("sends the required headers on every request", async () => {
  const { b, calls } = backend(() => json({}));
  await b.checkSession();
  const h = calls[0].init.headers as Record<string, string>;
  assert.equal(calls[0].url, "https://asm.example-tenant.com/apiv2/profile");
  assert.equal(h.cookie, COOKIE);
  assert.equal(h["csrf-token"], CSRF);
  assert.equal(h.origin, "https://www.example-tenant.com");
  assert.equal(h.referer, "https://www.example-tenant.com/");
  assert.equal(h.accept, "application/json, text/plain, */*");
  assert.equal(h["accept-language"], "en-GB,en;q=0.9");
  assert.match(h["user-agent"], /Firefox/);
});

test("uses the session's userAgent when supplied", async () => {
  const { b, calls } = backend(() => json({}), "TestAgent/1.0");
  await b.checkSession();
  assert.equal((calls[0].init.headers as Record<string, string>)["user-agent"], "TestAgent/1.0");
});

test("401/403 and csrf messages are auth errors, without leaking secrets", async () => {
  for (const [status, body] of [[401, "x"], [403, "x"], [200, "Invalid csrf"], [400, "No csrf found in headers"]] as const) {
    const { b } = backend(() => new Response(body, { status }));
    await assert.rejects(b.checkSession(), (e: Error) => {
      assert.ok(e instanceof AuthError);
      assert.ok(!e.message.includes(COOKIE) && !e.message.includes(CSRF));
      return true;
    });
  }
});

test("other statuses and bad shapes are upstream errors", async () => {
  await assert.rejects(backend(() => new Response("boom", { status: 500 })).b.checkSession(), UpstreamError);
  await assert.rejects(backend(() => new Response("<html>", { status: 200 })).b.checkSession(), UpstreamError);
  await assert.rejects(backend(() => json({ data: {} })).b.listTransactions("2026-01-01", "2026-01-02"), UpstreamError);
  await assert.rejects(backend(() => json(wrap([{ uid: "a", date: "2026-01-01T00:00:00Z", amount: "1" }]))).b.listTransactions("a", "b"), UpstreamError);
  await assert.rejects(backend(() => json(wrap([{ name: "no uid" }]))).b.listAccounts(), UpstreamError);
});

test("network failure message is redacted", async () => {
  const { b } = backend(() => {
    throw new Error(`socket error for ${CSRF}`);
  });
  await assert.rejects(b.checkSession(), (e: Error) => e instanceof UpstreamError && !e.message.includes(CSRF));
});

test("listTransactions requests the date range", async () => {
  const { b, calls } = backend(() => json(wrap([{ uid: "a", date: "2026-01-01T00:00:00Z", amount: 1 }])));
  const rows = await b.listTransactions("2026-01-01", "2026-01-31");
  assert.equal(rows.length, 1);
  assert.equal(calls[0].url, "https://asm.example-tenant.com/apiV2/transactions?startDate=2026-01-01&endDate=2026-01-31");
});

test("listProjects: graphql shape, nulls and errors", async () => {
  const ok = backend((_u, init) => {
    assert.equal(init.method, "POST");
    assert.match(JSON.parse(init.body as string).query, /genericProjects/);
    return json({ data: { genericProjects: [{ id: "p1", name: "One", __typename: "GenericProject" }], propertyProjects: null } });
  });
  assert.deepEqual(await ok.b.listProjects(), [{ id: "p1", name: "One", type: "GenericProject" }]);
  await assert.rejects(backend(() => json({ errors: [{ message: "bad" }] })).b.listProjects(), UpstreamError);
});

test("getCategoryNames reads data.categories and the tenant id", async () => {
  const { b, calls } = backend(() => json({ data: { categories: { automotive: "Car" }, categoryGroups: { bills: "Bills & household" } } }));
  const n = await b.getCategoryNames();
  assert.equal(n.categories.automotive, "Car");
  assert.equal(n.groups.bills, "Bills & household");
  assert.match(calls[0].url, /text\/resources\?tenantId=tenant-x&type=postlogin$/);
});

test("requests are serialised with a pause between them", async () => {
  const session = parseSession(JSON.stringify({ cookie: COOKIE, csrf: CSRF }));
  let active = 0;
  let maxActive = 0;
  const times: number[] = [];
  const f = (async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    times.push(Date.now());
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return json(wrap([]));
  }) as typeof fetch;
  const b = new InternalWebBackend(config, session, f, [40, 40]);
  await Promise.all([b.listAccounts(), b.listCustomCategories(), b.listAccounts()]);
  assert.equal(maxActive, 1);
  assert.ok(times[1] - times[0] >= 35 && times[2] - times[1] >= 35);
});
