import assert from "node:assert/strict";
import test from "node:test";
import { parseRssFeed } from "feedsmith";
import { formatText } from "../src/format-text.ts";
import worker, {
  bookFromPage,
  excerptFromPage,
  renderExcerptFeed,
  renderFeed,
  shareCode,
  shareCodeId,
  viewQueryFilter,
  type NotionPage,
} from "../src/index.ts";

const page: NotionPage = {
  id: "book-1",
  url: "https://www.notion.so/book-1",
  created_time: "2026-10-01T08:00:00.000Z",
  last_edited_time: "2026-10-13T10:00:00.000Z",
  properties: {
    "书名": { type: "title", title: [{ plain_text: "甲 & 乙" }] },
    "简介": { type: "rich_text", rich_text: [{ plain_text: "一部 <书>" }] },
    "作者": { type: "rich_text", rich_text: [{ plain_text: "张三" }] },
    "作者介绍": { type: "rich_text", rich_text: [{ plain_text: "写过 & 小说" }] },
    "详情链接": { type: "url", url: "https://book.douban.com/subject/123/?a=1&b=2" },
    "封面": { type: "files", files: [{ name: "cover.jpg", type: "file", file: { url: "https://files.example/cover.jpg?X-Amz-Signature=abc" } }] },
    "出版社 / 品牌": { type: "rich_text", rich_text: [{ plain_text: "三联 & 书店" }] },
  },
};

/** Notion's auto-increment ID property, required for an excerpt to get a detail URL. */
const idProperty = (number = 1) => ({ ID: { type: "unique_id", unique_id: { prefix: null, number } } });

test("RSS item has exactly the requested fields and escapes XML", () => {
  const book = bookFromPage(page);
  assert.ok(book);
  assert.equal(book.pubDate?.toISOString(), "2026-10-01T08:00:00.000Z");
  const feed = renderFeed([book], "https://example.workers.dev/book.xml");
  assert.match(feed, /<link>\s*<!\[CDATA\[https:\/\/book\.douban\.com\/subject\/123\/\?a=1&b=2\]\]>/);
  assert.match(feed, /<title>\s*<!\[CDATA\[甲 & 乙\]\]>/);
  assert.match(feed, /<!\[CDATA\[作者：张三 \| 写过 &amp; 小说<br \/>\n简介：一部 &lt;书&gt;<br \/>\n出版社：三联 &amp; 书店<br \/>\n<img src="https:\/\/example\.workers\.dev\/book\/p\/book-1" alt="封面" \/>\]\]>/);
  const withoutIntro = bookFromPage({ ...page, properties: { ...page.properties, "作者介绍": { type: "rich_text", rich_text: [] } } });
  assert.match(renderFeed(withoutIntro ? [withoutIntro] : [], "https://example.workers.dev/book.xml"), /作者：张三<br \/>/);
  assert.doesNotMatch(renderFeed(withoutIntro ? [withoutIntro] : [], "https://example.workers.dev/book.xml"), /作者：张三 \|/);
  assert.doesNotMatch(feed, /书名：|width=|style=|<category>|files\.example|来源：/);
  assert.match(feed, /<guid isPermaLink="false">notion:book-1<\/guid>/);
  assert.match(feed, /<atom:link href="https:\/\/example\.workers\.dev\/book\.xml" rel="self" type="application\/rss\+xml"\/>/);
  assert.match(feed, /<language>zh-CN<\/language>/);
  const withoutCover = bookFromPage({ ...page, properties: { ...page.properties, "封面": { type: "files", files: [] } } });
  assert.equal(withoutCover?.hasCover, false);
  assert.doesNotMatch(renderFeed(withoutCover ? [withoutCover] : [], "https://example.workers.dev/book.xml"), /<img /);
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
  const feed = renderFeed([sourced], "https://example.workers.dev/book.xml");
  assert.match(feed, /简介：一部 &lt;书&gt;<br \/>\n出版社：三联 &amp; 书店<br \/>\n来源：<a href="https:\/\/example\.com\/review\?a=1&amp;b=2">新京报 &amp; 周刊<\/a>/);

  const plain = bookFromPage({
    ...page,
    properties: {
      ...page.properties,
      "来源": { type: "select", select: { name: "周刊" } },
      "推荐来源": { type: "url", url: "javascript:alert(1)" },
    },
  });
  assert.ok(plain);
  const plainFeed = renderFeed([plain], "https://example.workers.dev/book.xml");
  assert.match(plainFeed, /来源：周刊/);
  assert.doesNotMatch(plainFeed, /<a href/);
});

test("missing or invalid external links fall back to the Notion page", () => {
  for (const value of [null, "javascript:alert(1)", "not a URL"]) {
    const book = bookFromPage({ ...page, properties: { ...page.properties, "详情链接": { type: "url", url: value } } });
    assert.equal(book?.link, page.url);
  }
  assert.equal(bookFromPage({ ...page, url: null, properties: { ...page.properties, "详情链接": { type: "url", url: null } } }), null);
  assert.equal(bookFromPage({ ...page, properties: { ...page.properties, "书名": { type: "title", title: [] } } }), null);
});

test("worker paginates Notion results and exposes only the feed path", async (context) => {
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
  assert.equal((await worker.fetch(new Request("https://example.workers.dev/book/rss"), env)).status, 404);
  const response = await worker.fetch(new Request("https://example.workers.dev/book.xml"), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type") ?? "", /application\/rss\+xml/);
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=300, must-revalidate");
  assert.equal((await response.text()).match(/<item>/g)?.length, 2);
  assert.deepEqual(requests[0]?.sorts, [{ timestamp: "last_edited_time", direction: "descending" }]);
  assert.equal(requests[1]?.start_cursor, "next");

  const head = await worker.fetch(new Request("https://example.workers.dev/book.xml", { method: "HEAD" }), env);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const method = await worker.fetch(new Request("https://example.workers.dev/book.xml", { method: "POST" }), env);
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("Allow"), "GET, HEAD");
});

