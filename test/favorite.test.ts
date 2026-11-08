import assert from "node:assert/strict";
import test from "node:test";
import worker, { shareCode } from "../src/index.ts";

const origin = "https://example.com";
const code = shareCode(42);
const url = `${origin}/read/favorite/${code}?tab=weekly&page=2`;
const pageId = "408e75a1-639c-8152-ab6f-f35a59ab2d27";
const csrfName = "__Host-read-csrf";
const sessionName = "__Host-read-session";

function configuration() {
  let attempts = 0;
  return {
    NOTION_TOKEN: "test-token",
    NOTION_EXCERPTS_DATA_SOURCE_ID: "source",
    FAVORITE_PIN: "012345",
    FAVORITE_SESSION_SECRET: "1234567890abcdef1234567890abcdef1234567890abcdef",
    FAVORITE_LOGIN_LIMIT: { getByName: () => ({ attempt: async () => ++attempts <= 5 }) },
  };
}

async function open(env: ReturnType<typeof configuration>, session = "") {
  const response = await worker.fetch(new Request(url, { headers: session ? { Cookie: session } : {} }), env);
  const html = await response.text();
  const csrf = response.headers.get("set-cookie")!.split(";")[0]!;
  const token = html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
  assert.ok(token);
  return { response, html, csrf, token };
}

function submit(csrf: string, token: string, pin?: string, session = "", requestOrigin = origin) {
  const data = new URLSearchParams({ csrf: token });
  if (pin !== undefined) data.set("pin", pin);
  return new Request(url, {
    method: "POST",
    headers: { Origin: requestOrigin, Cookie: [csrf, session].filter(Boolean).join("; "), "Content-Type": "application/x-www-form-urlencoded" },
    body: data,
  });
}

test("favorites require a valid PIN and CSRF token, then reuse a secure session", async (t) => {
  const env = configuration();
  const oldFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (String(input).endsWith("/data_sources/source/query")) {
      return Response.json({ results: [{
        id: pageId,
        url: `https://www.notion.so/${pageId}`,
        properties: { ID: { type: "unique_id", unique_id: { number: 42 } }, "正文翻译": { type: "rich_text", rich_text: [{ plain_text: "正文" }] } },
      }] });
    }
    if (String(input).endsWith(`/pages/${pageId}`)) return Response.json({ id: pageId });
    throw new Error("unexpected Notion request");
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = oldFetch; });

  const page = await open(env);
  assert.equal(page.response.headers.get("Cache-Control"), "no-store");
  assert.match(page.csrf, new RegExp(`^${csrfName}=`));
  assert.match(page.html, /type="password" inputmode="numeric" autocomplete="current-password"/);
  assert.match(page.html, /tab=weekly&amp;page=2/);
  assert.equal((await worker.fetch(submit(page.csrf, page.token, "012345", "", "https://evil.example"), env)).status, 403);
  assert.equal((await worker.fetch(submit(page.csrf, "0".repeat(64), "012345"), env)).status, 403);
  assert.equal((await worker.fetch(submit(page.csrf, page.token, "999999"), env)).status, 401);
  assert.equal(calls.length, 0);

  const success = await worker.fetch(submit(page.csrf, page.token, "012345"), env);
  assert.equal(success.status, 200);
  assert.match(await success.text(), /已收藏/);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.init?.method, "PATCH");
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), { properties: { "已收藏": { checkbox: true } } });
  const sessionHeader = success.headers.get("set-cookie")!;
  assert.match(sessionHeader, /Secure; HttpOnly; SameSite=Strict/);
  const session = sessionHeader.split(";")[0]!;
  assert.ok(session.startsWith(`${sessionName}=`));

  const again = await open(env, session);
  assert.match(again.html, /正在收藏/);
  assert.match(again.response.headers.get("Content-Security-Policy") || "", /script-src 'nonce-/);
  assert.equal((await worker.fetch(submit(again.csrf, again.token, undefined, session), env)).status, 200);
  assert.equal(calls.length, 4);
  const rotated = await open({ ...env, FAVORITE_PIN: "654321" }, session);
  assert.match(rotated.html, /请输入 6 位密码/);
  const forged = await open(env, `${sessionName}=9999999999.${"0".repeat(64)}`);
  assert.match(forged.html, /请输入 6 位密码/);
});

test("login attempts are limited even across different client addresses", async () => {
  const env = configuration();
  const page = await open(env);
  for (let i = 0; i < 5; i++) assert.equal((await worker.fetch(submit(page.csrf, page.token, "999999"), env)).status, 401);
  assert.equal((await worker.fetch(submit(page.csrf, page.token, "012345"), env)).status, 429);
});

test("favorite endpoints fail closed when security configuration is missing", async () => {
  const env = configuration();
  const response = await worker.fetch(new Request(url), { ...env, FAVORITE_LOGIN_LIMIT: undefined });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal((await worker.fetch(new Request(`${origin}/read/favorite/invalid`), env)).status, 404);
  assert.equal((await worker.fetch(new Request(url, { method: "DELETE" }), env)).status, 405);
});
