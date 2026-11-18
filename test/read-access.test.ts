import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { favoriteRequest } from "../src/favorite.ts";
import { shareCode } from "../src/index.ts";
import { protectRead, readLogin } from "../src/read-auth.ts";
import { readProgress } from "../src/read-progress.ts";
import { shouldOfferRemoteSync } from "../src/reader/reading.ts";

const origin = "https://example.com";
const code = shareCode(42);
function environment() {
  let count = 0;
  return { FAVORITE_PIN: "012345", FAVORITE_SESSION_SECRET: "1234567890abcdef1234567890abcdef", FAVORITE_LOGIN_LIMIT: { getByName: () => ({ attempt: async () => ++count <= 5 }) } };
}

test("reading access requires the existing session and login rejects forged requests", async () => {
  const env = environment();
  for (const path of ["/read?tab=weekly", `/r/${code}`, "/api/read", `/api/r/${code}`, `/api/progress/${code}`]) {
    const response = await protectRead(new Request(origin + path), env);
    assert.ok(response);
    assert.equal(response.status, path.startsWith("/api/") ? 401 : 302);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    if (!path.startsWith("/api/")) {
      const location = new URL(response.headers.get("Location")!);
      assert.equal(location.pathname, "/auth");
      assert.equal(location.searchParams.get("next"), path);
    }
  }
  assert.equal(await protectRead(new Request(`${origin}/s/${code}`), env), null);
  assert.equal(await protectRead(new Request(`${origin}/api/s/${code}`), env), null);
  const loginUrl = `${origin}/auth?next=${encodeURIComponent(`/r/${code}?tab=weekly`)}`;
  const login = await readLogin(new Request(loginUrl), env);
  const csrfCookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const token = (await login.text()).match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
  const post = (pin: string, requestOrigin = origin, csrf = token) => new Request(loginUrl, { method: "POST", headers: { Origin: requestOrigin, Cookie: csrfCookie, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, pin }) });
  assert.equal((await readLogin(post("012345", "https://evil.example"), env)).status, 403);
  assert.equal((await readLogin(post("012345", origin, "0".repeat(64)), env)).status, 403);
  const wrongPin = await readLogin(post("999999"), env);
  assert.equal(wrongPin.status, 401);
  const errorPage = await wrongPin.text();
  assert.match(errorPage, /aria-invalid="true" aria-describedby="auth-error"/);
  assert.ok(errorPage.indexOf('class="pin-slots"') < errorPage.indexOf('id="auth-error"'));
  const success = await readLogin(post("012345"), env);
  assert.equal(success.status, 303);
  assert.equal(success.headers.get("Location"), `/r/${code}?tab=weekly`);
  const session = success.headers.get("set-cookie")!.split(";")[0]!;
  assert.match(session, /^__Host-read-session=/);
  assert.equal(await protectRead(new Request(`${origin}/api/r/${code}`, { headers: { Cookie: session } }), env), null);
  assert.ok(await protectRead(new Request(`${origin}/read`, { headers: { Cookie: session } }), { ...env, FAVORITE_PIN: "654321" }));
});

test("refreshes, other tabs and reading actions do not expire an open login form", async () => {
  const env = environment();
  const loginUrl = `${origin}/auth?next=%2Fread`;
  const first = await readLogin(new Request(loginUrl), env);
  const firstHtml = await first.text();
  const token = firstHtml.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
  const firstNonce = firstHtml.match(/<script nonce="([a-f0-9]+)">/)![1]!;
  let browserCookie = first.headers.get("set-cookie")!.split(";")[0]!;
  for (let i = 0; i < 2; i++) {
    const page = await readLogin(new Request(loginUrl, { headers: { Cookie: browserCookie } }), env);
    browserCookie = page.headers.get("set-cookie")!.split(";")[0]!;
    const html = await page.text();
    assert.equal(html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1], token);
    const nonce = html.match(/<script nonce="([a-f0-9]+)">/)?.[1];
    assert.ok(nonce);
    assert.notEqual(nonce, token);
    assert.notEqual(nonce, firstNonce);
    assert.ok(page.headers.get("Content-Security-Policy")?.includes(`script-src 'nonce-${nonce}'`));
  }
  const action = await favoriteRequest(new Request(`${origin}/read/favorite/${code}`, { headers: { Cookie: browserCookie, Accept: "application/json" } }), env, code, async () => true, () => "");
  browserCookie = action.headers.get("set-cookie")!.split(";")[0]!;
  assert.equal((await action.json<{ csrf: string }>()).csrf, token);
  const submit = (pin: string, cookie = browserCookie) => readLogin(new Request(loginUrl, {
    method: "POST", headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf: token, pin }),
  }), env);
  assert.equal((await submit("012345", "")).status, 403);
  const wrong = await submit("999999");
  assert.equal(wrong.status, 401);
  browserCookie = wrong.headers.get("set-cookie")!.split(";")[0]!;
  assert.equal((await wrong.text()).match(/name="csrf" value="([a-f0-9]+)"/)?.[1], token);
  const success = await submit("012345");
  assert.equal(success.status, 303);
  assert.equal(success.headers.get("Location"), "/read");
});