test("both feeds query and render only the first 30 records, preserving their order", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const env = { NOTION_TOKEN: "test", NOTION_DATA_SOURCE_ID: "source", NOTION_EXCERPTS_DATA_SOURCE_ID: "source", NOTION_EXCERPTS_VIEW_ID: "view" };
  for (const path of ["/book.xml", "/read.xml"]) {
    const requests: Array<{ page_size: number; start_cursor?: string }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("/views/")) return Response.json({ data_source_id: "source" });
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      // A partial first batch still needs pagination, but stop once 30 are collected.
      const offset = requests.length === 1 ? 0 : 13;
      const count = requests.length === 1 ? 13 : body.page_size;
      return Response.json({
        results: Array.from({ length: count }, (_, index) => ({
          ...page,
          id: `item-${offset + index}`,
          properties: { ...page.properties, ...idProperty(offset + index + 1), "正文翻译": { type: "rich_text", rich_text: [{ plain_text: "正文" }] } },
        })),
        has_more: true,
        next_cursor: "next",
      });
    }) as typeof fetch;
    const response = await worker.fetch(new Request(`https://example.workers.dev${path}`), env);
    assert.equal(response.status, 200);
    const feed = parseRssFeed(await response.text());
    assert.deepEqual(requests.map((request) => request.page_size), [30, 17]);
    assert.equal(requests[1]?.start_cursor, "next");
    assert.deepEqual(feed.items?.map((item) => item.guid?.value), Array.from({ length: 30 }, (_, index) => `notion:item-${index}`));
  }
});

test("both feeds revalidate and rebuild when Notion content changes", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let revision = 1;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    if (String(url).includes("/views/")) return Response.json({ data_source_id: "source" });
    return Response.json({ results: [{ ...page, properties: {
      ...page.properties,
      ...idProperty(),
      "简介": { type: "rich_text", rich_text: [{ plain_text: `正文版本 ${revision}` }] },
      "标题翻译": { type: "rich_text", rich_text: [{ plain_text: `标题版本 ${revision}` }] },
      "正文翻译": { type: "rich_text", rich_text: [{ plain_text: `正文版本 ${revision}` }] },
    } }], has_more: false });
  }) as typeof fetch;
  const env = { NOTION_TOKEN: "test", NOTION_DATA_SOURCE_ID: "source", NOTION_EXCERPTS_DATA_SOURCE_ID: "source", NOTION_EXCERPTS_VIEW_ID: "view" };
  const cases = [
    { path: "/book.xml", marker: "正文版本" },
    { path: "/read.xml", marker: "标题版本" },
  ] as const;
  for (const { path, marker } of cases) {
    const request = new Request(`https://example.workers.dev${path}`);
    revision = 1;
    const first = await worker.fetch(request, env);
    assert.equal(first.headers.get("Cache-Control"), "public, max-age=300, must-revalidate");
    assert.match(await first.text(), new RegExp(`${marker} 1`));
    revision = 2;
    const second = await worker.fetch(request, env);
    assert.match(await second.text(), new RegExp(`${marker} 2`));
    const head = await worker.fetch(new Request(request.url, { method: "HEAD" }), env);
    assert.equal(head.headers.get("Cache-Control"), first.headers.get("Cache-Control"));
    assert.equal(await head.text(), "");
  }
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
  const missing = await worker.fetch(new Request("https://example.workers.dev/book/p/not-a-page"), env);
  assert.equal(missing.status, 404);
  assert.equal(urls.length, 0);

  const response = await worker.fetch(new Request(`https://example.workers.dev/book/p/${pageId}`), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "image/jpeg");
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=300");
  assert.equal(await response.text(), "image-bytes");
  assert.equal(urls[0], `https://api.notion.com/v1/pages/${pageId}`);
  assert.equal(urls[1], "https://files.example/cover.jpg?X-Amz-Signature=abc");

  globalThis.fetch = (async () => Response.json({ properties: { "封面": { type: "files", files: [] } } })) as typeof fetch;
  const empty = await worker.fetch(new Request(`https://example.workers.dev/book/p/${pageId}`), env);
  assert.equal(empty.status, 404);

  globalThis.fetch = (async (url: RequestInfo | URL) => String(url).includes("/pages/")
    ? Response.json({ properties: page.properties })
    : new Response("<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>", {
      headers: { "Content-Type": "image/svg+xml; charset=utf-8" },
    })) as typeof fetch;
  context.mock.method(console, "error", () => {});
  const svg = await worker.fetch(new Request(`https://example.workers.dev/book/p/${pageId}`), env);
  assert.equal(svg.status, 502);
  assert.doesNotMatch(await svg.text(), /<script>/);
});

test("missing configuration and Notion failures return explicit errors", async (context) => {
  const request = new Request("https://example.workers.dev/book.xml");
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
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(await response.text(), "Feed temporarily unavailable");
});

