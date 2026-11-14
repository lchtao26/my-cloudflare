import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { Script, runInNewContext } from "node:vm";
import worker, { excerptFromPage, renderEinkDetail, shareCode } from "../src/index.ts";

const origin = "https://example.com", code = shareCode(42), pageId = "408e75a1-639c-8152-ab6f-f35a59ab2d27";
const url = `${origin}/read/highlight/${code}`;
const page = {
  id: pageId, url: `https://notion.so/${pageId}`,
  properties: { ID: { type: "unique_id", unique_id: { number: 42 } },
    "标题": { type: "rich_text", rich_text: [{ plain_text: "测试" }] },
    "原文语言": { type: "select", select: { name: "英文" } },
    "正文翻译": { type: "rich_text", rich_text: [{ plain_text: "甲 重复乙<br>丙重复丁<script>" }] },
    "正文": { type: "rich_text", rich_text: [{ plain_text: "Original text" }] },
    "专有名词与术语": { type: "rich_text", rich_text: [{ plain_text: "API。释义。" }] } },
};
function database() {
  const sql = new DatabaseSync(":memory:");
  sql.exec(readFileSync("migrations/0001_highlights.sql", "utf8"));
  sql.exec(readFileSync("migrations/0002_highlight_terms.sql", "utf8"));
  sql.exec(readFileSync("migrations/0003_highlight_length.sql", "utf8"));
  const db = { prepare(query: string) { return { bind(...args: SQLInputValue[]) { return {
    async run() { const outcome = sql.prepare(query).run(...args); return { meta: { changes: Number(outcome.changes) } }; },
    async first() { return sql.prepare(query).get(...args) ?? null; },
    async all() { return { results: sql.prepare(query).all(...args) }; },
  }; } }; } } as unknown as D1Database;
  return { db, sql };
}

test("the paragraph length migration keeps existing highlights and accepts longer paragraphs", t => {
  const sql = new DatabaseSync(":memory:");
  t.after(() => sql.close());
  sql.exec(readFileSync("migrations/0001_highlights.sql", "utf8"));
  sql.exec(readFileSync("migrations/0002_highlight_terms.sql", "utf8"));
  const insert = "INSERT INTO highlights (id,excerpt_number,excerpt_page_id,field,start,\"end\",quote,prefix,suffix,body_hash,created_at) VALUES (?,1,'page','translation',0,?,?,'','','hash','now')";
  sql.prepare(insert).run("old", 2, "原文");
  sql.exec(readFileSync("migrations/0003_highlight_length.sql", "utf8"));
  sql.prepare(insert).run("long", 1000, "字".repeat(1000));
  assert.equal((sql.prepare("SELECT count(*) AS count FROM highlights").get() as { count: number }).count, 2);
});

