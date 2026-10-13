import assert from "node:assert/strict";
import test from "node:test";
import worker, { bookFromPage, renderFeed, type NotionPage } from "../src/index.ts";

const page: NotionPage = {
  id: "book-1",
  url: "https://www.notion.so/book-1",
  last_edited_time: "2026-10-13T10:00:00.000Z",
  properties: {
    "书名": { type: "title", title: [{ plain_text: "甲 & 乙" }] },
    "简介": { type: "rich_text", rich_text: [{ plain_text: "一部 <书>" }] },
    "作者": { type: "rich_text", rich_text: [{ plain_text: "张三" }] },
    "豆瓣 / 亚马逊": { type: "url", url: "https://book.douban.com/subject/123/?a=1&b=2" },
    "封面": { type: "files", files: [{ name: "cover.jpg", type: "file", file: { url: "https://files.example/cover.jpg?X-Amz-Signature=abc" } }] },
    "出版社 / 品牌": { type: "rich_text", rich_text: [{ plain_text: "不应出现的出版社" }] },
  },
};

test("RSS item has exactly the requested fields and escapes XML", () => {
  const book = bookFromPage(page);
  assert.ok(book);
  const feed = renderFeed([book], "https://example.workers.dev/book-express-rss");
  assert.match(feed, /<link>\s*<!\[CDATA\[https:\/\/book\.douban\.com\/subject\/123\/\?a=1&b=2\]\]>/);
  assert.match(feed, /<title>\s*<!\[CDATA\[甲 & 乙\]\]>/);
  assert.match(feed, /<!\[CDATA\[书名：甲 &amp; 乙<br \/>\n作者：张三<br \/>\n简介：一部 &lt;书&gt;<br \/>\n<img src="https:\/\/example\.workers\.dev\/book-express-rss\/cover\/book-1" alt="封面" width="120" style="max-width:120px;height:auto" \/>\]\]>/);
  assert.match(feed, /<guid isPermaLink="false">notion:book-1<\/guid>/);
  assert.match(feed, /<atom:link href="https:\/\/example\.workers\.dev\/book-express-rss" rel="self" type="application\/rss\+xml"\/>/);
  assert.match(feed, /<language>zh-CN<\/language>/);
  assert.doesNotMatch(feed, /不应出现的出版社|<category>|files\.example|来源：/);
  const withoutCover = bookFromPage({ ...page, properties: { ...page.properties, "封面": { type: "files", files: [] } } });
  assert.equal(withoutCover?.hasCover, false);
  assert.doesNotMatch(renderFeed(withoutCover ? [withoutCover] : [], "https://example.workers.dev/book-express-rss"), /<img /);
});

test("source name links to the recommendation URL", () => {
  const sourced = bookFromPage({
    ...page,
    properties: {
      ...page.properties,
      "来源": { type: "select", select: { name: "新京报 & 周刊" } },
      "推荐来源": { type: "url", url: "https://example.com/review?a=1&b=2" },
    },
  });
  assert.ok(sourced);
  const feed = renderFeed([sourced], "https://example.workers.dev/book-express-rss");
  assert.match(feed, /简介：一部 &lt;书&gt;<br \/>\n来源：<a href="https:\/\/example\.com\/review\?a=1&amp;b=2">新京报 &amp; 周刊<\/a>/);

  const plain = bookFromPage({
    ...page,
    properties: {
      ...page.properties,
      "来源": { type: "select", select: { name: "周刊" } },
      "推荐来源": { type: "url", url: "javascript:alert(1)" },
    },
  });
  assert.ok(plain);
  const plainFeed = renderFeed([plain], "https://example.workers.dev/book-express-rss");
  assert.match(plainFeed, /来源：周刊/);
  assert.doesNotMatch(plainFeed, /<a href/);
});