test("excerpt feed uses the Notion RSS view filter, paginates, and links to e-ink detail pages", async (context) => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ method?: string; url: string; body?: Record<string, unknown> }> = [];
  const viewId = "40ae75a1-639c-81f8-b7fe-000c40372432";
  const viewFilter = {
    or: [
      { property: "正文翻译", rich_text: { is_not_empty: true } },
      { property: "原文语言", select: { equals: "中文" } },
    ],
  };
  const excerpt = {
    id: "407e75a1-639c-81ca-8919-f4bff2a57884",
    url: "https://www.notion.so/excerpt-1",
    created_time: "2026-10-01T08:00:00.000Z",
    last_edited_time: "2026-10-13T10:00:00.000Z",
    properties: {
      ...idProperty(7),
      "标题": { type: "title", title: [{ plain_text: "Original & title" }] },
      "标题翻译": { type: "rich_text", rich_text: [{ plain_text: "第一节 & 开始" }] },
      "正文翻译": { type: "rich_text", rich_text: [{ plain_text: "一行 <文字>\n" }, { plain_text: "第二行 & 更多" }] },
      "出处": { type: "rich_text", rich_text: [{ plain_text: "甲 & 乙" }] },
      "内容类型": { type: "select", select: { name: "书籍" } },
      "作者": { type: "rich_text", rich_text: [{ plain_text: "张三" }] },
      "出版方": { type: "rich_text", rich_text: [{ plain_text: "某出版社" }] },
      "章节": { type: "rich_text", rich_text: [{ plain_text: "第一章" }] },
      "原文语言": { type: "select", select: { name: "英文" } },
      "发布日期": { type: "date", date: { start: "2025-06-12" } },
      "原文链接": { type: "url", url: "https://example.com/original?a=1&b=2" },
      "专有名词与术语": { type: "rich_text", rich_text: [{ plain_text: "Term A<br />释义 A<br /><br />Term B<br />释义 B" }] },
    },
  };
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const href = String(url);
    const method = init?.method ?? "GET";
    requests.push({
      method,
      url: href,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    if (method === "GET" && href.includes(`/views/${viewId}`)) {
      return Response.json({
        object: "view",
        id: viewId,
        name: "RSS",
        data_source_id: "excerpt-source",
        filter: viewFilter,
        quick_filters: {
          "FiF=": { select: { equals: "日文" } },
          txoA: { rich_text: { contains: "文" } },
        },
        sorts: [],
      });
    }
    if (method === "POST" && href.includes("/data_sources/excerpt-source/query")) {
      return Response.json(requests.filter((request) => request.url.includes("/data_sources/excerpt-source/query")).length === 1
        ? { results: [excerpt, { ...excerpt, id: "empty", properties: { ...excerpt.properties, "正文翻译": { type: "rich_text", rich_text: [{ plain_text: "  " }] } } }], has_more: true, next_cursor: "next" }
        : { results: [{ ...excerpt, id: "407e75a1-639c-81ca-8919-f4bff2a57885", url: "https://www.notion.so/excerpt-2" }], has_more: false });
    }
    throw new Error(`Unexpected fetch: ${method} ${href}`);
  }) as typeof fetch;
  context.after(() => { globalThis.fetch = originalFetch; });

  const env = {
    NOTION_TOKEN: "test",
    NOTION_EXCERPTS_DATA_SOURCE_ID: "excerpt-source",
    NOTION_EXCERPTS_VIEW_ID: viewId,
  };
  const response = await worker.fetch(new Request("https://example.workers.dev/read.xml"), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type") ?? "", /application\/rss\+xml/);
  const feed = await response.text();
  const parsed = parseRssFeed(feed);
  assert.equal(parsed.title, "阅读节选");
  assert.equal(parsed.items?.length, 2);
  const item = parsed.items?.[0];
  assert.equal(item?.title, "第一节 & 开始");
  assert.equal(item?.link, `https://example.workers.dev/r/${shareCode(7)}`);
  assert.equal(item?.guid?.value, "notion:407e75a1-639c-81ca-8919-f4bff2a57884");
  assert.equal(item?.description, undefined);
  assert.doesNotMatch(feed, /<item>[\s\S]*?<description>|一行 &lt;文字&gt;|原文：|名词解释/);
  assert.equal(requests[0]?.url, `https://api.notion.com/v1/views/${viewId}`);
  assert.deepEqual(requests[1]?.body?.filter, {
    and: [
      viewFilter,
      { select: { equals: "日文" }, property: "FiF=" },
      { rich_text: { contains: "文" }, property: "txoA" },
    ],
  });
  assert.equal(requests[1]?.body?.sorts, undefined);
  assert.equal(requests[2]?.body?.start_cursor, "next");
  assert.equal((await worker.fetch(new Request("https://example.workers.dev/read.xml"), {
    NOTION_TOKEN: "test",
    NOTION_EXCERPTS_DATA_SOURCE_ID: "excerpt-source",
  })).status, 503);
});

test("view query filter ANDs the saved filter with each quick filter", () => {
  const saved = { or: [{ property: "正文翻译", rich_text: { is_not_empty: true } }] };
  assert.equal(viewQueryFilter({}), undefined);
  assert.deepEqual(viewQueryFilter({ filter: saved, quick_filters: {} }), saved);
  assert.deepEqual(viewQueryFilter({ filter: saved, quick_filters: { txoA: {}, FiF: { select: { equals: "中文" } } } }), {
    and: [saved, { select: { equals: "中文" }, property: "FiF" }],
  });
  assert.deepEqual(viewQueryFilter({ quick_filters: { FiF: { select: { equals: "日文" } } } }), {
    select: { equals: "日文" },
    property: "FiF",
  });
  assert.deepEqual(viewQueryFilter({
    filter: saved,
    quick_filters: { FiF: { select: { equals: "日文" } }, txoA: { rich_text: { contains: "文" } } },
  }), {
    and: [
      saved,
      { select: { equals: "日文" }, property: "FiF" },
      { rich_text: { contains: "文" }, property: "txoA" },
    ],
  });
});

test("excerpt feed forwards a saved view sort and omits the fallback", async (context) => {
  const originalFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  const viewId = "40ae75a1-639c-81f8-b7fe-000c40372432";
  const savedSort = [{ property: "title", direction: "ascending" }];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const href = String(url);
    if ((init?.method ?? "GET") === "GET" && href.includes(`/views/${viewId}`)) {
      return Response.json({ data_source_id: "excerpt-source", sorts: savedSort });
    }
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ results: [], has_more: false });
  }) as typeof fetch;
  context.after(() => { globalThis.fetch = originalFetch; });

  const response = await worker.fetch(new Request("https://example.workers.dev/read.xml"), {
    NOTION_TOKEN: "test",
    NOTION_EXCERPTS_DATA_SOURCE_ID: "excerpt-source",
    NOTION_EXCERPTS_VIEW_ID: viewId,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(bodies[0]?.sorts, savedSort);
});