test("highlight writes reuse PIN and CSRF, validate rendered text and render only on detail pages", async t => {
  const { db, sql } = database();
  t.after(() => sql.close());
  const originalFetch = globalThis.fetch;
  let activePage = structuredClone(page);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("/data_sources/source/query")) return Response.json({ results: [activePage] });
    if (String(input).includes("/views/")) return Response.json({ data_source_id: "source" });
    throw new Error(`unexpected fetch ${input}`);
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const env = { HIGHLIGHTS_DB: db, NOTION_TOKEN: "token", NOTION_EXCERPTS_DATA_SOURCE_ID: "source", NOTION_EXCERPTS_VIEW_ID: "view", FAVORITE_PIN: "012345", FAVORITE_SESSION_SECRET: "1234567890abcdef1234567890abcdef", FAVORITE_LOGIN_LIMIT: { getByName: () => ({ attempt: async () => true }) } };
  const get = await worker.fetch(new Request(url, { headers: { Accept: "application/json" } }), env);
  assert.equal(get.status, 200);
  const token = (await get.json() as { csrf: string }).csrf;
  const cookie = get.headers.get("set-cookie")!.split(";")[0]!;
  function post(changes: Record<string, string> = {}, requestOrigin = origin, session = "") {
    return worker.fetch(new Request(url, { method: "POST", headers: { Origin: requestOrigin, Cookie: [cookie, session].filter(Boolean).join("; "), Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf: token, field: "translation", start: "5", end: "7", quote: "重复", ...changes }) }), env);
  }
  assert.equal((await post({}, "https://evil.example")).status, 403);
  assert.equal((await post({ csrf: "0".repeat(64) })).status, 403);
  assert.equal((await post({ pin: "012345", quote: " ".repeat(17000) })).status, 403);
  assert.equal((await post()).status, 401);
  assert.equal((await post({ pin: "999999" })).status, 401);
  assert.equal((await post({ pin: "012345", quote: "伪造" })).status, 409);
  assert.equal((await post({ pin: "012345", field: "invalid" })).status, 400);
  const saved = await post({ pin: "012345" });
  assert.equal(saved.status, 200);
  assert.match(saved.headers.get("set-cookie") || "", /__Host-read-session=/);
  const session = saved.headers.get("set-cookie")!.split(";")[0]!;
  const value = await saved.json() as { highlight: { id: string } };
  assert.ok(value.highlight.id);
  const duplicate = await post({ pin: "012345" });
  assert.equal((await duplicate.json() as { highlight: { id: string } }).highlight.id, value.highlight.id);
  assert.equal((sql.prepare("SELECT count(*) AS n FROM highlights").get() as { n: number }).n, 1);
  const terms = await post({ field: "terms", start: "0", end: "4", quote: "API。", pin: "012345" }, origin, session);
  assert.equal(terms.status, 200, "the glossary can be highlighted");
  assert.equal((sql.prepare("SELECT field FROM highlights WHERE field='terms'").get() as { field: string }).field, "terms");
  const original = await post({ field: "original", start: "0", end: "8", quote: "Original" }, origin, session);
  assert.equal(original.status, 200);
  const injection = await post({ start: "8", end: "16", quote: "<script>" }, origin, session);
  assert.equal(injection.status, 200);
  const detail = await worker.fetch(new Request(`${origin}/r/${code}`), env);
  const detailHtml = await detail.text();
  assert.match(detailHtml, new RegExp(value.highlight.id));
  assert.doesNotMatch(detailHtml, /id="highlight-bar"|id="highlight-save"|selectionchange/);
  assert.match(detailHtml, /id="highlight-error"/);
  assert.match(detailHtml, /id="body-unhighlight">取消划线/);
  for (const script of detailHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(script[1]!);
  assert.equal(detail.headers.get("cache-control"), "no-store");
  const share = await worker.fetch(new Request(`${origin}/s/${code}`), env);
  const shareHtml = await share.text();
  assert.doesNotMatch(shareHtml, /id="highlight-bar"/);
  assert.doesNotMatch(shareHtml, /id="highlight-error"/);
  assert.doesNotMatch(shareHtml, /id="body-unhighlight"/);
  assert.doesNotMatch(shareHtml, new RegExp(value.highlight.id));
  const list = await worker.fetch(new Request(`${origin}/read?tab=highlights`), env);
  assert.equal(list.headers.get("cache-control"), "no-store");
  const listHtml = await list.text();
  assert.match(listHtml, new RegExp(`/r/${code}\\?tab=highlights#hl-${value.highlight.id}`));
  assert.match(listHtml, /&lt;script&gt;/);
  activePage.properties["正文翻译"].rich_text[0]!.plain_text = "甲 重复乙";
  const changed = await worker.fetch(new Request(`${origin}/read?tab=highlights`), env);
  assert.match(await changed.text(), /正文已变动，未能定位/);
  const changedDetail = await worker.fetch(new Request(`${origin}/r/${code}`), env);
  assert.doesNotMatch(await changedDetail.text(), new RegExp(value.highlight.id));
  const failedDb = { prepare() { throw new Error("D1 unavailable"); } } as unknown as D1Database;
  // A database read failure must not take down the article.
  // The Promise chain below expects a prepared statement; use an asynchronous failure.
  const rejectedDb = { prepare() { return { bind() { return { all: async () => { throw new Error("D1 unavailable"); } }; } }; } } as unknown as D1Database;
  const oldError = console.error; console.error = () => {};
  try { for (const badDb of [failedDb, rejectedDb]) assert.equal((await worker.fetch(new Request(`${origin}/r/${code}`), { ...env, HIGHLIGHTS_DB: badDb })).status, 200); } finally { console.error = oldError; }
  assert.equal((await worker.fetch(new Request(url, { headers: { Accept: "application/json" } }), { ...env, HIGHLIGHTS_DB: undefined })).status, 503);
});

test("explanations require authentication, verify the selection, and send article context through 302.AI", async t => {
  const { db, sql } = database();
  t.after(() => sql.close());
  const originalFetch = globalThis.fetch;
  const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/data_sources/source/query")) return Response.json({ results: [page] });
    if (String(input) === "https://api.302.ai/v1/responses") {
      requests.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "这段话的意思。" }] }] });
    }
    throw new Error(`unexpected fetch ${input}`);
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const env = { HIGHLIGHTS_DB: db, AI302_API_KEY: "test-key", NOTION_TOKEN: "token", NOTION_EXCERPTS_DATA_SOURCE_ID: "source", FAVORITE_PIN: "012345", FAVORITE_SESSION_SECRET: "1234567890abcdef1234567890abcdef", FAVORITE_LOGIN_LIMIT: { getByName: () => ({ attempt: async () => true }) } };
  const opened = await worker.fetch(new Request(url, { headers: { Accept: "application/json" } }), env);
  const { csrf } = await opened.json() as { csrf: string };
  const cookie = opened.headers.get("set-cookie")!.split(";")[0]!;
  function post(changes: Record<string, string> = {}, requestOrigin = origin, bindings = env, session = "") {
    return worker.fetch(new Request(url, { method: "POST", headers: { Origin: requestOrigin, Cookie: [cookie, session].filter(Boolean).join("; "), Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, action: "explain", field: "translation", start: "5", end: "7", quote: "重复", ...changes }) }), bindings);
  }
  assert.equal((await post()).status, 401);
  assert.equal((await post({ pin: "012345" }, "https://evil.example")).status, 403);
  assert.equal((await post({ pin: "012345", quote: "伪造" })).status, 409);
  const unconfigured = await post({ pin: "012345" }, origin, { ...env, AI302_API_KEY: "" });
  assert.equal(unconfigured.status, 503);
  assert.equal(requests.length, 0);
  assert.equal((await post({ action: "verify", pin: "999999" })).status, 401);
  const verification = await post({ action: "verify", pin: "012345" });
  assert.equal(verification.status, 200);
  const session = verification.headers.get("set-cookie")!.split(";")[0]!;
  assert.equal(requests.length, 0, "PIN verification does not start an explanation");
  const response = await post({}, origin, env, session);
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { explanation: string }).explanation, "这段话的意思。");
  assert.equal(requests[0]!.headers.get("authorization"), "Bearer test-key");
  assert.equal(requests[0]!.body.model, "gpt-6-luna");
  assert.equal(requests[0]!.body.store, false);
  assert.equal(requests[0]!.body.instructions, undefined);
  assert.match(String(requests[0]!.body.input), /甲 重复乙/);
  assert.match(String(requests[0]!.body.input), /解释一下：重复/);
  const disjointRanges = [{ start: 0, end: 1, quote: "甲" }, { start: 5, end: 7, quote: "重复" }];
  const disjoint = await post({ pin: "012345", ranges: JSON.stringify(disjointRanges) });
  assert.equal(disjoint.status, 200);
  assert.match(String(requests[1]!.body.input), /解释一下：甲\n重复/);
  assert.equal((await post({ pin: "012345", ranges: JSON.stringify([{ start: 0, end: 1, quote: "伪" }]) })).status, 409);
  assert.equal((await post({ pin: "012345", ranges: JSON.stringify(disjointRanges.reverse()) })).status, 400);
  assert.equal(requests.length, 2);
  assert.equal((sql.prepare("SELECT count(*) AS n FROM highlights").get() as { n: number }).n, 0);
});