test("login page reuses the PIN input and submits once when six digits are entered", async () => {
  const response = await readLogin(new Request(`${origin}/auth?next=%2Fread`), environment());
  assert.equal(response.headers.get("Referrer-Policy"), "same-origin");
  const html = await response.text();
  const nonce = html.match(/<script nonce="([a-f0-9]+)">/)?.[1];
  const script = html.match(/<script nonce="[a-f0-9]+">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(nonce && script);
  assert.ok(response.headers.get("Content-Security-Policy")?.includes(`script-src 'nonce-${nonce}'`));
  assert.match(html, /<form id="auth-form" method="post" action="\/auth\?next=%2Fread">/);
  assert.match(html, /<button class="btn" type="submit">进入阅读<\/button>/);
  assert.equal((html.match(/<span(?: class="active")?><\/span>/g) ?? []).length, 6);
  const handlers = new Map<string, (event: { isComposing?: boolean }) => void>();
  const filled = Array(6).fill(false);
  const pin = {
    value: "", selectionStart: 0,
    parentElement: { classList: { add() {} } },
    nextElementSibling: { children: filled.map((_, index) => ({ classList: { toggle: (name: string, value: boolean) => { if (name === "filled") filled[index] = value; } } })) },
    addEventListener: (name: string, handler: (event: { isComposing?: boolean }) => void) => handlers.set(name, handler),
  };
  let submissions = 0;
  const form = { submit: () => { submissions++; } };
  runInNewContext(script, { document: { getElementById: (id: string) => id === "pin" ? pin : form } });
  pin.value = "01234";
  handlers.get("input")?.({});
  assert.equal(submissions, 0);
  assert.deepEqual(filled, [true, true, true, true, true, false]);
  pin.value = "012345";
  handlers.get("input")?.({ isComposing: true });
  assert.equal(submissions, 0);
  handlers.get("compositionend")?.({});
  handlers.get("change")?.({});
  assert.equal(submissions, 1);
});

test("progress keeps the furthest position and rejects invalid or cross-origin writes", async t => {
  const sql = new DatabaseSync(":memory:");
  t.after(() => sql.close());
  sql.exec(readFileSync("migrations/0004_reading_progress.sql", "utf8"));
  const db = { prepare(query: string) { return { bind(...args: SQLInputValue[]) { return {
    async run() { return sql.prepare(query).run(...args); },
    async first() { return sql.prepare(query).get(...args) ?? null; },
  }; } }; } } as unknown as D1Database;
  const url = `${origin}/api/progress/${code}`;
  const get = () => readProgress(new Request(url), db, code);
  const post = (body: string, from = origin) => readProgress(new Request(url, { method: "POST", headers: { Origin: from, "Content-Type": "application/json" }, body }), db, code);
  assert.deepEqual(await (await get()).json(), { progress: null });
  assert.equal((await post('{"progress":0.4}', "https://evil.example")).status, 403);
  assert.equal((await post('{"progress":2}')).status, 400);
  assert.equal((await post(JSON.stringify({ progress: 0.4, extra: "x".repeat(1100) }))).status, 400);
  assert.equal((await post('{"progress":0.4}')).status, 204);
  assert.deepEqual(await (await get()).json(), { progress: 0.4 });
  assert.equal((await post('{"progress":0.2}')).status, 204);
  assert.deepEqual(await (await get()).json(), { progress: 0.4 });
  assert.equal((await post('{"progress":0.75}')).status, 204);
  assert.deepEqual(await (await get()).json(), { progress: 0.75 });
  assert.deepEqual(await (await readProgress(new Request(url), db, shareCode(43))).json(), { progress: null });
});

test("remote sync is offered only for a lead of at least 2% and 40px", () => {
  assert.equal(shouldOfferRemoteSync(0.2, null, 4000), false);
  assert.equal(shouldOfferRemoteSync(0.5, 0.51, 10000), false);
  assert.equal(shouldOfferRemoteSync(0.25, 0.5, 159), false);
  assert.equal(shouldOfferRemoteSync(0, 1, 0), false);
  assert.equal(shouldOfferRemoteSync(0.5, 0.5, 4000), false);
  assert.equal(shouldOfferRemoteSync(0.8, 0.5, 4000), false);
  assert.equal(shouldOfferRemoteSync(0.25, 0.5, 160), true);
  assert.equal(shouldOfferRemoteSync(0.1, 0.8, 4000), true);
});