test("excerpt titles fall back to the original", () => {
  const excerpt = excerptFromPage({
    id: "1", url: "https://www.notion.so/1", properties: {
      ...idProperty(),
      "标题": { type: "title", title: [{ plain_text: "节" }] },
      "标题翻译": { type: "rich_text", rich_text: [{ plain_text: " \n " }] },
      "正文翻译": { type: "rich_text", rich_text: [{ plain_text: "正文" }] },
      "出处": { type: "rich_text", rich_text: [{ plain_text: "书" }] },
      "原文链接": { type: "url", url: "javascript:alert(1)" },
    },
  });
  assert.ok(excerpt);
  const feed = renderExcerptFeed([excerpt], "https://example.com/read.xml");
  const item = parseRssFeed(feed).items?.[0];
  assert.equal(item?.title, "节");
  assert.equal(item?.description, undefined);

});

test("magazine and web excerpts link to reading detail pages", () => {
  for (const contentType of ["杂志", "网页文章"]) {
    const excerpt = excerptFromPage({
      id: "article", url: "https://www.notion.so/article", properties: {
        ...idProperty(),
        "标题": { type: "title", title: [{ plain_text: "Article" }] },
        "标题翻译": { type: "rich_text", rich_text: [{ text: { content: "文章" } }] },
        "正文翻译": { type: "rich_text", rich_text: [{ plain_text: "译文" }] },
        "内容类型": { type: "select", select: { name: contentType } },
        "出处": { type: "rich_text", rich_text: [{ plain_text: "专题" }] },
        "出版方": { type: "rich_text", rich_text: [{ plain_text: "媒体" }] },
        "原文链接": { type: "url", url: "https://example.com/article" },
      },
    });
    assert.ok(excerpt);
    const item = parseRssFeed(renderExcerptFeed([excerpt], "https://example.com/read.xml")).items?.[0];
    assert.equal(item?.link, `https://example.com/r/${shareCode(1)}`);
    assert.equal(item?.guid?.value, "notion:article");
    assert.equal(item?.description, undefined);

  }
});

test("excerpts without translated content, identity, or a valid Notion link are excluded", () => {
  const translated: NotionPage = {
    id: "1", url: "https://www.notion.so/1", properties: {
      ...idProperty(),
      "正文翻译": { type: "rich_text", rich_text: [{ plain_text: "正文" }] },
    },
  };
  assert.equal(excerptFromPage(translated)?.title, "无标题");
  assert.equal(excerptFromPage({ ...translated, id: undefined }), null);
  assert.equal(excerptFromPage({ ...translated, url: "javascript:alert(1)" }), null);
  assert.equal(excerptFromPage({ ...translated, properties: {} }), null);
  const { ID: _id, ...withoutId } = translated.properties!;
  assert.equal(excerptFromPage({ ...translated, properties: withoutId }), null, "no detail URL without the Notion ID");
  for (const number of [0, 2 ** 20, 1.5]) {
    assert.equal(excerptFromPage({ ...translated, properties: { ...translated.properties, ...idProperty(number) } }), null);
  }
  assert.equal(excerptFromPage({ ...translated, properties: { ...idProperty(), "正文翻译": { type: "rich_text", rich_text: [{ plain_text: "\n  " }] } } }), null);
  assert.equal(excerptFromPage({
    id: "zh",
    url: "https://www.notion.so/zh",
    properties: {
      ...idProperty(),
      "原文语言": { type: "select", select: { name: "中文" } },
      "正文翻译": { type: "rich_text", rich_text: [{ plain_text: "旧译文" }] },
    },
  }), null);
});

test("Chinese excerpts use the original title and body, not translations", () => {
  const chinese: NotionPage = {
    id: "zh", url: "https://www.notion.so/zh", properties: {
      ...idProperty(),
      "标题": { type: "title", title: [{ plain_text: "中文标题" }] },
      "标题翻译": { type: "rich_text", rich_text: [{ plain_text: "不应使用" }] },
      "正文": { type: "rich_text", rich_text: [{ plain_text: "中文正文" }] },
      "正文翻译": { type: "rich_text", rich_text: [{ plain_text: "不应输出的译文" }] },
      "原文语言": { type: "select", select: { name: "中文" } },
      "出处": { type: "rich_text", rich_text: [{ plain_text: "某刊" }] },
      "原文链接": { type: "url", url: "https://example.com/zh" },
    },
  };
  const excerpt = excerptFromPage(chinese);
  assert.ok(excerpt);
  assert.equal(excerpt.title, "中文标题");
  assert.equal(excerpt.body, "中文正文");
  assert.equal(excerpt.chinese, true);
  assert.equal(excerpt.lang, "zh-CN");
  assert.equal(excerpt.titleLang, "zh-CN");
  assert.equal(excerpt.originalLang, "zh-CN");
  const item = parseRssFeed(renderExcerptFeed([excerpt], "https://example.com/read.xml")).items?.[0];
  assert.equal(item?.title, "中文标题");
  assert.equal(item?.description, undefined);
  assert.equal(excerptFromPage({
    ...chinese,
    properties: { ...chinese.properties, "原文语言": { type: "select", select: { name: "日文" } }, "正文翻译": { type: "rich_text", rich_text: [] } },
  }), null);
});