test("original paragraph matching uses the 302.AI System One API", async t => {
  const { db, sql } = database();
  t.after(() => sql.close());
  const originalFetch = globalThis.fetch;
  const requests: Array<{ headers: Headers; body: any }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/data_sources/source/query")) return Response.json({ results: [page] });
    if (String(input) === "https://api.302.ai/typesafeai/v1/systemone") {
      requests.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return Response.json({ answers: { match: { type: "choice", choice: "p0", confidence: 0.9 } } });
    }
    throw new Error(`unexpected fetch ${input}`);
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const env = { HIGHLIGHTS_DB: db, AI302_API_KEY: "test-key", NOTION_TOKEN: "token", NOTION_EXCERPTS_DATA_SOURCE_ID: "source", FAVORITE_PIN: "012345", FAVORITE_SESSION_SECRET: "1234567890abcdef1234567890abcdef", FAVORITE_LOGIN_LIMIT: { getByName: () => ({ attempt: async () => true }) } };
  const opened = await worker.fetch(new Request(url, { headers: { Accept: "application/json" } }), env);
  const { csrf } = await opened.json() as { csrf: string };
  const cookie = opened.headers.get("set-cookie")!.split(";")[0]!;
  const response = await worker.fetch(new Request(url, { method: "POST", headers: { Origin: origin, Cookie: cookie, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, pin: "012345", action: "original", field: "translation", start: "0", end: "1", quote: "甲" }) }), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { paragraph: string }).paragraph, "Original text");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.headers.get("authorization"), "Bearer test-key");
  assert.equal(requests[0]!.body.model, "jev-latest");
  assert.equal(JSON.parse(requests[0]!.body.state).selected_paragraph, "甲");
  assert.equal(requests[0]!.body.questions.match.type, "choice");
  assert.equal(requests[0]!.body.questions.match.criteria.p0, "Original text");
});

test("highlight article navigation returns to an existing unique list anchor", async t => {
  const { db, sql } = database();
  t.after(() => sql.close());
  const second = structuredClone(page);
  second.id = "408e75a1-639c-8152-ab6f-f35a59ab2d28";
  second.url = `https://notion.so/${second.id}`;
  second.properties.ID.unique_id.number = 43;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).includes("/data_sources/source/query")) throw new Error(`unexpected fetch ${input}`);
    const query = JSON.parse(String(init?.body)) as { filter: { unique_id?: { equals: number } } };
    const all = [page, second];
    return Response.json({ results: query.filter.unique_id ? all.filter(item => item.properties.ID.unique_id.number === query.filter.unique_id!.equals) : all });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const insert = sql.prepare('INSERT INTO highlights (id, excerpt_number, excerpt_page_id, field, start, "end", quote, prefix, suffix, body_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  // Orphans are still list items and must also provide a return target.
  insert.run("a", 42, page.id, "translation", 0, 1, "不存在", "", "", "old", "2026-01-03");
  insert.run("b", 43, second.id, "translation", 0, 1, "不存在", "", "", "old", "2026-01-02");
  insert.run("c", 43, second.id, "original", 1, 2, "不存在", "", "", "old", "2026-01-01");
  const env = { HIGHLIGHTS_DB: db, NOTION_TOKEN: "token", NOTION_EXCERPTS_DATA_SOURCE_ID: "source" };
  const firstDetail = await worker.fetch(new Request(`${origin}/r/${code}?tab=highlights`), env);
  const firstHtml = await firstDetail.text();
  const nextCode = shareCode(43);
  assert.match(firstHtml, new RegExp(`/r/${nextCode}\\?tab=highlights`));
  const nextDetail = await worker.fetch(new Request(`${origin}/r/${nextCode}?tab=highlights`), env);
  const nextHtml = await nextDetail.text();
  assert.match(nextHtml, new RegExp(`/read\\?tab=highlights#${nextCode}`));
  const list = await worker.fetch(new Request(`${origin}/read?tab=highlights`), env);
  const listHtml = await list.text();
  assert.equal((listHtml.match(new RegExp(`id="${nextCode}"`, "g")) || []).length, 1);
  assert.match(listHtml, new RegExp(`<li id="hl-b"><span id="${nextCode}"></span>`));
});

