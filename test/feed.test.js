import assert from "node:assert/strict";
import test from "node:test";
import worker, { bookFromPage, renderFeed } from "../src/index.js";

const page = {
  id: "book-1",
  url: "https://www.notion.so/book-1",
  last_edited_time: "2026-10-13T10:00:00.000Z",
  properties: {
    "书名": { type: "title", title: [{ plain_text: "甲 & 乙" }] },
    "简介": { type: "rich_text", rich_text: [{ plain_text: "一部 <书>" }] },
    "作者": { type: "rich_text", rich_text: [{ plain_text: "张三" }] },
    "豆瓣 / 亚马逊": { type: "url", url: "https://book.douban.com/subject/123/?a=1&b=2" },
    "出版社 / 品牌": { type: "rich_text", rich_text: [{ plain_text: "不应出现的出版社" }] },
  },
};

test("RSS item has exactly the requested fields and escapes XML", () => {
  const book = bookFromPage(page);
  const feed = renderFeed([book], "https://example.workers.dev/book-express-rss");
  assert.match(feed, /<link>https:\/\/book\.douban\.com\/subject\/123\/\?a=1&amp;b=2<\/link>/);
  assert.match(feed, /<title>甲 &amp; 乙<\/title>/);
  assert.match(feed, /<description>书名：甲 &amp; 乙\n作者：张三\n简介：一部 &lt;书&gt;<\/description>/);
  assert.match(feed, /<guid isPermaLink="false">notion:book-1<\/guid>/);
  assert.doesNotMatch(feed, /不应出现的出版社|<category>/);
});

test("missing or invalid external links fall back to the Notion page", () => {
  for (const value of [null, "javascript:alert(1)", "not a URL"]) {
    const book = bookFromPage({ ...page, properties: { ...page.properties, "豆瓣 / 亚马逊": { type: "url", url: value } } });
    assert.equal(book.link, page.url);
  }
  assert.equal(bookFromPage({ ...page, url: null, properties: { ...page.properties, "豆瓣 / 亚马逊": { type: "url", url: null } } }), null);
  assert.equal(bookFromPage({ ...page, properties: { ...page.properties, "书名": { type: "title", title: [] } } }), null);
});

test("worker fetches all Notion pages and exposes only the feed path", async (context) => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return Response.json(requests.length === 1
      ? { results: [page], has_more: true, next_cursor: "next" }
      : { results: [{ ...page, id: "book-2" }], has_more: false, next_cursor: null });
  };
  context.after(() => { globalThis.fetch = originalFetch; });

  const env = { NOTION_TOKEN: "test", NOTION_DATA_SOURCE_ID: "source" };
  const missing = await worker.fetch(new Request("https://example.workers.dev/"), env);
  assert.equal(missing.status, 404);
  const response = await worker.fetch(new Request("https://example.workers.dev/book-express-rss"), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type"), /application\/rss\+xml/);
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=300");
  assert.equal((await response.text()).match(/<item>/g)?.length, 2);
  assert.deepEqual(requests[0].sorts, [{ timestamp: "last_edited_time", direction: "descending" }]);
  assert.equal(requests[1].start_cursor, "next");

  const head = await worker.fetch(new Request("https://example.workers.dev/book-express-rss", { method: "HEAD" }), env);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const method = await worker.fetch(new Request("https://example.workers.dev/book-express-rss", { method: "POST" }), env);
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("Allow"), "GET, HEAD");
});

test("missing configuration and Notion failures return explicit errors", async (context) => {
  const request = new Request("https://example.workers.dev/book-express-rss");
  assert.equal((await worker.fetch(request, {})).status, 503);

  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  globalThis.fetch = async () => Response.json({ message: "rate limited" }, { status: 429 });
  console.error = () => {};
  context.after(() => {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  });

  const response = await worker.fetch(request, { NOTION_TOKEN: "test", NOTION_DATA_SOURCE_ID: "source" });
  assert.equal(response.status, 502);
  assert.equal(await response.text(), "Feed temporarily unavailable");
});