test("translated excerpts retain the correct title language", () => {
  for (const [language, lang, title] of [
    ["日文", "ja", "読書と思考 <script>"],
    ["英文", "en", "Reading & thinking"],
  ]) {
    const page: NotionPage = {
      id: "407e75a1-639c-81ca-8919-f4bff2a57884",
      url: "https://www.notion.so/excerpt",
      properties: {
        ...idProperty(),
        "原文语言": { type: "select", select: { name: language } },
        "标题": { type: "title", title: [{ plain_text: title }] },
        "正文翻译": { type: "rich_text", rich_text: [{ plain_text: "中文译文" }] },
      },
    };
    const excerpt = excerptFromPage(page);
    assert.ok(excerpt);
    assert.equal(excerpt.lang, "zh-CN");
    assert.equal(excerpt.titleLang, lang);
    assert.equal(excerpt.originalLang, lang);
    page.properties!["标题翻译"] = { type: "rich_text", rich_text: [{ plain_text: "阅读与思考" }] };
    const translated = excerptFromPage(page);
    assert.ok(translated);
    assert.equal(translated.titleLang, "zh-CN");
    page.properties!["标题"] = { type: "title", title: [] };
    page.properties!["标题翻译"] = { type: "rich_text", rich_text: [] };
    const untitled = excerptFromPage(page);
    assert.ok(untitled);
    assert.equal(untitled.title, "无标题");
    assert.equal(untitled.titleLang, "zh-CN");
  }
});

test("Chinese excerpt feed uses the body property without fetching page blocks", async (context) => {
  const originalFetch = globalThis.fetch;
  const pageId = "407e75a1-639c-81ca-8919-f4bff2a57886";
  const viewId = "40ae75a1-639c-81f8-b7fe-000c40372432";
  const requests: string[] = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const href = String(url);
    const method = init?.method ?? "GET";
    requests.push(`${method} ${href}`);
    if (method === "GET" && href.includes(`/views/${viewId}`)) {
      return Response.json({
        object: "view",
        id: viewId,
        data_source_id: "excerpt-source",
        filter: { property: "原文语言", select: { equals: "中文" } },
        sorts: [],
      });
    }
    if (method === "POST" && href.includes("/data_sources/excerpt-source/query")) {
      return Response.json({
        results: [{
          id: pageId,
          url: "https://www.notion.so/zh-page",
          created_time: "2026-10-02T08:00:00.000Z",
          last_edited_time: "2026-10-14T10:00:00.000Z",
          properties: {
            ...idProperty(),
            "标题": { type: "title", title: [{ plain_text: "中文节选" }] },
            "正文": { type: "rich_text", rich_text: [{ plain_text: "属性正文第一段\n\n属性正文第二段" }] },
            "正文翻译": { type: "rich_text", rich_text: [{ plain_text: "忽略译文" }] },
            "原文语言": { type: "select", select: { name: "中文" } },
            "出处": { type: "rich_text", rich_text: [{ plain_text: "日报" }] },
          },
        }],
        has_more: false,
      });
    }
    throw new Error(`Unexpected fetch: ${method} ${href}`);
  }) as typeof fetch;
  context.after(() => { globalThis.fetch = originalFetch; });

  const response = await worker.fetch(
    new Request("https://example.workers.dev/read.xml"),
    {
      NOTION_TOKEN: "test",
      NOTION_EXCERPTS_DATA_SOURCE_ID: "excerpt-source",
      NOTION_EXCERPTS_VIEW_ID: viewId,
    },
  );
  assert.equal(response.status, 200);
  const feed = await response.text();
  const item = parseRssFeed(feed).items?.[0];
  assert.equal(item?.title, "中文节选");
  assert.equal(item?.description, undefined);
  assert.equal(item?.link, `https://example.workers.dev/r/${shareCode(1)}`);
  assert.equal(requests.some((href) => href.includes("/blocks/")), false);
});

test("text formatting handles nested quotes, markup, and English apostrophes", () => {
  assert.equal(formatText("他说：“使用‘AI工具’。”"), "他说：「使用『AI 工具』。」");
  assert.equal(formatText("‘单独引用’和\"中文\""), "「单独引用」和「中文」");
  assert.equal(formatText("他说：「已经『格式化』。」"), "他说：「已经『格式化』。」");
  assert.equal(formatText("『已有引号』"), "『已有引号』");
  assert.equal(formatText("英文 don't 和 ‘it’s’"), "英文 don't 和 「it’s」");
  assert.equal(formatText("他说：\u201c这是 James' book。\u201d"), "他说：「这是 James' book。」");
  assert.equal(formatText("他说：\u201c这是 'Alice' 的书。\u201d"), "他说：「这是 『Alice』 的书。」");
  assert.equal(formatText('The "English" title'), 'The "English" title');
  assert.equal(formatText('中文 <span title="文字">“AI技术”</span> https://example.com/中文'),
    '中文 <span title="文字">「AI 技术」</span> https://example.com/中文');
  assert.equal(formatText("未闭合的“引号"), "未闭合的 “引号");
});

test("RSS item titles are formatted; descriptions keep original spacing", () => {
  const pageId = "408e75a1-639c-8152-ab6f-f35a59ab2d27";
  const excerpt = excerptFromPage({ id: pageId, url: "https://notion.so/page", properties: {
    ...idProperty(),
    "标题翻译": { type: "rich_text", rich_text: [{ plain_text: "“AI时代的RSS”" }] },
    "正文翻译": { type: "rich_text", rich_text: [{ plain_text: "使用API处理2026年数据。" }] },
    "出处": { type: "rich_text", rich_text: [{ plain_text: "Cloudflare Workers" }] },
  } });
  assert.ok(excerpt);
  const item = parseRssFeed(renderExcerptFeed([excerpt], "https://example.com/read.xml")).items?.[0];
  assert.equal(item?.title, "「AI 时代的 RSS」");
  assert.equal(item?.description, undefined);
  assert.equal(item?.link, `https://example.com/r/${shareCode(1)}`);
  const book = bookFromPage({ ...page, properties: {
    ...page.properties,
    "书名": { type: "title", title: [{ plain_text: "“AI时代的RSS”" }] },
    "简介": { type: "rich_text", rich_text: [{ plain_text: "保留API与2026年之间的原始排版 & <文字>" }] },
  } });
  assert.ok(book);
  const bookItem = parseRssFeed(renderFeed([book], "https://example.com/book.xml")).items?.[0];
  assert.equal(bookItem?.title, "「AI 时代的 RSS」");
  assert.match(bookItem?.description ?? "", /保留API与2026年之间的原始排版 &amp; &lt;文字&gt;/);
});