test("saved marks paint each layer and removal unwraps only the chosen highlight", async t => {
  const { db, sql } = database();
  t.after(() => sql.close());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ results: [page] })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const { hashText } = await import("../src/highlight-anchor.ts");
  const text = "甲重复乙丙重复丁<script>";
  const insert = sql.prepare('INSERT INTO highlights (id, excerpt_number, excerpt_page_id, field, start, "end", quote, prefix, suffix, body_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const hash = await hashText(text);
  insert.run("aabb", 42, pageId, "translation", 1, 3, "重复", "甲", "乙丙重复丁<script>", hash, "2026-01-01");
  insert.run("bbcc", 42, pageId, "translation", 2, 5, "复乙丙", "甲重", "重复丁<script>", hash, "2026-01-02");
  const env = { HIGHLIGHTS_DB: db, NOTION_TOKEN: "token", NOTION_EXCERPTS_DATA_SOURCE_ID: "source" };
  const response = await worker.fetch(new Request(`${origin}/r/${code}`), env);
  const html = await response.text();
  const script = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g), match => match[1]!).find(value => value.includes("var rows="))!;

  class FakeNode {
    nodeType: number;
    nodeValue: string;
    className = "";
    id = "";
    parentNode: FakeNode | null = null;
    children: FakeNode[] = [];
    attributes = new Map<string, string>();
    constructor(nodeType: number, nodeValue = "") { this.nodeType = nodeType; this.nodeValue = nodeValue; }
    get firstChild(): FakeNode | null { return this.children[0] || null; }
    get nextSibling(): FakeNode | null { if (!this.parentNode) return null; return this.parentNode.children[this.parentNode.children.indexOf(this) + 1] || null; }
    insertBefore(child: FakeNode, reference: FakeNode) { if (child.parentNode) child.parentNode.children.splice(child.parentNode.children.indexOf(child), 1); child.parentNode = this; this.children.splice(this.children.indexOf(reference), 0, child); }
    appendChild(child: FakeNode) { if (child.parentNode) child.parentNode.children.splice(child.parentNode.children.indexOf(child), 1); child.parentNode = this; this.children.push(child); }
    removeChild(child: FakeNode) { const index = this.children.indexOf(child); if (index >= 0) this.children.splice(index, 1); child.parentNode = null; return child; }
    setAttribute(key: string, value: string) { this.attributes.set(key, value); }
    getAttribute(key: string) { return this.attributes.get(key) ?? null; }
    normalize() { for (let index = 0; index < this.children.length - 1; index++) { const child = this.children[index]!, next = this.children[index + 1]!; if (child.nodeType === 3 && next.nodeType === 3) { child.nodeValue += next.nodeValue; this.children.splice(index + 1, 1); next.parentNode = null; index--; } } }
    splitText(offset: number) { const rest = new FakeNode(3, this.nodeValue.slice(offset)); this.nodeValue = this.nodeValue.slice(0, offset); const parent = this.parentNode!; rest.parentNode = parent; parent.children.splice(parent.children.indexOf(this) + 1, 0, rest); return rest; }
  }
  const body = new FakeNode(1); body.className = "excerpt-body";
  body.appendChild(new FakeNode(3, "甲重复乙丙重复丁<script>"));
  function findId(node: FakeNode, id: string): FakeNode | null {
    if (node.id === id) return node;
    for (const child of node.children) { const found = findId(child, id); if (found) return found; }
    return null;
  }
  function walk(node: FakeNode, visit: (node: FakeNode) => void) { visit(node); for (const child of node.children) walk(child, visit); }
  function nodeText(node: FakeNode): string { return node.nodeType === 3 ? node.nodeValue : node.children.map(nodeText).join(""); }
  const stubs = new Map<string, { hidden: boolean; disabled: boolean; textContent: string; addEventListener: () => void }>();
  function stub() { return { hidden: false, disabled: false, textContent: "", addEventListener() {} }; }
  const chrome = ["favorite-dialog"];
  const replaced: string[] = [];
  const document = {
    getElementById: (id: string) => findId(body, id) || (chrome.includes(id) ? stubs.get(id) || stubs.set(id, stub()).get(id)! : null),
    querySelector: (selector: string) => selector === '.excerpt-body[data-field="translation"]' ? body : null,
    querySelectorAll: (selector: string) => {
      const id = selector.match(/^mark\.hl\[data-hl="([0-9a-z-]+)"\]$/i)?.[1];
      const found: FakeNode[] = [];
      if (id) walk(body, node => { if (node.className === "hl" && node.getAttribute("data-hl") === id) found.push(node); });
      return found;
    },
    createElement: (_tag: string) => new FakeNode(1),
  };
  const fakeFetch = async (_url: string, init?: { body?: string }) => init?.body ? Response.json({ deleted: true }) : Response.json({ authenticated: true, csrf: "token" });
  const location = { hash: "#hl-aabb", pathname: "/r/test", search: "" };
  const window = { addEventListener() {}, fetch: fakeFetch, history: { replaceState(_state: null, _title: string, url: string) { replaced.push(url); location.hash = ""; } }, removeHighlight: undefined as undefined | ((id: string) => Promise<void>) };
  runInNewContext(script, { document, window, fetch: fakeFetch, URLSearchParams, location, setTimeout: (fn: () => void) => { fn(); return 0; }, history: window.history });
  const marks = () => { const found: FakeNode[] = []; walk(body, node => { if (node.className === "hl") found.push(node); }); return found; };
  const outer = marks().find(node => node.getAttribute("data-hl") === "aabb");
  assert.ok(outer);
  assert.equal(nodeText(outer), "重复");
  assert.ok(marks().some(node => node.getAttribute("data-hl") === "bbcc"));
  assert.ok(findId(body, "hl-aabb"));
  await window.removeHighlight!("aabb");
  assert.equal(marks().some(node => node.getAttribute("data-hl") === "aabb"), false);
  assert.ok(marks().some(node => node.getAttribute("data-hl") === "bbcc"), "removing the outer highlight keeps the inner one");
  assert.equal(nodeText(body), text);
  assert.equal(findId(body, "hl-aabb"), null);
  assert.deepEqual(replaced, ["/r/test"]);
  await window.removeHighlight!("bbcc");
  assert.equal(marks().length, 0);
  assert.equal(findId(body, "hl-bbcc"), null);
  assert.equal(nodeText(body), text);
});

