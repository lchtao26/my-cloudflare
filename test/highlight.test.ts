import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import worker, { shareCode } from "../src/index.ts";

const origin = "https://example.com",
  code = shareCode(42),
  pageId = "408e75a1-639c-8152-ab6f-f35a59ab2d27";
const url = `${origin}/read/highlight/${code}`;
const page = {
  id: pageId,
  url: `https://notion.so/${pageId}`,
  properties: {
    ID: { type: "unique_id", unique_id: { number: 42 } },
    标题: { type: "rich_text", rich_text: [{ plain_text: "测试" }] },
    原文语言: { type: "select", select: { name: "英文" } },
    正文翻译: { type: "rich_text", rich_text: [{ plain_text: "甲 重复乙<br>丙重复丁<script>" }] },
    正文: { type: "rich_text", rich_text: [{ plain_text: "Original text" }] },
    专有名词与术语: { type: "rich_text", rich_text: [{ plain_text: "API。释义。" }] },
  },
};
function database() {
  const sql = new DatabaseSync(":memory:");
  sql.exec(readFileSync("migrations/0001_highlights.sql", "utf8"));
  sql.exec(readFileSync("migrations/0002_highlight_terms.sql", "utf8"));
  sql.exec(readFileSync("migrations/0003_highlight_length.sql", "utf8"));
  const db = {
    prepare(query: string) {
      return {
        bind(...args: SQLInputValue[]) {
          return {
            async run() {
              const outcome = sql.prepare(query).run(...args);
              return { meta: { changes: Number(outcome.changes) } };
            },
            async first() {
              return sql.prepare(query).get(...args) ?? null;
            },
            async all() {
              return { results: sql.prepare(query).all(...args) };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
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

test("highlight writes reuse PIN and CSRF, validate text and expose private data through the article API", async t => {
  const { db, sql } = database();
  t.after(() => sql.close());
  const originalFetch = globalThis.fetch;
  let activePage = structuredClone(page);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("/data_sources/source/query")) return Response.json({ results: [activePage] });
    if (String(input).includes("/views/")) return Response.json({ data_source_id: "source" });
    throw new Error(`unexpected fetch ${input}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const env = { HIGHLIGHTS_DB: db, NOTION_TOKEN: "token", NOTION_EXCERPTS_DATA_SOURCE_ID: "source", NOTION_EXCERPTS_VIEW_ID: "view", FAVORITE_PIN: "012345", FAVORITE_SESSION_SECRET: "1234567890abcdef1234567890abcdef", FAVORITE_LOGIN_LIMIT: { getByName: () => ({ attempt: async () => true }) } };
  const get = await worker.fetch(new Request(url, { headers: { Accept: "application/json" } }), env);
  assert.equal(get.status, 200);
  const token = ((await get.json()) as { csrf: string }).csrf;
  const cookie = get.headers.get("set-cookie")!.split(";")[0]!;
  function post(changes: Record<string, string> = {}, requestOrigin = origin, session = "") {
    return worker.fetch(
      new Request(url, {
        method: "POST",
        headers: { Origin: requestOrigin, Cookie: [cookie, session].filter(Boolean).join("; "), Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf: token, field: "translation", start: "5", end: "7", quote: "重复", ...changes }),
      }),
      env,
    );
  }
  assert.equal((await post({}, "https://evil.example")).status, 403);
  assert.equal((await post({ csrf: "0".repeat(64) })).status, 403);
  assert.equal((await post({ pin: "012345", quote: " ".repeat(70000) })).status, 403);
  assert.equal((await post()).status, 401);
  assert.equal((await post({ pin: "999999" })).status, 401);
  assert.equal((await post({ pin: "012345", quote: "伪造" })).status, 409);
  assert.equal((await post({ pin: "012345", field: "invalid" })).status, 400);
  const saved = await post({ pin: "012345" });
  assert.equal(saved.status, 200);
  assert.match(saved.headers.get("set-cookie") || "", /__Host-read-session=/);
  const session = saved.headers.get("set-cookie")!.split(";")[0]!;
  const value = (await saved.json()) as { highlight: { id: string }; highlights: Array<{ id: string }> };
  assert.ok(value.highlight.id);
  assert.equal(value.highlights[0]?.id, value.highlight.id);
  const duplicate = await post({ pin: "012345" });
  assert.equal(((await duplicate.json()) as { highlight: { id: string } }).highlight.id, value.highlight.id);
  assert.equal((sql.prepare("SELECT count(*) AS n FROM highlights").get() as { n: number }).n, 1);
  const terms = await post({ field: "terms", start: "0", end: "4", quote: "API。", pin: "012345" }, origin, session);
  assert.equal(terms.status, 200, "the glossary can be highlighted");
  assert.equal((sql.prepare("SELECT field FROM highlights WHERE field='terms'").get() as { field: string }).field, "terms");
  const original = await post({ field: "original", start: "0", end: "8", quote: "Original" }, origin, session);
  assert.equal(original.status, 200);
  const injection = await post({ start: "8", end: "16", quote: "<script>" }, origin, session);
  assert.equal(injection.status, 200);
  const readApi = await worker.fetch(new Request(`${origin}/api/r/${code}`), env);
  const article = await readApi.json<import("../src/reader/data.ts").ReaderArticle>();
  assert.equal(readApi.headers.get("cache-control"), "no-store");
  assert.ok(article.body.some(paragraph => paragraph.quote.includes("<script>")));
  assert.ok(article.actions?.highlights.some(mark => mark.id === value.highlight.id));
  const shareApi = await worker.fetch(new Request(`${origin}/api/s/${code}`), env);
  const shared = await shareApi.json<import("../src/reader/data.ts").ReaderArticle>();
  assert.deepEqual(shared.body, article.body);
  assert.equal(shared.actions, null);
  assert.deepEqual(shared.original, []);
  assert.deepEqual(shared.terms, []);
  activePage.properties["正文翻译"].rich_text[0]!.plain_text = "甲 重复乙";
  const changedDetail = await worker.fetch(new Request(`${origin}/api/r/${code}`), env);
  const changedArticle = await changedDetail.json<import("../src/reader/data.ts").ReaderArticle>();
  assert.ok(!changedArticle.actions?.highlights.some(mark => mark.id === value.highlight.id));
  activePage.properties["正文翻译"].rich_text[0]!.plain_text = "## 标题\n\n这是 **重点** 和 [链接](https://example.com)。\n\n```\n第一行\n\n第二行\n```";
  const markdownResponse = await worker.fetch(new Request(`${origin}/api/r/${code}`), env);
  const markdownArticle = await markdownResponse.json<import("../src/reader/data.ts").ReaderArticle>();
  assert.equal(markdownArticle.body[0]!.quote, "标题");
  assert.equal(markdownArticle.body[1]!.quote, "这是 重点 和 链接。");
  assert.equal(markdownArticle.body[2]!.quote, "第一行\n\n第二行\n");
  const formatted = markdownArticle.body[1]!;
  const savedFormatted = await post({ start: String(formatted.start), end: String(formatted.end), quote: formatted.quote }, origin, session);
  assert.equal(savedFormatted.status, 200, "formatted paragraph uses rendered text for highlight offsets");
  const failedDb = {
    prepare() {
      throw new Error("D1 unavailable");
    },
  } as unknown as D1Database;
  // A database read failure must not take down the article.
  // The Promise chain below expects a prepared statement; use an asynchronous failure.
  const rejectedDb = {
    prepare() {
      return {
        bind() {
          return {
            all: async () => {
              throw new Error("D1 unavailable");
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  const oldError = console.error;
  console.error = () => {};
  try {
    for (const badDb of [failedDb, rejectedDb]) assert.equal((await worker.fetch(new Request(`${origin}/api/r/${code}`), { ...env, HIGHLIGHTS_DB: badDb })).status, 200);
  } finally {
    console.error = oldError;
  }
  assert.equal((await worker.fetch(new Request(url, { headers: { Accept: "application/json" } }), { ...env, HIGHLIGHTS_DB: undefined })).status, 503);
});

test("explanations require authentication, verify the selection, and send the selection through 302.AI", async t => {
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
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const env = { HIGHLIGHTS_DB: db, AI302_API_KEY: "test-key", NOTION_TOKEN: "token", NOTION_EXCERPTS_DATA_SOURCE_ID: "source", FAVORITE_PIN: "012345", FAVORITE_SESSION_SECRET: "1234567890abcdef1234567890abcdef", FAVORITE_LOGIN_LIMIT: { getByName: () => ({ attempt: async () => true }) } };
  const opened = await worker.fetch(new Request(url, { headers: { Accept: "application/json" } }), env);
  const { csrf } = (await opened.json()) as { csrf: string };
  const cookie = opened.headers.get("set-cookie")!.split(";")[0]!;
  function post(changes: Record<string, string> = {}, requestOrigin = origin, bindings = env, session = "") {
    return worker.fetch(
      new Request(url, {
        method: "POST",
        headers: { Origin: requestOrigin, Cookie: [cookie, session].filter(Boolean).join("; "), Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf, action: "explain", field: "translation", start: "5", end: "7", quote: "重复", ...changes }),
      }),
      bindings,
    );
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
  assert.equal(((await response.json()) as { explanation: string }).explanation, "这段话的意思。");
  assert.equal(requests[0]!.headers.get("authorization"), "Bearer test-key");
  assert.equal(requests[0]!.body.model, "gpt-6-luna");
  assert.deepEqual(requests[0]!.body.reasoning, { effort: "low" });
  assert.equal(requests[0]!.body.store, false);
  assert.equal(requests[0]!.body.instructions, undefined);
  assert.match(String(requests[0]!.body.input), /文章标题：测试\n\n解释一下：重复/);
  assert.doesNotMatch(String(requests[0]!.body.input), /文章上下文|原文地址|甲 重复乙/);
  const disjointRanges = [
    { start: 0, end: 1, quote: "甲" },
    { start: 5, end: 7, quote: "重复" },
  ];
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
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const env = { HIGHLIGHTS_DB: db, AI302_API_KEY: "test-key", NOTION_TOKEN: "token", NOTION_EXCERPTS_DATA_SOURCE_ID: "source", FAVORITE_PIN: "012345", FAVORITE_SESSION_SECRET: "1234567890abcdef1234567890abcdef", FAVORITE_LOGIN_LIMIT: { getByName: () => ({ attempt: async () => true }) } };
  const opened = await worker.fetch(new Request(url, { headers: { Accept: "application/json" } }), env);
  const { csrf } = (await opened.json()) as { csrf: string };
  const cookie = opened.headers.get("set-cookie")!.split(";")[0]!;
  const response = await worker.fetch(
    new Request(url, { method: "POST", headers: { Origin: origin, Cookie: cookie, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, pin: "012345", action: "original", field: "translation", start: "0", end: "1", quote: "甲" }) }),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { paragraph: string }).paragraph, "Original text");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.headers.get("authorization"), "Bearer test-key");
  assert.equal(requests[0]!.body.model, "jev-latest");
  assert.equal(JSON.parse(requests[0]!.body.state).selected_paragraph, "甲");
  assert.equal(requests[0]!.body.questions.match.type, "choice");
  assert.equal(requests[0]!.body.questions.match.criteria.p0, "Original text");
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
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const env = { HIGHLIGHTS_DB: db, NOTION_TOKEN: "token", NOTION_EXCERPTS_DATA_SOURCE_ID: "source", FAVORITE_PIN: "012345", FAVORITE_SESSION_SECRET: "1234567890abcdef1234567890abcdef", FAVORITE_LOGIN_LIMIT: { getByName: () => ({ attempt: async () => true }) } };
  const fixtureCode = shareCode(44);
  const endpoint = `${origin}/read/highlight/${fixtureCode}`;
  const opened = await worker.fetch(new Request(endpoint, { headers: { Accept: "application/json" } }), env);
  const cookie = opened.headers.get("set-cookie")!.split(";")[0]!;
  const { csrf } = (await opened.json()) as { csrf: string };
  const saved = await worker.fetch(
    new Request(endpoint, { method: "POST", headers: { Origin: origin, Cookie: cookie, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, pin: "012345", field: "translation", start: "6", end: "10", quote: "首次观点" }) }),
    env,
  );
  assert.equal(saved.status, 200);
  const { highlight } = (await saved.json()) as { highlight: { id: string } };
  const stored = sql.prepare("SELECT prefix, suffix, body_hash FROM highlights WHERE id = ?").get(highlight.id) as { prefix: string; suffix: string; body_hash: string };
  assert.equal(stored.prefix, "前文甲乙丙丁");
  assert.equal(stored.suffix, "戊己庚辛" + "隔".repeat(28));
  assert.equal(stored.body_hash, "78780698edc0c9f27429d1ca0377a7464793d85537fd67d8313f6899ce80f4b2");
  const readDetail = async () => (await worker.fetch(new Request(`${origin}/api/r/${fixtureCode}`), env)).json<import("../src/reader/data.ts").ReaderArticle>();
  assert.ok((await readDetail()).actions?.highlights.some(mark => mark.id === highlight.id));
  fixture.properties["正文翻译"].rich_text[0]!.plain_text = "隔".repeat(80) + unit + "后文";
  assert.ok(!(await readDetail()).actions?.highlights.some(mark => mark.id === highlight.id));
  const list = await (await worker.fetch(new Request(`${origin}/api/read?tab=highlights`), env)).json<import("../src/reader/data.ts").ReaderList>();
  assert.equal(list.kind, "highlights");
  if (list.kind === "highlights") assert.equal(list.items.find(item => item.id === highlight.id)?.located, false);
  fixture.properties["正文翻译"].rich_text[0]!.plain_text = original;
  assert.ok((await readDetail()).actions?.highlights.some(mark => mark.id === highlight.id));
});

test("deleting a highlight reuses PIN and CSRF and cannot cross articles", async t => {
  const { db, sql } = database();
  t.after(() => sql.close());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ results: [page] })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const env = { HIGHLIGHTS_DB: db, NOTION_TOKEN: "token", NOTION_EXCERPTS_DATA_SOURCE_ID: "source", FAVORITE_PIN: "012345", FAVORITE_SESSION_SECRET: "1234567890abcdef1234567890abcdef", FAVORITE_LOGIN_LIMIT: { getByName: () => ({ attempt: async () => true }) } };
  const opened = await worker.fetch(new Request(url, { headers: { Accept: "application/json" } }), env);
  const cookie = opened.headers.get("set-cookie")!.split(";")[0]!;
  const { csrf } = (await opened.json()) as { csrf: string };
  const saved = await worker.fetch(new Request(url, { method: "POST", headers: { Origin: origin, Cookie: cookie, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, pin: "012345", field: "translation", start: "5", end: "7", quote: "重复" }) }), env);
  assert.equal(saved.status, 200);
  const session = saved.headers.get("set-cookie")!.split(";")[0]!;
  const { highlight } = (await saved.json()) as { highlight: { id: string } };
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
  assert.equal(((await foreign.json()) as { deleted: boolean }).deleted, false);
  assert.equal((sql.prepare("SELECT count(*) AS n FROM highlights WHERE id=?").get(otherId) as { n: number }).n, 1);
  const removed = await remove(highlight.id, { pin: "012345" }, origin, "");
  assert.equal(removed.status, 200);
  assert.match(removed.headers.get("set-cookie") || "", /__Host-read-session=/);
  assert.equal(((await removed.json()) as { deleted: boolean }).deleted, true);
  assert.equal((sql.prepare("SELECT count(*) AS n FROM highlights WHERE id=?").get(highlight.id) as { n: number }).n, 0);
  const again = await remove(highlight.id);
  assert.equal(again.status, 200);
  assert.equal(((await again.json()) as { deleted: boolean }).deleted, false);
});

const sessionEnv = { NOTION_TOKEN: "token", NOTION_EXCERPTS_DATA_SOURCE_ID: "source", FAVORITE_PIN: "012345", FAVORITE_SESSION_SECRET: "1234567890abcdef1234567890abcdef", FAVORITE_LOGIN_LIMIT: { getByName: () => ({ attempt: async () => true }) } };
const disjointRanges = [
  { start: 0, end: 1, quote: "甲" },
  { start: 5, end: 7, quote: "重复" },
];

function seededRows(sql: DatabaseSync, count: number) {
  const insert = sql.prepare('INSERT INTO highlights (id,excerpt_number,excerpt_page_id,field,start,"end",quote,prefix,suffix,body_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  for (let index = 0; index < count; index++) insert.run(crypto.randomUUID(), 42, pageId, "translation", 10000 + index * 2, 10001 + index * 2, "字", "", "", "seed", "2026-01-01");
}

async function highlightSession(env: Parameters<typeof worker.fetch>[1]) {
  const opened = await worker.fetch(new Request(url, { headers: { Accept: "application/json" } }), env);
  const cookie = opened.headers.get("set-cookie")!.split(";")[0]!;
  const { csrf } = (await opened.json()) as { csrf: string };
  const verified = await worker.fetch(new Request(url, { method: "POST", headers: { Origin: origin, Cookie: cookie, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, action: "verify", pin: "012345" }) }), env);
  const session = verified.headers.get("set-cookie")!.split(";")[0]!;
  return { csrf, cookie: [cookie, session].filter(Boolean).join("; ") };
}

test("token selections save one row per range and reject ranges that touch", async t => {
  const { db, sql } = database();
  t.after(() => sql.close());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ results: [page] })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const env = { ...sessionEnv, HIGHLIGHTS_DB: db };
  const { csrf, cookie } = await highlightSession(env);
  function post(body: Record<string, string>) {
    return worker.fetch(new Request(url, { method: "POST", headers: { Origin: origin, Cookie: cookie, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, field: "translation", ...body }) }), env);
  }
  const saved = await post({ ranges: JSON.stringify(disjointRanges) });
  assert.equal(saved.status, 200);
  const first = (await saved.json()) as { highlights: Array<{ id: string }> };
  assert.equal(first.highlights.length, 2);
  assert.equal((sql.prepare("SELECT count(*) AS n FROM highlights").get() as { n: number }).n, 2);
  const again = await post({ ranges: JSON.stringify(disjointRanges) });
  assert.equal(again.status, 200);
  const second = (await again.json()) as { highlights: Array<{ id: string }> };
  assert.deepEqual(second.highlights.map(mark => mark.id).sort(), first.highlights.map(mark => mark.id).sort());
  assert.equal((sql.prepare("SELECT count(*) AS n FROM highlights").get() as { n: number }).n, 2);
  assert.equal(
    (
      await post({
        ranges: JSON.stringify([
          { start: 0, end: 1, quote: "甲" },
          { start: 1, end: 3, quote: "重复" },
        ]),
      })
    ).status,
    400,
  );
  assert.equal((await post({ ranges: JSON.stringify([...disjointRanges].reverse()) })).status, 400);
  sql.exec("DELETE FROM highlights");
  assert.equal((await post({ ranges: JSON.stringify([disjointRanges[0]!]) })).status, 200);
  seededRows(sql, 198);
  assert.equal((await post({ ranges: JSON.stringify(disjointRanges) })).status, 200);
  assert.equal((sql.prepare("SELECT count(*) AS n FROM highlights").get() as { n: number }).n, 200);
  sql.exec("DELETE FROM highlights");
  seededRows(sql, 199);
  assert.equal((await post({ ranges: JSON.stringify(disjointRanges) })).status, 429);
  assert.equal((sql.prepare("SELECT count(*) AS n FROM highlights").get() as { n: number }).n, 199);
});

test("a multi-range highlight larger than 16KB is still accepted", async t => {
  const { db, sql } = database();
  t.after(() => sql.close());
  const fixture = structuredClone(page);
  fixture.properties["正文翻译"].rich_text[0]!.plain_text = "字".repeat(400);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ results: [fixture] })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const env = { ...sessionEnv, HIGHLIGHTS_DB: db };
  const { csrf, cookie } = await highlightSession(env);
  const ranges = Array.from({ length: 150 }, (_, index) => ({ start: index * 2, end: index * 2 + 1, quote: `字${" ".repeat(100)}` }));
  const body = new URLSearchParams({ csrf, field: "translation", ranges: JSON.stringify(ranges) });
  assert.ok(body.toString().length > 16384);
  const saved = await worker.fetch(new Request(url, { method: "POST", headers: { Origin: origin, Cookie: cookie, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body }), env);
  assert.equal(saved.status, 200);
  assert.equal(((await saved.json()) as { highlights: unknown[] }).highlights.length, 150);
  assert.equal((sql.prepare("SELECT count(*) AS n FROM highlights").get() as { n: number }).n, 150);
});

test("saving an explanation writes one highlight per range before calling the model", async t => {
  const { db, sql } = database();
  t.after(() => sql.close());
  const requests: string[] = [];
  let fail = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/data_sources/source/query")) return Response.json({ results: [page] });
    if (String(input) === "https://api.302.ai/v1/responses") {
      requests.push(String(JSON.parse(String(init?.body)).input));
      if (fail) return new Response("no", { status: 500 });
      return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "这段话的意思。" }] }] });
    }
    throw new Error(`unexpected fetch ${input}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const env = { ...sessionEnv, HIGHLIGHTS_DB: db, AI302_API_KEY: "test-key" };
  const { csrf, cookie } = await highlightSession(env);
  function post(changes: Record<string, string> = {}) {
    return worker.fetch(
      new Request(url, { method: "POST", headers: { Origin: origin, Cookie: cookie, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, action: "explain", field: "translation", ranges: JSON.stringify(disjointRanges), save: "1", ...changes }) }),
      env,
    );
  }
  const oldError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = oldError;
  });
  fail = true;
  assert.equal((await post()).status, 502);
  assert.equal((sql.prepare("SELECT count(*) AS n FROM highlights").get() as { n: number }).n, 2);
  assert.equal(requests.length, 1);
  fail = false;
  const saved = await post();
  assert.equal(saved.status, 200);
  const value = (await saved.json()) as { explanation: string; highlights: unknown[] };
  assert.equal(value.explanation, "这段话的意思。");
  assert.equal(value.highlights.length, 2);
  assert.match(requests[1]!, /解释一下：甲\n重复/);
  assert.equal((sql.prepare("SELECT count(*) AS n FROM highlights").get() as { n: number }).n, 2);
  assert.equal(requests.length, 2);
  sql.exec("DELETE FROM highlights");
  seededRows(sql, 200);
  requests.length = 0;
  assert.equal((await post()).status, 429);
  assert.equal(requests.length, 0);
  assert.equal((sql.prepare("SELECT count(*) AS n FROM highlights").get() as { n: number }).n, 200);
});

test("original matching ignores a request to save highlights", async t => {
  const { db, sql } = database();
  t.after(() => sql.close());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("/data_sources/source/query")) return Response.json({ results: [page] });
    if (String(input) === "https://api.302.ai/typesafeai/v1/systemone") return Response.json({ answers: { match: { type: "choice", choice: "p0", confidence: 0.9 } } });
    throw new Error(`unexpected fetch ${input}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const env = { ...sessionEnv, HIGHLIGHTS_DB: db, AI302_API_KEY: "test-key" };
  const { csrf, cookie } = await highlightSession(env);
  const response = await worker.fetch(
    new Request(url, { method: "POST", headers: { Origin: origin, Cookie: cookie, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, action: "original", field: "translation", start: "0", end: "1", quote: "甲", save: "1" }) }),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal((sql.prepare("SELECT count(*) AS n FROM highlights").get() as { n: number }).n, 0);
});

test("aborting the client stops an explanation before the 60s upstream timeout", { timeout: 5_000 }, async t => {
  const { db, sql } = database();
  t.after(() => sql.close());
  const originalFetch = globalThis.fetch;
  let upstream: AbortSignal | undefined;
  let started = () => {};
  const upstreamStarted = new Promise<void>(resolve => {
    started = resolve;
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/data_sources/source/query")) return Response.json({ results: [page] });
    if (String(input) === "https://api.302.ai/v1/responses") {
      upstream = init?.signal ?? undefined;
      started();
      const signal = init?.signal;
      return new Promise((_resolve, reject) => {
        const giveUp = setTimeout(() => reject(new Error("upstream was not aborted")), 2_000);
        const fail = () => {
          clearTimeout(giveUp);
          const reason = signal?.reason;
          reject(reason instanceof Error ? reason : new DOMException("The operation was aborted.", "AbortError"));
        };
        if (!signal) {
          clearTimeout(giveUp);
          reject(new Error("explanation fetch has no abort signal"));
          return;
        }
        if (signal.aborted) fail();
        else signal.addEventListener("abort", fail, { once: true });
      });
    }
    throw new Error(`unexpected fetch ${input}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const env = { HIGHLIGHTS_DB: db, AI302_API_KEY: "test-key", NOTION_TOKEN: "token", NOTION_EXCERPTS_DATA_SOURCE_ID: "source", FAVORITE_PIN: "012345", FAVORITE_SESSION_SECRET: "1234567890abcdef1234567890abcdef", FAVORITE_LOGIN_LIMIT: { getByName: () => ({ attempt: async () => true }) } };
  const opened = await worker.fetch(new Request(url, { headers: { Accept: "application/json" } }), env);
  const { csrf } = (await opened.json()) as { csrf: string };
  const cookie = opened.headers.get("set-cookie")!.split(";")[0]!;
  const headers = { Origin: origin, Cookie: cookie, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" };
  const saved = await worker.fetch(new Request(url, { method: "POST", headers, body: new URLSearchParams({ csrf, pin: "012345", field: "translation", start: "5", end: "7", quote: "重复" }) }), env);
  assert.equal(saved.status, 200);
  const session = saved.headers.get("set-cookie")!.split(";")[0]!;
  assert.equal((sql.prepare("SELECT count(*) AS n FROM highlights").get() as { n: number }).n, 1);
  const controller = new AbortController();
  const pending = worker.fetch(new Request(url, { method: "POST", signal: controller.signal, headers: { ...headers, Cookie: [cookie, session].join("; ") }, body: new URLSearchParams({ csrf, action: "explain", field: "translation", start: "5", end: "7", quote: "重复" }) }), env);
  await upstreamStarted;
  assert.equal(upstream?.aborted, false);
  const began = Date.now();
  controller.abort();
  const response = await pending;
  assert.ok(Date.now() - began < 1_500, "aborted explanation waited for the upstream timeout");
  assert.equal(response.status, 499);
  assert.equal(upstream?.aborted, true);
  assert.equal((upstream?.reason as { name?: string } | undefined)?.name, "AbortError");
  assert.equal((sql.prepare("SELECT count(*) AS n FROM highlights").get() as { n: number }).n, 1);
});

test("explanation context is the current paragraph with its neighbors, or only the neighbors", async t => {
  const { db, sql } = database();
  t.after(() => sql.close());
  const article = structuredClone(page);
  article.properties["正文翻译"].rich_text[0]!.plain_text = "一段<br><br>二段<br><br>三段<br><br>四段<br><br>五段<br><br>六段<br><br>七段";
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/data_sources/source/query")) return Response.json({ results: [article] });
    if (String(input) === "https://api.302.ai/v1/responses") {
      requests.push(String(JSON.parse(String(init?.body)).input));
      return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "意思。" }] }] });
    }
    throw new Error(`unexpected fetch ${input}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const env = { ...sessionEnv, HIGHLIGHTS_DB: db, AI302_API_KEY: "test-key" };
  const { csrf, cookie } = await highlightSession(env);
  function post(body: Record<string, string>) {
    return worker.fetch(new Request(url, { method: "POST", headers: { Origin: origin, Cookie: cookie, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, action: "explain", field: "translation", ...body }) }), env);
  }
  const word = await post({ ranges: JSON.stringify([{ start: 6, end: 7, quote: "四" }]), save: "1", context: "paragraph" });
  assert.equal(word.status, 200);
  assert.equal(requests[0], "文章标题：测试\n上下文：\n三段\n\n四段\n\n五段\n\n解释一下：四");
  const firstWord = await post({ ranges: JSON.stringify([{ start: 0, end: 1, quote: "一" }]), context: "paragraph" });
  assert.equal(firstWord.status, 200);
  assert.equal(requests[1], "文章标题：测试\n上下文：\n一段\n\n二段\n\n解释一下：一");
  const lastWord = await post({ ranges: JSON.stringify([{ start: 12, end: 13, quote: "七" }]), context: "paragraph" });
  assert.equal(lastWord.status, 200);
  assert.equal(requests[2], "文章标题：测试\n上下文：\n六段\n\n七段\n\n解释一下：七");
  const paragraph = await post({ ranges: JSON.stringify([{ start: 6, end: 8, quote: "四段" }]), context: "around" });
  assert.equal(paragraph.status, 200);
  assert.equal(requests[3], "文章标题：测试\n上下文：\n三段\n\n五段\n\n解释一下：四段");
  const first = await post({ ranges: JSON.stringify([{ start: 0, end: 2, quote: "一段" }]), context: "around" });
  assert.equal(first.status, 200);
  assert.equal(requests[4], "文章标题：测试\n上下文：\n二段\n\n解释一下：一段");
  const last = await post({ ranges: JSON.stringify([{ start: 12, end: 14, quote: "七段" }]), context: "around" });
  assert.equal(last.status, 200);
  assert.equal(requests[5], "文章标题：测试\n上下文：\n六段\n\n解释一下：七段");
  assert.equal((sql.prepare("SELECT count(*) AS n FROM highlights").get() as { n: number }).n, 1);
});