test("RSS description includes only the first body image when present", () => {
  const pageId = "408e75a1-639c-8152-ab6f-f35a59ab2d27";
  const blockId = "28324ab7-0534-48a3-8fbe-fed8e055041d";
  const fileId = "8c289a44-4d96-46f6-a6ee-1d6374101e7e";
  const secondBlock = "1a52e0b5-2ddd-4438-8257-9e6c5a426940";
  const secondFile = "69d14bc7-c973-4ee7-9123-bde234614e89";
  const excerpt = excerptFromPage({
    id: pageId,
    url: "https://notion.so/page",
    properties: {
      ...idProperty(),
      "正文翻译": {
        type: "rich_text",
        rich_text: [{
          plain_text: [
            "前文",
            `<image source="notion-file-block://${blockId}/${fileId}?name=photo.jpg" />`,
            `<image source="notion-file-block://${secondBlock}/${secondFile}">说明</image>`,
          ].join("<br /><br />"),
        }],
      },
    },
  });
  assert.ok(excerpt);
  const item = parseRssFeed(renderExcerptFeed([excerpt], "https://example.com/read.xml")).items?.[0];
  assert.equal(item?.description, `<img src="https://example.com/read/p/${pageId}/${blockId}" alt="正文图片" />`);
  assert.doesNotMatch(item?.description ?? "", new RegExp(secondBlock));
});

test("RSS description uses the earliest plain img or notion image in the body", () => {
  const pageId = "408e75a1-639c-8152-ab6f-f35a59ab2d27";
  const blockId = "28324ab7-0534-48a3-8fbe-fed8e055041d";
  const fileId = "8c289a44-4d96-46f6-a6ee-1d6374101e7e";
  const feedUrl = "https://example.com/read.xml";

  const withImg = excerptFromPage({
    id: pageId,
    url: "https://notion.so/page",
    properties: {
      ...idProperty(),
      "正文翻译": {
        type: "rich_text",
        rich_text: [{
          plain_text: [
            `<img src="https://cdn.example.com/cover.jpg" alt="cover" />`,
            `<image source="notion-file-block://${blockId}/${fileId}" />`,
          ].join("<br /><br />"),
        }],
      },
    },
  });
  assert.ok(withImg);
  assert.equal(
    parseRssFeed(renderExcerptFeed([withImg], feedUrl)).items?.[0]?.description,
    `<img src="https://cdn.example.com/cover.jpg" alt="正文图片" />`,
  );

  const notionFirst = excerptFromPage({
    id: pageId,
    url: "https://notion.so/page",
    properties: {
      ...idProperty(),
      "正文翻译": {
        type: "rich_text",
        rich_text: [{
          plain_text: [
            `<image source="notion-file-block://${blockId}/${fileId}" />`,
            `<img src='https://cdn.example.com/later.jpg' />`,
          ].join("<br /><br />"),
        }],
      },
    },
  });
  assert.ok(notionFirst);
  assert.equal(
    parseRssFeed(renderExcerptFeed([notionFirst], feedUrl)).items?.[0]?.description,
    `<img src="https://example.com/read/p/${pageId}/${blockId}" alt="正文图片" />`,
  );

  const unsafe = excerptFromPage({
    id: pageId,
    url: "https://notion.so/page",
    properties: {
      ...idProperty(),
      "正文翻译": {
        type: "rich_text",
        rich_text: [{ plain_text: `<img src="javascript:alert(1)" /><img src="https://cdn.example.com/ok.png" />` }],
      },
    },
  });
  assert.ok(unsafe);
  assert.equal(
    parseRssFeed(renderExcerptFeed([unsafe], feedUrl)).items?.[0]?.description,
    `<img src="https://cdn.example.com/ok.png" alt="正文图片" />`,
  );
});

test("reading list API uses the RSS view", async (context) => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body?: Record<string, unknown> }> = [];
  const pageId = "407e75a1-639c-81ca-8919-f4bff2a57884";
  const viewId = "40ae75a1-639c-81f8-b7fe-000c40372432";
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const href = String(url);
    const method = init?.method ?? "GET";
    if (method === "GET" && href.includes(`/views/${viewId}`)) {
      requests.push({ url: href });
      return Response.json({
        object: "view",
        id: viewId,
        data_source_id: "excerpt-source",
        filter: { property: "正文翻译", rich_text: { is_not_empty: true } },
        sorts: [],
      });
    }
    requests.push({ url: href, body: JSON.parse(String(init?.body)) });
    return Response.json({
      results: [{
        id: pageId,
        url: "https://www.notion.so/excerpt-1",
        properties: {
          ...idProperty(),
          "标题翻译": { type: "rich_text", rich_text: [{ plain_text: "AI时代的RSS" }] },
          "正文翻译": { type: "rich_text", rich_text: [{ plain_text: "正文" }] },
          "出处": { type: "rich_text", rich_text: [{ plain_text: "科技News" }] },
          "作者": { type: "rich_text", rich_text: [{ plain_text: "张三AI" }] },
        },
      }],
      has_more: false,
    });
  }) as typeof fetch;
  context.after(() => { globalThis.fetch = originalFetch; });

  const api = await worker.fetch(new Request("https://example.workers.dev/api/read"), {
    NOTION_TOKEN: "test",
    NOTION_EXCERPTS_DATA_SOURCE_ID: "excerpt-source",
    NOTION_EXCERPTS_VIEW_ID: viewId,
  });
  assert.match(api.headers.get("Content-Type") ?? "", /application\/json/);
  assert.equal(requests[0]?.url, `https://api.notion.com/v1/views/${viewId}`);
  assert.deepEqual(await api.json(), {
    kind: "articles", hasMore: false,
    items: [{ code: shareCode(1), title: "AI 时代的 RSS", titleLang: "zh-CN", source: "科技 News", author: "张三 AI" }],
  });
  assert.equal((await worker.fetch(new Request("https://example.workers.dev/api/read"), {
    NOTION_TOKEN: "test",
    NOTION_EXCERPTS_DATA_SOURCE_ID: "excerpt-source",
  })).status, 503);
});