test("distant duplicate deletion leaves the saved highlight orphaned until the body is restored", async t => {
  const { db, sql } = database();
  t.after(() => sql.close());
  const unit = "甲乙丙丁首次观点戊己庚辛";
  const original = "前文" + unit + "隔".repeat(80) + unit + "后文";
  const fixture = structuredClone(page);
  fixture.properties.ID.unique_id.number = 44;
  fixture.properties["正文翻译"].rich_text[0]!.plain_text = original;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ results: [fixture] })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const env = { HIGHLIGHTS_DB: db, NOTION_TOKEN: "token", NOTION_EXCERPTS_DATA_SOURCE_ID: "source", FAVORITE_PIN: "012345", FAVORITE_SESSION_SECRET: "1234567890abcdef1234567890abcdef", FAVORITE_LOGIN_LIMIT: { getByName: () => ({ attempt: async () => true }) } };
  const fixtureCode = shareCode(44);
  const endpoint = `${origin}/read/highlight/${fixtureCode}`;
  const opened = await worker.fetch(new Request(endpoint, { headers: { Accept: "application/json" } }), env);
  const cookie = opened.headers.get("set-cookie")!.split(";")[0]!;
  const { csrf } = await opened.json() as { csrf: string };
  const saved = await worker.fetch(new Request(endpoint, { method: "POST", headers: { Origin: origin, Cookie: cookie, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, pin: "012345", field: "translation", start: "6", end: "10", quote: "首次观点" }) }), env);
  assert.equal(saved.status, 200);
  const { highlight } = await saved.json() as { highlight: { id: string } };
  const stored = sql.prepare("SELECT prefix, suffix, body_hash FROM highlights WHERE id = ?").get(highlight.id) as { prefix: string; suffix: string; body_hash: string };
  assert.equal(stored.prefix, "前文甲乙丙丁");
  assert.equal(stored.suffix, "戊己庚辛" + "隔".repeat(28));
  assert.equal(stored.body_hash, "78780698edc0c9f27429d1ca0377a7464793d85537fd67d8313f6899ce80f4b2");
  const readDetail = async () => (await worker.fetch(new Request(`${origin}/r/${fixtureCode}`), env)).text();
  assert.ok((await readDetail()).includes(highlight.id));
  fixture.properties["正文翻译"].rich_text[0]!.plain_text = "隔".repeat(80) + unit + "后文";
  assert.ok(!(await readDetail()).includes(highlight.id));
  const list = await (await worker.fetch(new Request(`${origin}/read?tab=highlights`), env)).text();
  const row = list.match(new RegExp(`<li id="hl-${highlight.id}">[\\s\\S]*?<\\/li>`))?.[0];
  assert.ok(row);
  assert.match(row, /正文已变动，未能定位/);
  assert.doesNotMatch(row, /class="item-link"/);
  fixture.properties["正文翻译"].rich_text[0]!.plain_text = original;
  assert.ok((await readDetail()).includes(highlight.id));
});