test("missing or invalid external links fall back to the Notion page", () => {
  for (const value of [null, "javascript:alert(1)", "not a URL"]) {
    const book = bookFromPage({ ...page, properties: { ...page.properties, "豆瓣 / 亚马逊": { type: "url", url: value } } });
    assert.equal(book?.link, page.url);
  }
  assert.equal(bookFromPage({ ...page, url: null, properties: { ...page.properties, "豆瓣 / 亚马逊": { type: "url", url: null } } }), null);
  assert.equal(bookFromPage({ ...page, properties: { ...page.properties, "书名": { type: "title", title: [] } } }), null);
});

test("worker fetches all Notion pages and exposes only the feed path", async (context) => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ sorts?: unknown; start_cursor?: string }> = [];
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json(requests.length === 1
      ? { results: [page], has_more: true, next_cursor: "next" }
      : { results: [{ ...page, id: "book-2" }], has_more: false, next_cursor: null });
  }) as typeof fetch;
  context.after(() => { globalThis.fetch = originalFetch; });

  const env = { NOTION_TOKEN: "test", NOTION_DATA_SOURCE_ID: "source" };
  const missing = await worker.fetch(new Request("https://example.workers.dev/"), env);
  assert.equal(missing.status, 404);
  const response = await worker.fetch(new Request("https://example.workers.dev/book-express-rss"), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type") ?? "", /application\/rss\+xml/);
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=300");
  assert.equal((await response.text()).match(/<item>/g)?.length, 2);
  assert.deepEqual(requests[0]?.sorts, [{ timestamp: "last_edited_time", direction: "descending" }]);
  assert.equal(requests[1]?.start_cursor, "next");

  const head = await worker.fetch(new Request("https://example.workers.dev/book-express-rss", { method: "HEAD" }), env);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const method = await worker.fetch(new Request("https://example.workers.dev/book-express-rss", { method: "POST" }), env);
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("Allow"), "GET, HEAD");
});

test("cover image is loaded from the Notion page and proxied", async (context) => {
  const pageId = "3f8e75a1-639c-8120-9671-f146488f6d82";
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    urls.push(String(url));
    if (String(url).includes("/pages/")) {
      return Response.json({ properties: page.properties });
    }
    return new Response("image-bytes", { headers: { "Content-Type": "image/jpeg" } });
  }) as typeof fetch;
  context.after(() => { globalThis.fetch = originalFetch; });

  const env = { NOTION_TOKEN: "test", NOTION_DATA_SOURCE_ID: "source" };
  const missing = await worker.fetch(new Request("https://example.workers.dev/book-express-rss/cover/not-a-page"), env);
  assert.equal(missing.status, 404);
  assert.equal(urls.length, 0);

  const response = await worker.fetch(new Request(`https://example.workers.dev/book-express-rss/cover/${pageId}`), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "image/jpeg");
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=300");
  assert.equal(await response.text(), "image-bytes");
  assert.equal(urls[0], `https://api.notion.com/v1/pages/${pageId}`);
  assert.equal(urls[1], "https://files.example/cover.jpg?X-Amz-Signature=abc");

  globalThis.fetch = (async () => Response.json({ properties: { "封面": { type: "files", files: [] } } })) as typeof fetch;
  const empty = await worker.fetch(new Request(`https://example.workers.dev/book-express-rss/cover/${pageId}`), env);
  assert.equal(empty.status, 404);
});

test("missing configuration and Notion failures return explicit errors", async (context) => {
  const request = new Request("https://example.workers.dev/book-express-rss");
  assert.equal((await worker.fetch(request, {})).status, 503);

  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  globalThis.fetch = (async () => Response.json({ message: "rate limited" }, { status: 429 })) as typeof fetch;
  console.error = (() => {}) as typeof console.error;
  context.after(() => {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  });

  const response = await worker.fetch(request, { NOTION_TOKEN: "test", NOTION_DATA_SOURCE_ID: "source" });
  assert.equal(response.status, 502);
  assert.equal(await response.text(), "Feed temporarily unavailable");
});