test("reading API applies category filters and selects article neighbors", async (context) => {
  const originalFetch = globalThis.fetch;
  const pageId = "407e75a1-639c-81ca-8919-f4bff2a57884";
  const nextId = "408e75a1-639c-8152-ab6f-f35a59ab2d27";
  const code = shareCode(1);
  const nextCode = shareCode(2);
  const makePage = (id: string) => ({
    id, url: `https://www.notion.so/${id}`,
    parent: { type: "data_source_id", data_source_id: "source" },
    properties: {
      ...idProperty(id === pageId ? 1 : 2),
      "标题翻译": { type: "rich_text", rich_text: [{ plain_text: id }] },
      "正文翻译": { type: "rich_text", rich_text: [{ plain_text: "正文" }] },
    },
  });
  const queries: Array<{ filter?: object }> = [];
  const viewFilter = { property: "正文翻译", rich_text: { is_not_empty: true } };
  const favoritesFilter = { property: "收藏", checkbox: { equals: true } };
  const favoritesSorts = [{ timestamp: "last_edited_time", direction: "descending" }];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.endsWith("/views/saved-view")) {
      return Response.json({ data_source_id: "source", filter: favoritesFilter, sorts: [{ property: "发布日期", direction: "descending" }] });
    }
    if (href.includes("/views/")) return Response.json({ data_source_id: "source", filter: viewFilter });
    const query = JSON.parse(String(init?.body));
    if (query.filter?.unique_id) return Response.json({ results: [makePage(pageId)], has_more: false });
    queries.push(query);
    return Response.json({ results: [makePage(pageId), makePage(nextId)], has_more: false });
  }) as typeof fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const env = {
    NOTION_TOKEN: "test",
    NOTION_EXCERPTS_DATA_SOURCE_ID: "source",
    NOTION_EXCERPTS_VIEW_ID: "view",
    NOTION_EXCERPTS_FAVORITES_VIEW_ID: "saved-view",
  };
  for (const [category, marker] of [
    ["weekly", "bunshun.jp/denshiban/articles/"],
    ["bunshun", "bunshun.jp/articles/"],
    ["novel", "epub"],
    ["news", "news.ycombinator.com"],
  ]) {
    const response = await worker.fetch(new Request(`https://example.com/api/read?tab=${category}`), env);
    assert.equal(response.status, 200);
    assert.match(JSON.stringify(queries.at(-1)?.filter), new RegExp(marker.replaceAll(".", "\\.")));
    assert.match(JSON.stringify(queries.at(-1)?.filter), /正文翻译/);
    if (category === "weekly" || category === "bunshun") {
      assert.deepEqual(queries.at(-1)?.filter, { and: [viewFilter, { or: [
        { property: "原文链接", url: { contains: marker } },
        { property: "备注", rich_text: { contains: marker } },
      ] }] });
    }
  }
  const later = await worker.fetch(new Request("https://example.com/api/read?tab=later"), env);
  assert.equal(later.status, 200);
  assert.deepEqual(queries.at(-1)?.filter, { property: "提取来源", select: { equals: "Instapaper" } });
  for (const category of ["later", "weekly", "likes"]) {
    const detail = await worker.fetch(new Request(`https://example.com/api/r/${code}?tab=${category}`), env);
    const article = await detail.json<import("../src/reader-data.ts").ReaderArticle>();
    assert.equal(article.actions?.nextCode, nextCode);
    if (category === "likes") assert.deepEqual(queries.at(-1), { page_size: 30, filter: favoritesFilter, sorts: favoritesSorts });
  }
  const fallback = await worker.fetch(new Request("https://example.com/api/read?tab=unknown"), env);
  assert.equal(fallback.headers.get("Cache-Control"), "public, max-age=300, must-revalidate");
  assert.deepEqual(queries.at(-1)?.filter, viewFilter);
  const favorites = await worker.fetch(new Request("https://example.com/api/read?tab=likes"), env);
  assert.equal(favorites.status, 200);
  assert.equal(favorites.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(queries.at(-1), { page_size: 31, filter: favoritesFilter, sorts: favoritesSorts });
  const rss = await worker.fetch(new Request("https://example.com/read.xml?tab=likes"), env);
  assert.equal(rss.status, 200);
  assert.deepEqual(queries.at(-1)?.filter, viewFilter);
});

test("reading list API expands pages within its category", async (context) => {
  const originalFetch = globalThis.fetch;
  const pageId = (index: number) => `407e75a1-639c-81ca-8919-${String(index).padStart(12, "0")}`;
  const code = (index: number) => shareCode(index + 1);
  const pages = Array.from({ length: 65 }, (_, index) => ({
    id: pageId(index), url: `https://www.notion.so/${pageId(index)}`,
    parent: { type: "data_source_id", data_source_id: "source" },
    properties: {
      ...idProperty(index + 1),
      "标题翻译": { type: "rich_text", rich_text: [{ plain_text: `文章${index}` }] },
      "正文翻译": { type: "rich_text", rich_text: [{ plain_text: "正文" }] },
    },
  }));
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("/views/")) return Response.json({ data_source_id: "source" });
    const query = JSON.parse(String(init?.body));
    if (query.filter?.unique_id) return Response.json({ results: [pages[query.filter.unique_id.equals - 1]], has_more: false });
    const start = Number(query.start_cursor ?? 0);
    const end = Math.min(start + query.page_size, pages.length);
    return Response.json({ results: pages.slice(start, end), has_more: end < pages.length, next_cursor: end < pages.length ? String(end) : null });
  }) as typeof fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const env = { NOTION_TOKEN: "test", NOTION_EXCERPTS_DATA_SOURCE_ID: "source", NOTION_EXCERPTS_VIEW_ID: "view" };
  for (const [page, count, hasMore] of [[1, 30, true], [2, 60, true], [3, 65, false]] as const) {
    const response = await worker.fetch(new Request(`https://example.com/api/read?tab=weekly&page=${page}`), env);
    const list = await response.json<import("../src/reader-data.ts").ReaderList>();
    assert.equal(list.items.length, count);
    assert.equal(list.hasMore, hasMore);
  }
  const detail = await worker.fetch(new Request(`https://example.com/api/r/${code(40)}?tab=weekly&page=2`), env);
  const article = await detail.json<import("../src/reader-data.ts").ReaderArticle>();
  assert.equal(article.actions?.nextCode, code(41));
});