test("paragraph actions send the entire paragraph and keep PIN and service errors independent", async t => {
  const { db, sql } = database();
  t.after(() => sql.close());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ results: [page] })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const html = await (await worker.fetch(new Request(`${origin}/r/${code}`), { HIGHLIGHTS_DB: db, NOTION_TOKEN: "token", NOTION_EXCERPTS_DATA_SOURCE_ID: "source" })).text();
  const script = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g), m => m[1]!).find(s => s.includes("var rows="))!;
  class Element {
    nodeType = 1; nodeValue = ""; parentNode: Element | null = null; children: Element[] = [];
    handlers = new Map<string, (event: any) => void>(); attributes = new Map<string, string>();
    hidden = false; open = false; disabled = false; className = ""; value = ""; private content = "";
    tagName: string;
    constructor(tagName = "DIV") { this.tagName = tagName; }
    get firstChild() { return this.children[0] || null; }
    get nextSibling(): Element | null { if (!this.parentNode) return null; const a = this.parentNode.children; return a[a.indexOf(this) + 1] || null; }
    get textContent(): string { return this.content; }
    set textContent(value: string) { this.content = value; this.children = []; }
    appendChild(child: Element) { if (child.parentNode) child.parentNode.children.splice(child.parentNode.children.indexOf(child), 1); child.parentNode = this; this.children.push(child); }
    insertBefore(child: Element, reference: Element | null) { if (child.parentNode) child.parentNode.children.splice(child.parentNode.children.indexOf(child), 1); child.parentNode = this; const i = reference ? this.children.indexOf(reference) : -1; if (i < 0) this.children.push(child); else this.children.splice(i, 0, child); }
    contains(child: Element): boolean { for (let n: Element | null = child; n; n = n.parentNode) if (n === this) return true; return false; }
    setAttribute(key: string, value: string) { this.attributes.set(key, value); }
    getAttribute(key: string) { return this.attributes.get(key) ?? null; }
    hasAttribute(key: string) { return this.attributes.has(key); }
    removeAttribute(key: string) { this.attributes.delete(key); }
    addEventListener(name: string, fn: (event: any) => void) { this.handlers.set(name, fn); }
    focus() {}
    close() { this.open = false; this.removeAttribute("open"); this.handlers.get("close")?.({ target: this }); }
    click() { this.handlers.get("click")?.({ target: this, preventDefault() {} }); }
  }
  function textNode(value: string) { const n = new Element(); n.nodeType = 3; n.nodeValue = value; return n; }
  const body = new Element(), before = new Element("P"), paragraph = new Element("P");
  body.setAttribute("data-field", "translation"); body.appendChild(before); before.appendChild(textNode("甲 重复\n")); body.appendChild(paragraph); paragraph.appendChild(textNode("乙。重复😀。丁"));
  const elements = new Map<string, Element>();
  for (const id of ["favorite-dialog", "favorite-form", "pin", "favorite-error", "highlight-error", "highlight-error-message", "highlight-error-retry", "highlight-error-close", "highlight-picker", "highlight-picker-close", "highlight-picker-edit", "highlight-characters", "highlight-picker-save", "highlight-picker-message", "highlight-preview", "body-highlight", "body-explain", "explanation-dialog", "explanation-text", "original-match-dialog", "original-match-text", "original-match-current"]) elements.set(id, new Element());
  elements.get("highlight-picker-save")!.textContent = "确认";
  const documentHandlers = new Map<string, (event: any) => void>();
  const pickerHome = new Element(); pickerHome.appendChild(elements.get("highlight-picker")!); elements.get("highlight-picker")!.hidden = true;
  const document = {
    getElementById: (id: string) => elements.get(id) || null,
    querySelector: () => null, querySelectorAll: () => [body], addEventListener(name: string, handler: (event: any) => void) { documentHandlers.set(name, handler); },
    createElement: (tag: string) => new Element(tag.toUpperCase()), createTextNode: textNode,
  };
  const requests: string[] = [];
  let explanationFailure = 0;
  let pendingReply: Promise<Response> | null = null;
  let pinFailure = false;
  const explanationStarts: Array<{ pinOpen: boolean; pinMessage: string; explanationMessage: string }> = [];
  const fakeFetch = async (_url: string, init?: { body?: string }) => {
    if (init?.body) { const action = new URLSearchParams(init.body).get("action"); if (action === "verify") return pinFailure ? Response.json({ error: "密码不正确。" }, { status: 401 }) : Response.json({ verified: true }); requests.push(init.body); if (action === "explain") explanationStarts.push({ pinOpen: elements.get("favorite-dialog")!.open, pinMessage: elements.get("favorite-error")!.textContent, explanationMessage: elements.get("explanation-text")!.textContent }); if (pendingReply && (action === "explain" || action === "original")) return pendingReply; return action === "explain" ? explanationFailure ? Response.json({ error: "解释服务暂不可用。" }, { status: explanationFailure }) : Response.json({ explanation: "解释结果", markdown: [{ type: "element", tag: "p", children: [{ type: "element", tag: "strong", children: [{ type: "text", text: "解释结果" }] }] }] }) : Response.json({ error: "正文已更新" }, { status: 409 }); }
    return Response.json({ authenticated: false, csrf: "token" });
  };
  let pinError = "";
  const window = { fetch: fakeFetch, promptForReadPin: (resume: (value: string) => Promise<unknown>) => { elements.get("favorite-dialog")!.open = true; void resume("012345").catch(error => { pinError = error.message; }); }, addEventListener() {}, performParagraphAction: undefined as undefined | ((p: Element, b: Element, mode?: string) => void) };
  runInNewContext(script, { document, window, fetch: fakeFetch, URLSearchParams, location: { hash: "" }, setTimeout });
  assert.equal(elements.get("body-highlight")!.hidden, false);
  window.performParagraphAction!(paragraph, body, "explain");
  await new Promise(resolve => setTimeout(resolve, 0));
  const explainRequest = new URLSearchParams(requests.shift());
  assert.equal(explainRequest.get("action"), "explain");
  assert.equal(explainRequest.has("pin"), false);
  assert.deepEqual(explanationStarts[0], { pinOpen: false, pinMessage: "", explanationMessage: "正在解释…" });
  assert.deepEqual(JSON.parse(explainRequest.get("ranges")!), [{ start: 3, end: 11, quote: "乙。重复😀。丁" }]);
  assert.equal(elements.get("explanation-text")!.children[0]!.children[0]!.tagName, "STRONG");
  elements.get("explanation-dialog")!.close();
  explanationFailure = 502;
  window.performParagraphAction!(paragraph, body, "explain");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(elements.get("favorite-dialog")!.open, false);
  assert.equal(elements.get("explanation-text")!.textContent, "解释服务暂不可用。");
  elements.get("explanation-dialog")!.close();
  explanationFailure = 0; pinFailure = true;
  window.performParagraphAction!(paragraph, body, "explain");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(elements.get("favorite-dialog")!.open, true);
  assert.equal(pinError, "密码不正确。");
  elements.get("favorite-dialog")!.close(); pinFailure = false; requests.length = 0;
  for (const [mode, id, reply] of [["explain", "explanation-dialog", { explanation: "迟到的解释" }], ["original", "original-match-dialog", { paragraph: "迟到的原文" }]] as const) {
    let resolveReply!: (value: Response) => void;
    pendingReply = new Promise<Response>(resolve => { resolveReply = resolve; });
    window.performParagraphAction!(paragraph, body, mode);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(elements.get(id)!.hidden, false);
    elements.get(id)!.close();
    resolveReply(Response.json(reply));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(elements.get(id)!.hidden, true, "a late response does not reopen a dismissed dialog");
    pendingReply = null;
  }
  requests.length = 0;
  window.performParagraphAction!(paragraph, body, "highlight");
  await new Promise(resolve => setTimeout(resolve, 0));
  const sent = new URLSearchParams(requests[0]);
  assert.equal(sent.get("field"), "translation");
  assert.equal(sent.get("start"), "3");
  assert.equal(sent.get("end"), "11");
  assert.equal(sent.get("quote"), "乙。重复😀。丁");
  assert.equal(elements.get("favorite-dialog")!.open, false);
  assert.equal(elements.get("highlight-error-message")!.textContent, "正文已更新");
  elements.get("highlight-error-close")!.click();
  paragraph.children[0]!.nodeValue = "甲".repeat(1501);
  window.performParagraphAction!(paragraph, body, "explain");
  assert.equal(elements.get("explanation-text")!.textContent, "解释最多 1500 字。");

});

