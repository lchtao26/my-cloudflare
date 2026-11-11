import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import worker, { excerptFromPage, renderEinkDetail, shareCode } from "../src/index.ts";

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
  assert.match(page.html, /input#pin\{box-sizing:border-box;display:block;[^}]*width:100%/);
  assert.doesNotMatch(page.html, /<h1>收藏<\/h1>/);
  const slots = page.html.match(/<div class="pin-slots" aria-hidden="true">([\s\S]*?)<\/div>/)?.[1];
  assert.equal((slots?.match(/<span/g) || []).length, 6);
  assert.doesNotMatch(page.html, /返回文章/);
  assert.match(page.response.headers.get("Content-Security-Policy") || "", new RegExp(`script-src 'nonce-${page.token}'`));
  assert.match(page.html, /tab=weekly&amp;page=2/);
  assert.equal((await worker.fetch(submit(page.csrf, page.token, "012345", "", "https://evil.example"), env)).status, 403);
  assert.equal((await worker.fetch(submit(page.csrf, "0".repeat(64), "012345"), env)).status, 403);
  const wrong = await worker.fetch(submit(page.csrf, page.token, "999999"), env);
  assert.equal(wrong.status, 401);
  assert.match(wrong.headers.get("Content-Security-Policy") || "", new RegExp(`script-src 'nonce-${page.token}'`));
  assert.match(await wrong.text(), /密码不正确/);
  assert.equal(calls.length, 0);

  const success = await worker.fetch(submit(page.csrf, page.token, "012345"), env);
  assert.equal(success.status, 200);
  const successHtml = await success.text();
  assert.match(successHtml, /已收藏/);
  assert.ok(successHtml.includes(`href="/r/${code}?tab=weekly&amp;page=2"`));
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

test("PIN input submits once after six digits, including pasted values", async () => {
  const page = await open(configuration());
  const script = page.html.match(/<script nonce="[a-f0-9]+">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const handlers = new Map<string, (event: { isComposing?: boolean }) => void>();
  const activeSlots = Array(6).fill(false);
  const filledSlots = Array(6).fill(false);
  const pin = {
    value: "", selectionStart: 0,
    parentElement: { classList: { add() {} } },
    nextElementSibling: { children: activeSlots.map((_, index) => ({ classList: { toggle: (name: string, active: boolean) => { (name === "active" ? activeSlots : filledSlots)[index] = active; } } })) },
    addEventListener: (name: string, handler: (event: { isComposing?: boolean }) => void) => handlers.set(name, handler),
  };
  let submissions = 0;
  const form = { submit: () => { submissions++; } };
  runInNewContext(script, { document: { getElementById: (id: string) => id === "pin" ? pin : form } });
  pin.value = "01234";
  pin.selectionStart = 5;
  handlers.get("input")?.({});
  assert.equal(activeSlots.indexOf(true), 5);
  assert.deepEqual(filledSlots, [true, true, true, true, true, false]);
  pin.value = "01";
  pin.selectionStart = 2;
  handlers.get("input")?.({});
  assert.deepEqual(filledSlots, [true, true, false, false, false, false]);
  pin.value = "012345";
  handlers.get("input")?.({ isComposing: true });
  assert.equal(submissions, 0);
  handlers.get("compositionend")?.({});
  handlers.get("change")?.({});
  assert.equal(submissions, 1);
});

test("login attempts are limited even across different client addresses", async () => {
  const env = configuration();
  const page = await open(env);
  for (let i = 0; i < 5; i++) assert.equal((await worker.fetch(submit(page.csrf, page.token, "999999"), env)).status, 401);
  assert.equal((await worker.fetch(submit(page.csrf, page.token, "012345"), env)).status, 429);
});

test("dialog API verifies PINs, reuses sessions and requires a new PIN after expiration", async (t) => {
  const env = configuration();
  const originalFetch = globalThis.fetch;
  let notionCalls = 0;
  const savedValues: boolean[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    notionCalls++;
    if (String(input).endsWith("/data_sources/source/query")) return Response.json({ results: [{
      id: pageId, url: `https://www.notion.so/${pageId}`,
      properties: { ID: { type: "unique_id", unique_id: { number: 42 } }, "正文翻译": { type: "rich_text", rich_text: [{ plain_text: "正文" }] } },
    }] });
    if (String(input).endsWith(`/pages/${pageId}`)) {
      savedValues.push(JSON.parse(String(init?.body)).properties["已收藏"].checkbox);
      return Response.json({ id: pageId });
    }
    throw new Error("unexpected Notion request");
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const get = (session = "") => worker.fetch(new Request(url, { headers: { Accept: "application/json", ...(session ? { Cookie: session } : {}) } }), env);
  const post = (csrf: string, token: string, pin?: string, session = "", favorite?: string) => {
    const request = submit(csrf, token, pin, session);
    request.headers.set("Accept", "application/json");
    if (favorite === undefined) return worker.fetch(request, env);
    const data = new URLSearchParams({ csrf: token, favorite });
    if (pin !== undefined) data.set("pin", pin);
    return worker.fetch(new Request(url, { method: "POST", headers: request.headers, body: data }), env);
  };
  const initial = await get();
  const csrf = initial.headers.get("set-cookie")!.split(";")[0]!;
  const initialData = await initial.json() as { authenticated: boolean; csrf: string };
  assert.equal(initialData.authenticated, false);
  assert.equal(initial.headers.get("cache-control"), "no-store");
  const forged = submit(csrf, initialData.csrf, "012345", "", "https://evil.example");
  forged.headers.set("Accept", "application/json");
  assert.equal((await worker.fetch(forged, env)).status, 403);
  assert.equal((await post(csrf, "0".repeat(64), "012345")).status, 403);
  const expired = await post(csrf, initialData.csrf);
  assert.equal(expired.status, 401);
  assert.deepEqual(await expired.json(), { requiresPin: true });
  const wrong = await post(csrf, initialData.csrf, "999999");
  assert.equal(wrong.status, 401);
  assert.deepEqual(await wrong.json(), { error: "密码不正确。", requiresPin: true });
  assert.equal(notionCalls, 0);
  const success = await post(csrf, initialData.csrf, "012345");
  assert.deepEqual(await success.json(), { ok: true, favorite: true });
  const session = success.headers.get("set-cookie")!.split(";")[0]!;
  assert.equal(notionCalls, 2);
  const returning = await get(session);
  const newCsrf = returning.headers.get("set-cookie")!.split(";")[0]!;
  const returningData = await returning.json() as { authenticated: boolean; csrf: string };
  assert.equal(returningData.authenticated, true);
  const saved = await post(newCsrf, returningData.csrf, undefined, session, "0");
  assert.deepEqual(await saved.json(), { ok: true, favorite: false });
  assert.deepEqual(savedValues, [true, false]);
  assert.equal(notionCalls, 4);
  const afterExpiry = await post(newCsrf, returningData.csrf);
  assert.equal(afterExpiry.status, 401);
  assert.deepEqual(await afterExpiry.json(), { requiresPin: true });
  assert.equal(notionCalls, 4);
  const removeWithPin = await post(newCsrf, returningData.csrf, "012345", "", "0");
  assert.deepEqual(await removeWithPin.json(), { ok: true, favorite: false });
  assert.deepEqual(savedValues, [true, false, false]);
  assert.equal(notionCalls, 6);
});

test("detail dialog retries an incorrect PIN and reuses a verified session", async () => {
  const html = renderEinkDetail({
    id: pageId, code, title: "标题", originalTitle: "", body: "正文", chinese: true,
    lang: "zh-CN", titleLang: "zh-CN", originalLang: "zh-CN", terms: "", sourceTitle: "",
    author: "", chapter: "", publisher: "", originalUrl: null, publishedDate: "", link: "https://notion.so/test", pubDate: null,
  }, "/read", "/read/p");
  const script = html.match(/<script>\s*\(function\(\)\{\s*var link=document\.getElementById\('favorite-link'\);[\s\S]*?<\/script>/)?.[0].replace(/^<script>|<\/script>$/g, "");
  assert.ok(script);
  type Handler = (event: { button?: number; isComposing?: boolean; preventDefault?: () => void }) => void;
  function element() {
    const handlers = new Map<string, Handler>();
    return { handlers, addEventListener(name: string, handler: Handler) { handlers.set(name, handler); } };
  }
  const attributes = new Map<string, string>();
  const link = { ...element(), href: url, dataset: { favorite: "false" },
    setAttribute(name: string, value: string) { attributes.set(name, value); },
    removeAttribute(name: string) { attributes.delete(name); },
  };
  const form = element();
  const slots = Array.from({ length: 6 }, () => ({ classList: { toggle() {} } }));
  const pin = { ...element(), value: "", disabled: false, selectionStart: 0, parentElement: { classList: { add() {} } }, nextElementSibling: { children: slots }, focus() {} };
  const dialog = { ...element(), open: false, showModal() { this.open = true; }, close() { this.open = false; this.handlers.get("close")?.({}); } };
  const status = { textContent: "收藏" };
  const error = { textContent: "" };
  const message = { textContent: "" };
  const nodes: Record<string, unknown> = { "favorite-link": link, "favorite-dialog": dialog, "favorite-form": form, pin, "favorite-error": error, "favorite-message": message, "favorite-status": status };
  const replies = [
    { authenticated: false, csrf: "token" },
    { error: "密码不正确。", requiresPin: true },
    { ok: true, favorite: true },
    { authenticated: true, csrf: "token2" },
    { ok: true, favorite: false },
    { error: "收藏暂不可用，请先完成配置。" },
  ];
  const requests: Array<{ method?: string; body?: string }> = [];
  const fetchMock = (_url: string, init: { method?: string; body?: string }) => {
    requests.push(init);
    const data = replies.shift();
    return Promise.resolve(Response.json(data, { status: data && "error" in data ? 401 : 200 }));
  };
  runInNewContext(script, { document: { getElementById: (id: string) => nodes[id] }, window: { fetch: fetchMock }, fetch: fetchMock, URLSearchParams, URL });
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const click = () => link.handlers.get("click")?.({ button: 0, preventDefault() {} });
  click();
  assert.equal(status.textContent, "收藏");
  assert.equal(attributes.get("aria-disabled"), "true");
  click();
  assert.equal(requests.length, 1);
  await tick();
  assert.equal(attributes.has("aria-disabled"), false);
  assert.equal(dialog.open, true);
  pin.value = "999999"; pin.selectionStart = 6; pin.handlers.get("input")?.({}); await tick();
  assert.equal(dialog.open, true);
  assert.equal(error.textContent, "密码不正确。");
  assert.equal(pin.value, "");
  pin.value = "012345"; pin.handlers.get("input")?.({}); await tick();
  assert.equal(dialog.open, false);
  assert.equal(status.textContent, "取消收藏");
  assert.equal(message.textContent, "");
  click();
  assert.equal(status.textContent, "取消收藏");
  assert.equal(attributes.get("aria-disabled"), "true");
  await tick();
  assert.equal(dialog.open, false);
  assert.equal(status.textContent, "收藏");
  assert.equal(attributes.has("aria-disabled"), false);
  assert.equal(message.textContent, "");
  click(); await tick();
  assert.equal(status.textContent, "收藏");
  assert.equal(message.textContent, "收藏暂不可用，请先完成配置。");
  assert.deepEqual(requests.map((request) => request.method || "GET"), ["GET", "POST", "POST", "GET", "POST", "GET"]);
  assert.equal(new URLSearchParams(requests[4]?.body).get("pin"), null);
  assert.equal(new URLSearchParams(requests[4]?.body).get("favorite"), "0");
});

test("already favorited Notion pages show an unfavorite action", () => {
  const excerpt = excerptFromPage({ id: pageId, url: `https://notion.so/${pageId}`, properties: {
    ID: { type: "unique_id", unique_id: { number: 42 } },
    "正文翻译": { type: "rich_text", rich_text: [{ plain_text: "正文" }] },
    "已收藏": { type: "checkbox", checkbox: true },
  } });
  assert.ok(excerpt);
  assert.equal(excerpt.favorite, true);
  const html = renderEinkDetail(excerpt, "/read", "/read/p");
  assert.match(html, /data-favorite="true" href="[^\"]*\?favorite=0"><span id="favorite-status" role="status">取消收藏<\/span>/);
});

test("favorite endpoints fail closed when security configuration is missing", async () => {
  const env = configuration();
  const response = await worker.fetch(new Request(url), { ...env, FAVORITE_LOGIN_LIMIT: undefined });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal((await worker.fetch(new Request(`${origin}/read/favorite/invalid`), env)).status, 404);
  assert.equal((await worker.fetch(new Request(url, { method: "DELETE" }), env)).status, 405);
});