test("article and share APIs resolve the Notion ID property", async (context) => {
  const originalFetch = globalThis.fetch;
  const pageId = "408e75a1-639c-8152-ab6f-f35a59ab2d27";
  const queries: unknown[] = [];
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const query = JSON.parse(String(init?.body));
    queries.push(query);
    return Response.json({
      results: query.filter?.unique_id?.equals === 42 ? [{
        id: pageId,
        url: `https://www.notion.so/${pageId}`,
        properties: {
          ...idProperty(42),
          "标题翻译": { type: "rich_text", rich_text: [{ plain_text: "标题" }] },
          "正文翻译": { type: "rich_text", rich_text: [{ plain_text: "正文" }] },
        },
      }] : [],
      has_more: false,
    });
  }) as typeof fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const env = { NOTION_TOKEN: "test", NOTION_EXCERPTS_DATA_SOURCE_ID: "source" };
  const lookup = { page_size: 1, filter: { property: "ID", unique_id: { equals: 42 } } };
  for (const prefix of ["r", "s"]) {
    const response = await worker.fetch(new Request(`https://example.com/api/${prefix}/${shareCode(42)}`), env);
    assert.equal(response.status, 200);
    const article = await response.json<import("../src/reader-data.ts").ReaderArticle>();
    assert.equal(article.item.title, "标题");
    assert.equal(article.actions === null, prefix === "s");
    const missing = await worker.fetch(new Request(`https://example.com/api/${prefix}/${shareCode(7)}`), env);
    assert.equal(missing.status, 404);
  }
  assert.deepEqual(queries[0], lookup);
  assert.deepEqual(queries[2], lookup);
});

test("share codes round-trip, look unrelated for consecutive IDs, and reject guesses", () => {
  const codes = new Set<string>();
  for (const id of [1, 2, 3, 4, 5, 1000, 2 ** 20 - 1]) {
    const code = shareCode(id);
    assert.match(code, /^[0-9A-Za-z]{6}$/);
    assert.equal(shareCodeId(code), id);
    codes.add(code);
  }
  assert.equal(codes.size, 7);
  assert.notEqual(shareCode(1).slice(0, 3), shareCode(2).slice(0, 3));
  assert.equal(shareCodeId("abc"), null);
  assert.equal(shareCodeId("abc-ef"), null);

  let accepted = 0;
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  for (let i = 0; i < 20000; i++) {
    let guess = "";
    for (let j = 0; j < 6; j++) guess += alphabet[(i * 7919 + j * 104729 + i * j * 31) % 62];
    if (shareCodeId(guess) !== null) accepted++;
  }
  assert.ok(accepted < 50, `${accepted} of 20000 guesses decoded to an ID`);
});

test("excerpt image proxy serves images referenced by the displayed body fields", async (context) => {
  const pageId = "408e75a1-639c-8152-ab6f-f35a59ab2d27";
  const blockId = "28324ab7-0534-48a3-8fbe-fed8e055041d";
  const fileId = "8c289a44-4d96-46f6-a6ee-1d6374101e7e";
  const token = globalThis.fetch;
  let referenced = true;
  let standalone = false;
  let correctParent = true;
  let mode: "translated" | "chinese" | "original" = "translated";
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    if (String(url).includes("/pages/")) {
      const useOriginal = mode !== "translated";
      const field = useOriginal ? "正文" : "正文翻译";
      return Response.json({
        parent: { type: "data_source_id", data_source_id: correctParent ? "source" : "other" },
        properties: {
          "原文语言": { type: "select", select: { name: mode === "chinese" ? "中文" : "日文" } },
          [field]: { type: "rich_text", rich_text: [{ plain_text: referenced ? `<image source="notion-file-block://${blockId}/${fileId}" ${standalone ? ">" : "/>"}` : "无图片" }] },
          ...(mode === "original" ? { "正文翻译": { type: "rich_text", rich_text: [{ plain_text: "译文" }] } } : {}),
        },
      });
    }
    if (String(url).includes("/blocks/")) return Response.json({ type: "image", parent: { type: "page_id", page_id: pageId }, image: { type: "file", file: { url: "https://files.example/image.jpg" } } });
    return new Response("image bytes", { headers: { "Content-Type": "image/jpeg" } });
  }) as typeof fetch;
  context.after(() => { globalThis.fetch = token; });
  const url = `https://example.com/read/p/${pageId}/${blockId}`;
  const env = { NOTION_TOKEN: "test", NOTION_EXCERPTS_DATA_SOURCE_ID: "source" };
  const response = await worker.fetch(new Request(url), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "image/jpeg");
  assert.equal(await response.text(), "image bytes");
  assert.equal((await worker.fetch(new Request(url, { method: "HEAD" }), env)).status, 200);
  standalone = true;
  assert.equal((await worker.fetch(new Request(url), env)).status, 200);
  referenced = false;
  assert.equal((await worker.fetch(new Request(url), env)).status, 404);
  referenced = true;
  mode = "original";
  assert.equal((await worker.fetch(new Request(url), env)).status, 200);
  mode = "chinese";
  assert.equal((await worker.fetch(new Request(url), env)).status, 200);
  correctParent = false;
  assert.equal((await worker.fetch(new Request(url), env)).status, 404);
  assert.equal((await worker.fetch(new Request("https://example.com/read/p/invalid/invalid"), env)).status, 404);
});