test("jumping to an original highlight synchronizes the whole-body toggle", () => {
  const html = renderEinkDetail(excerptFromPage(page)!, "/read", "/read/p", undefined, "all", 1, true, [], true);
  const script = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g), m => m[1]!).find(s => s.includes("var rows="))!;
  const id = "11111111-1111-4111-8111-111111111111";
  const original = { className: "excerpt-body", hidden: true };
  const translation = { hidden: false };
  const target = { parentNode: original, scrollIntoView() {} };
  let syncCalls = 0;
  const document = { getElementById: (name: string) => name === `hl-${id}` ? target : null, querySelector: (selector: string) => selector === ".excerpt-body:not([hidden])" ? translation : null };
  const window = { addEventListener() {}, syncBodyViewToggle() { syncCalls++; } };
  runInNewContext(script, { document, window, location: { hash: `#hl-${id}` } });
  assert.equal(original.hidden, false);
  assert.equal(translation.hidden, true);
  assert.equal(syncCalls, 1);
});

test("result dialogs dismiss on the backdrop without dismissing content or swipes", async t => {
  const { db, sql } = database();
  t.after(() => sql.close());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ results: [page] })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const html = await (await worker.fetch(new Request(`${origin}/r/${code}`), { HIGHLIGHTS_DB: db, NOTION_TOKEN: "token", NOTION_EXCERPTS_DATA_SOURCE_ID: "source" })).text();
  assert.match(html, /id="explanation-dialog"[^>]*closedby="any"/);
  assert.match(html, /id="original-match-dialog"[^>]*closedby="any"/);
  assert.doesNotMatch(html, /id="(?:explanation|original-match)-close"/);
  const script = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g), m => m[1]!).find(s => s.includes("var rows="))!;
  const handlers = new Map<string, Array<(event: any) => void>>();
  const content = {};
  function panel() { return { hidden: true, open: false, getBoundingClientRect: () => ({ left: 300, right: 700, top: 100, bottom: 500 }), contains: (target: unknown) => target === content, addEventListener() {}, close() { this.open = false; } }; }
  const explanation = panel(), original = panel();
  const nodes: Record<string, unknown> = { "explanation-dialog": explanation, "explanation-text": content, "original-match-dialog": original, "favorite-dialog": { open: false } };
  const document = { getElementById: (id: string) => nodes[id] || null, querySelector: () => null, addEventListener: (name: string, fn: (event: any) => void) => handlers.set(name, [...handlers.get(name) || [], fn]) };
  let now = 1000, selected = false;
  const window = { fetch: async () => Response.json({}), addEventListener() {}, getSelection: () => ({ rangeCount: selected ? 1 : 0, isCollapsed: !selected }) };
  runInNewContext(script, { document, window, fetch: window.fetch, URLSearchParams, location: { hash: "" }, Date: { now: () => now }, setTimeout });
  const fire = (name: string, event: any) => { for (const handler of handlers.get(name) || []) { handler(event); if (event.stopped) break; } };
  const event = (target: unknown, x: number, y: number) => ({ target, clientX: x, clientY: y, button: 0, cancelable: true, stopped: false, preventDefault() {}, stopImmediatePropagation() { this.stopped = true; }, stopPropagation() { this.stopped = true; } });
  const click = (target: unknown, x: number, y: number) => { fire("pointerdown", event(target, x, y)); fire("click", event(target, x, y)); };
  for (const dialog of [explanation, original]) {
    for (const [x, y] of [[100, 200], [900, 200], [500, 50], [500, 550]]) {
      dialog.hidden = false; dialog.open = true;
      click(dialog, x!, y!);
      assert.equal(dialog.hidden, true, "each side of the backdrop closes the dialog");
    }
    dialog.hidden = false; dialog.open = true;
    click(dialog, 500, 200); click(content, 500, 200);
    assert.equal(dialog.hidden, false, "dialog content and padding do not dismiss");
    fire("pointerdown", event(content, 500, 200)); fire("click", event(dialog, 900, 200));
    assert.equal(dialog.hidden, false, "a drag from the content to the backdrop does not dismiss");
    selected = true; click(dialog, 900, 200); selected = false;
    assert.equal(dialog.hidden, false, "a text selection does not dismiss");
    const point = { clientX: 900, clientY: 200 };
    fire("touchstart", { target: dialog, touches: [point] });
    fire("touchmove", { touches: [{ clientX: 900, clientY: 240 }] });
    fire("touchend", { target: dialog, touches: [], changedTouches: [{ clientX: 900, clientY: 240 }], cancelable: true, preventDefault() {}, stopPropagation() {} });
    assert.equal(dialog.hidden, false, "a swipe on the backdrop does not dismiss");
    now += 1000;
    fire("touchstart", { target: dialog, touches: [point] });
    let prevented = false;
    fire("touchend", { target: dialog, touches: [], changedTouches: [point], cancelable: true, preventDefault() { prevented = true; }, stopPropagation() {} });
    assert.equal(dialog.hidden, true, "a tap on the backdrop dismisses");
    assert.equal(prevented, true);
    now += 1000;
  }
});

