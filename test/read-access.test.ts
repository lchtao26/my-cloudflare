import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { favoriteRequest } from "../src/reader/favorite.ts";
import { shareCode } from "../src/index.ts";
import { protectRead, readLogin, readLogout, readSession } from "../src/reader/auth.ts";
import { readProgress } from "../src/reader/progress.ts";
import { shouldOfferRemoteSync } from "../src/reader/reading.ts";

const origin = "https://example.com";
const code = shareCode(42);
function environment() {
  let count = 0;
  return { FAVORITE_PIN: "012345", FAVORITE_SESSION_SECRET: "1234567890abcdef1234567890abcdef", FAVORITE_LOGIN_LIMIT: { getByName: () => ({ attempt: async () => ++count <= 5 }) } };
}

test("reading access requires the existing session and login rejects forged requests", async () => {
  const env = environment();
  for (const path of ["/read?tab=weekly", `/r/${code}`, "/api/read", `/api/r/${code}`, `/s/${code}`, `/api/s/${code}`]) {
    assert.equal(await protectRead(new Request(origin + path), env), null);
  }
  const progress = await protectRead(new Request(`${origin}/api/progress/${code}`), env);
  assert.ok(progress);
  assert.equal(progress.status, 401);
  assert.equal(progress.headers.get("Cache-Control"), "no-store");
  assert.equal((await readSession(new Request(`${origin}/api/session`), env)).headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await (await readSession(new Request(`${origin}/api/session`), env)).json(), { authenticated: false });
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
  assert.equal(await protectRead(new Request(`${origin}/api/progress/${code}`, { headers: { Cookie: session } }), env), null);
  assert.deepEqual(await (await readSession(new Request(`${origin}/api/session`, { headers: { Cookie: session } }), env)).json(), { authenticated: true });
  assert.ok(await protectRead(new Request(`${origin}/api/progress/${code}`, { headers: { Cookie: session } }), { ...env, FAVORITE_PIN: "654321" }));
  assert.deepEqual(await (await readSession(new Request(`${origin}/api/session`, { headers: { Cookie: session } }), { ...env, FAVORITE_PIN: "654321" })).json(), { authenticated: false });
  assert.equal((await readSession(new Request(`${origin}/api/session`, { method: "POST", headers: { Origin: origin, Cookie: session } }), env)).status, 405);
  const logout = readLogout(new Request(`${origin}/logout`, { headers: { Cookie: session, "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none" } }));
  assert.equal(logout.status, 303);
  assert.equal(logout.headers.get("Location"), "/read");
  assert.equal(logout.headers.get("Cache-Control"), "no-store");
  assert.match(logout.headers.get("Set-Cookie")!, /^__Host-read-session=;/);
  assert.match(logout.headers.get("Set-Cookie")!, /Max-Age=0/);
  assert.equal(readLogout(new Request(`${origin}/logout`, { headers: { Cookie: session, "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Site": "cross-site" } })).status, 403);
  assert.equal(readLogout(new Request(`${origin}/logout`, { headers: { Cookie: session, "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "cross-site" } })).status, 403);
  const directNoFetchMeta = readLogout(new Request(`${origin}/logout`, { headers: { Cookie: session } }));
  assert.equal(directNoFetchMeta.status, 303);
  assert.match(directNoFetchMeta.headers.get("Set-Cookie")!, /^__Host-read-session=;/);
  const sameOriginReferer = readLogout(new Request(`${origin}/logout`, { headers: { Cookie: session, Referer: `${origin}/read` } }));
  assert.equal(sameOriginReferer.status, 303);
  for (const header of [{ Referer: "https://evil.example/page" }, { Origin: "https://evil.example" }, { Origin: "null" }] as Array<Record<string, string>>) {
    const crossOrigin = readLogout(new Request(`${origin}/logout`, { headers: { Cookie: session, ...header } }));
    assert.equal(crossOrigin.status, 403);
    assert.equal(crossOrigin.headers.get("Set-Cookie"), null);
  }
  const prefetchHeaders: Array<Record<string, string>> = [{ "Sec-Purpose": "prefetch" }, { "Sec-Purpose": "prefetch;prerender", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none" }, { Purpose: "prefetch", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none" }];
  for (const header of prefetchHeaders) {
    const prefetched = readLogout(new Request(`${origin}/logout`, { headers: { Cookie: session, ...header } }));
    assert.equal(prefetched.status, 503);
    assert.equal(prefetched.headers.get("Cache-Control"), "no-store");
    assert.equal(prefetched.headers.get("Set-Cookie"), null);
  }
  assert.equal(readLogout(new Request(`${origin}/logout`, { method: "POST", headers: { Origin: origin, Cookie: session } })).status, 303);
  assert.equal(readLogout(new Request(`${origin}/logout`, { method: "POST", headers: { Origin: "https://evil.example", Cookie: session } })).status, 403);
  assert.equal(readLogout(new Request(`${origin}/logout`, { method: "DELETE", headers: { Cookie: session } })).status, 405);
  assert.deepEqual(await (await readSession(new Request(`${origin}/api/session`, { headers: { Cookie: logout.headers.get("Set-Cookie")!.split(";")[0]! } }), env)).json(), { authenticated: false });
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
  const action = await favoriteRequest(
    new Request(`${origin}/read/favorite/${code}`, { headers: { Cookie: browserCookie, Accept: "application/json" } }),
    env,
    code,
    async () => true,
    () => "",
  );
  browserCookie = action.headers.get("set-cookie")!.split(";")[0]!;
  assert.equal((await action.json<{ csrf: string }>()).csrf, token);
  const submit = (pin: string, cookie = browserCookie) =>
    readLogin(
      new Request(loginUrl, {
        method: "POST",
        headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf: token, pin }),
      }),
      env,
    );
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
    value: "",
    selectionStart: 0,
    parentElement: { classList: { add() {} } },
    nextElementSibling: {
      children: filled.map((_, index) => ({
        classList: {
          toggle: (name: string, value: boolean) => {
            if (name === "filled") filled[index] = value;
          },
        },
      })),
    },
    addEventListener: (name: string, handler: (event: { isComposing?: boolean }) => void) => handlers.set(name, handler),
  };
  let submissions = 0;
  const form = {
    submit: () => {
      submissions++;
    },
  };
  runInNewContext(script, { document: { getElementById: (id: string) => (id === "pin" ? pin : form) } });
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
  const db = {
    prepare(query: string) {
      return {
        bind(...args: SQLInputValue[]) {
          return {
            async run() {
              return sql.prepare(query).run(...args);
            },
            async first() {
              return sql.prepare(query).get(...args) ?? null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
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