test("deleting a highlight reuses PIN and CSRF and cannot cross articles", async t => {
  const { db, sql } = database();
  t.after(() => sql.close());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ results: [page] })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const env = { HIGHLIGHTS_DB: db, NOTION_TOKEN: "token", NOTION_EXCERPTS_DATA_SOURCE_ID: "source", FAVORITE_PIN: "012345", FAVORITE_SESSION_SECRET: "1234567890abcdef1234567890abcdef", FAVORITE_LOGIN_LIMIT: { getByName: () => ({ attempt: async () => true }) } };
  const opened = await worker.fetch(new Request(url, { headers: { Accept: "application/json" } }), env);
  const cookie = opened.headers.get("set-cookie")!.split(";")[0]!;
  const { csrf } = await opened.json() as { csrf: string };
  const saved = await worker.fetch(new Request(url, { method: "POST", headers: { Origin: origin, Cookie: cookie, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, pin: "012345", field: "translation", start: "5", end: "7", quote: "重复" }) }), env);
  assert.equal(saved.status, 200);
  const session = saved.headers.get("set-cookie")!.split(";")[0]!;
  const { highlight } = await saved.json() as { highlight: { id: string } };
  const otherId = "22222222-2222-4222-8222-222222222222";
  sql.prepare('INSERT INTO highlights (id, excerpt_number, excerpt_page_id, field, start, "end", quote, prefix, suffix, body_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(otherId, 43, pageId, "translation", 0, 1, "甲", "", "", "hash", "2026-01-01");
  function remove(id: string, changes: Record<string, string> = {}, requestOrigin = origin, cookieHeader = session) {
    return worker.fetch(new Request(url, { method: "POST", headers: { Origin: requestOrigin, Cookie: [cookie, cookieHeader].filter(Boolean).join("; "), Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, action: "delete", id, ...changes }) }), env);
  }
  assert.equal((await remove(highlight.id, {}, "https://evil.example", "")).status, 403);
  assert.equal((await remove(highlight.id, { csrf: "0".repeat(64) }, origin, "")).status, 403);
  assert.equal((await remove(highlight.id, {}, origin, "")).status, 401);
  assert.equal((await remove(highlight.id, { pin: "999999" }, origin, "")).status, 401);
  assert.equal((await remove("not-a-uuid")).status, 400);
  const foreign = await remove(otherId);
  assert.equal(foreign.status, 200);
  assert.equal((await foreign.json() as { deleted: boolean }).deleted, false);
  assert.equal((sql.prepare("SELECT count(*) AS n FROM highlights WHERE id=?").get(otherId) as { n: number }).n, 1);
  const removed = await remove(highlight.id, { pin: "012345" }, origin, "");
  assert.equal(removed.status, 200);
  assert.match(removed.headers.get("set-cookie") || "", /__Host-read-session=/);
  assert.equal((await removed.json() as { deleted: boolean }).deleted, true);
  assert.equal((sql.prepare("SELECT count(*) AS n FROM highlights WHERE id=?").get(highlight.id) as { n: number }).n, 0);
  const again = await remove(highlight.id);
  assert.equal(again.status, 200);
  assert.equal((await again.json() as { deleted: boolean }).deleted, false);
  const detail = await (await worker.fetch(new Request(`${origin}/r/${code}`), env)).text();
  assert.doesNotMatch(detail, new RegExp(highlight.id));
  assert.match(detail, /id="body-unhighlight">取消划线/);
});
