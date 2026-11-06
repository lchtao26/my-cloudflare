import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { parseRssFeed } from "feedsmith";
import { formatText } from "../src/format-text.ts";
import worker, {
  bookFromPage,
  excerptFromPage,
  neighborsFor,
  renderEinkDetail,
  renderEinkList,
  renderExcerptFeed,
  renderFeed,
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

test("RSS item has exactly the requested fields and escapes XML", () => {
  const book = bookFromPage(page);
  assert.ok(book);
  assert.equal(book.pubDate?.toISOString(), "2026-10-01T08:00:00.000Z");
  const feed = renderFeed([book], "https://example.workers.dev/book/rss");
  assert.match(feed, /<link>\s*<!\[CDATA\[https:\/\/book\.douban\.com\/subject\/123\/\?a=1&b=2\]\]>/);
  assert.match(feed, /<title>\s*<!\[CDATA\[甲 & 乙\]\]>/);
  assert.match(feed, /<!\[CDATA\[作者：张三 \| 写过 &amp; 小说<br \/>\n简介：一部 &lt;书&gt;<br \/>\n出版社：三联 &amp; 书店<br \/>\n<img src="https:\/\/example\.workers\.dev\/book\/p\/book-1" alt="封面" \/>\]\]>/);
  const withoutIntro = bookFromPage({ ...page, properties: { ...page.properties, "作者介绍": { type: "rich_text", rich_text: [] } } });
  assert.match(renderFeed(withoutIntro ? [withoutIntro] : [], "https://example.workers.dev/book/rss"), /作者：张三<br \/>/);
  assert.doesNotMatch(renderFeed(withoutIntro ? [withoutIntro] : [], "https://example.workers.dev/book/rss"), /作者：张三 \|/);
  assert.doesNotMatch(feed, /书名：|width=|style=|<category>|files\.example|来源：/);
  assert.match(feed, /<guid isPermaLink="false">notion:book-1<\/guid>/);
  assert.match(feed, /<atom:link href="https:\/\/example\.workers\.dev\/book\/rss" rel="self" type="application\/rss\+xml"\/>/);
  assert.match(feed, /<language>zh-CN<\/language>/);
  const withoutCover = bookFromPage({ ...page, properties: { ...page.properties, "封面": { type: "files", files: [] } } });
  assert.equal(withoutCover?.hasCover, false);
  assert.doesNotMatch(renderFeed(withoutCover ? [withoutCover] : [], "https://example.workers.dev/book/rss"), /<img /);
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
  const feed = renderFeed([sourced], "https://example.workers.dev/book/rss");
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
  const plainFeed = renderFeed([plain], "https://example.workers.dev/book/rss");
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
  const response = await worker.fetch(new Request("https://example.workers.dev/book/rss"), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type") ?? "", /application\/rss\+xml/);
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=300, must-revalidate");
  assert.equal((await response.text()).match(/<item>/g)?.length, 2);
  assert.deepEqual(requests[0]?.sorts, [{ timestamp: "last_edited_time", direction: "descending" }]);
  assert.equal(requests[1]?.start_cursor, "next");

  const head = await worker.fetch(new Request("https://example.workers.dev/book/rss", { method: "HEAD" }), env);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const method = await worker.fetch(new Request("https://example.workers.dev/book/rss", { method: "POST" }), env);
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("Allow"), "GET, HEAD");
});

test("both feeds query and render only the first 30 records, preserving their order", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const env = { NOTION_TOKEN: "test", NOTION_DATA_SOURCE_ID: "source", NOTION_EXCERPTS_DATA_SOURCE_ID: "source", NOTION_EXCERPTS_VIEW_ID: "view" };
  for (const path of ["/book/rss", "/read/rss"]) {
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
          properties: { ...page.properties, "正文翻译": { type: "rich_text", rich_text: [{ plain_text: "正文" }] } },
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
      "简介": { type: "rich_text", rich_text: [{ plain_text: `正文版本 ${revision}` }] },
      "标题翻译": { type: "rich_text", rich_text: [{ plain_text: `标题版本 ${revision}` }] },
      "正文翻译": { type: "rich_text", rich_text: [{ plain_text: `正文版本 ${revision}` }] },
    } }], has_more: false });
  }) as typeof fetch;
  const env = { NOTION_TOKEN: "test", NOTION_DATA_SOURCE_ID: "source", NOTION_EXCERPTS_DATA_SOURCE_ID: "source", NOTION_EXCERPTS_VIEW_ID: "view" };
  const cases = [
    { path: "/book/rss", marker: "正文版本" },
    { path: "/read/rss", marker: "标题版本" },
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
  const request = new Request("https://example.workers.dev/book/rss");
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
  const response = await worker.fetch(new Request("https://example.workers.dev/read/rss"), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type") ?? "", /application\/rss\+xml/);
  const feed = await response.text();
  const parsed = parseRssFeed(feed);
  assert.equal(parsed.title, "阅读节选");
  assert.equal(parsed.items?.length, 2);
  const item = parsed.items?.[0];
  assert.equal(item?.title, "第一节 & 开始");
  assert.equal(item?.link, "https://example.workers.dev/read/d/407e75a1-639c-81ca-8919-f4bff2a57884");
  assert.equal(item?.guid?.value, "notion:407e75a1-639c-81ca-8919-f4bff2a57884");
  assert.equal(item?.description, undefined);
  assert.doesNotMatch(feed, /<item>[\s\S]*?<description>|一行 &lt;文字&gt;|阅读原文|名词解释/);
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
  assert.equal((await worker.fetch(new Request("https://example.workers.dev/read/rss"), {
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

  const response = await worker.fetch(new Request("https://example.workers.dev/read/rss"), {
    NOTION_TOKEN: "test",
    NOTION_EXCERPTS_DATA_SOURCE_ID: "excerpt-source",
    NOTION_EXCERPTS_VIEW_ID: viewId,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(bodies[0]?.sorts, savedSort);
});

test("excerpt titles fall back to the original and missing source fields are omitted", () => {
  const excerpt = excerptFromPage({
    id: "1", url: "https://www.notion.so/1", properties: {
      "标题": { type: "title", title: [{ plain_text: "节" }] },
      "标题翻译": { type: "rich_text", rich_text: [{ plain_text: " \n " }] },
      "正文翻译": { type: "rich_text", rich_text: [{ plain_text: "正文" }] },
      "出处": { type: "rich_text", rich_text: [{ plain_text: "书" }] },
      "原文链接": { type: "url", url: "javascript:alert(1)" },
    },
  });
  assert.ok(excerpt);
  const feed = renderExcerptFeed([excerpt], "https://example.com/read/rss");
  const item = parseRssFeed(feed).items?.[0];
  assert.equal(item?.title, "节");
  assert.equal(item?.description, undefined);
  const detail = renderEinkDetail(excerpt, "/read", "https://example.com/read/p");
  assert.match(detail, /<p><cite>书<\/cite><\/p>\n<div class="excerpt-body" lang="zh-CN">\n<p>正文<\/p>/);
  assert.doesNotMatch(detail, /作者：|出版方：|章节：|内容类型：|名词解释|阅读原文|javascript:/);
});

test("detail pages preserve paragraphs from newlines and stored br tags while escaping other HTML", () => {
  for (const separator of ["\n\n", "\r\n \r\n", "\r\r", "<br /><br />", "<BR><br/>"]) {
    const excerpt = excerptFromPage({
      id: "paragraphs", url: "https://www.notion.so/paragraphs", properties: {
        "标题翻译": { type: "rich_text", rich_text: [{ plain_text: "中文标题" }] },
        "正文翻译": { type: "rich_text", rich_text: [{ plain_text: `第一段${separator}第二段\n段内换行<script>alert(1)</script><br onmouseover="alert(1)"> & ]]>` }] },
      },
    });
    assert.ok(excerpt);
    assert.equal(parseRssFeed(renderExcerptFeed([excerpt], "https://example.com/read/rss")).items?.[0]?.title, "中文标题");
    const detail = renderEinkDetail(excerpt, "/read", "https://example.com/read/p");
    const main = detail.match(/<main>([\s\S]*)<\/main>/)?.[1] ?? "";
    assert.match(detail, /<p>第一段<\/p>\n<p>第二段<br \/>\n段内换行&lt;script&gt;alert \(1\)&lt;\/script&gt;&lt;br onmouseover=&quot;alert\(1\)&quot;&gt; &amp; \]\]&gt;<\/p>/);
    // User body stays escaped; detail pages may include a small tap-to-scroll script outside main.
    assert.doesNotMatch(main, /<script|<br onmouseover|&lt;br\s*\/?&gt;/);
  }
});

test("magazine and web excerpts use neutral source labels and link to e-ink detail pages", () => {
  for (const contentType of ["杂志", "网页文章"]) {
    const excerpt = excerptFromPage({
      id: "article", url: "https://www.notion.so/article", properties: {
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
    const item = parseRssFeed(renderExcerptFeed([excerpt], "https://example.com/read/rss")).items?.[0];
    assert.equal(item?.link, "https://example.com/read/d/article");
    assert.equal(item?.guid?.value, "notion:article");
    assert.equal(item?.description, undefined);
    const detail = renderEinkDetail(excerpt, "/read", "https://example.com/read/p");
    assert.match(detail, /出版方：媒体/);
    assert.doesNotMatch(detail, /内容类型：|书名：|出版社：/);
  }
});

test("excerpts without translated content, identity, or a valid Notion link are excluded", () => {
  const translated: NotionPage = {
    id: "1", url: "https://www.notion.so/1", properties: {
      "正文翻译": { type: "rich_text", rich_text: [{ plain_text: "正文" }] },
    },
  };
  assert.equal(excerptFromPage(translated)?.title, "无标题");
  assert.equal(excerptFromPage({ ...translated, id: undefined }), null);
  assert.equal(excerptFromPage({ ...translated, url: "javascript:alert(1)" }), null);
  assert.equal(excerptFromPage({ ...translated, properties: {} }), null);
  assert.equal(excerptFromPage({ ...translated, properties: { "正文翻译": { type: "rich_text", rich_text: [{ plain_text: "\n  " }] } } }), null);
  assert.equal(excerptFromPage({
    id: "zh",
    url: "https://www.notion.so/zh",
    properties: {
      "原文语言": { type: "select", select: { name: "中文" } },
      "正文翻译": { type: "rich_text", rich_text: [{ plain_text: "旧译文" }] },
    },
  }), null);
});

test("Chinese excerpts use the original title and body, not translations", () => {
  const chinese: NotionPage = {
    id: "zh", url: "https://www.notion.so/zh", properties: {
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
  const item = parseRssFeed(renderExcerptFeed([excerpt], "https://example.com/read/rss")).items?.[0];
  assert.equal(item?.title, "中文标题");
  assert.equal(item?.description, undefined);
  const detail = renderEinkDetail(excerpt, "/read", "https://example.com/read/p");
  assert.match(detail, /<html lang="zh-CN">/);
  assert.match(detail, /:lang\(zh\)\{font-family:"Songti SC"/);
  assert.doesNotMatch(detail, /Source Han Serif/);
  assert.match(detail, /中文正文/);
  assert.doesNotMatch(detail, /不应使用|不应输出的译文/);
  assert.equal(excerptFromPage({
    ...chinese,
    properties: { ...chinese.properties, "原文语言": { type: "select", select: { name: "日文" } }, "正文翻译": { type: "rich_text", rich_text: [] } },
  }), null);
});

test("Comic excerpts use the original title and body, not translations", () => {
  const comic: NotionPage = {
    id: "comic", url: "https://www.notion.so/comic", properties: {
      "标题": { type: "title", title: [{ plain_text: "《漫画》第189話" }] },
      "标题翻译": { type: "rich_text", rich_text: [{ plain_text: "不应使用" }] },
      "正文": { type: "rich_text", rich_text: [{ plain_text: "漫画正文图片" }] },
      "正文翻译": { type: "rich_text", rich_text: [{ plain_text: "不应输出的译文" }] },
      "原文语言": { type: "select", select: { name: "日文" } },
      "内容形态": { type: "select", select: { name: "漫画" } },
      "出处": { type: "rich_text", rich_text: [{ plain_text: "週刊文春" }] },
      "原文链接": { type: "url", url: "https://example.com/comic" },
    },
  };
  const excerpt = excerptFromPage(comic);
  assert.ok(excerpt);
  assert.equal(excerpt.title, "《漫画》第189話");
  assert.equal(excerpt.body, "漫画正文图片");
  assert.equal(excerpt.chinese, false);
  assert.equal(excerpt.lang, "ja");
  assert.equal(excerpt.titleLang, "ja");
  assert.equal(excerpt.originalLang, "ja");
  const item = parseRssFeed(renderExcerptFeed([excerpt], "https://example.com/read/rss")).items?.[0];
  assert.equal(item?.title, "《漫画》第 189 話");
  assert.equal(item?.description, undefined);
  const detail = renderEinkDetail(excerpt, "/read", "https://example.com/read/p");
  assert.match(detail, /<html lang="zh-CN">/);
  assert.match(detail, /<h1 lang="ja">/);
  assert.match(detail, /<div class="excerpt-body" lang="ja">/);
  assert.match(detail, /:lang\(ja\)\{font-family:"Hiragino Mincho ProN"/);
  assert.match(detail, /漫画正文图片/);
  assert.doesNotMatch(detail, /不应使用|不应输出的译文/);
  assert.equal(excerptFromPage({
    ...comic,
    properties: {
      ...comic.properties,
      "内容形态": { type: "select", select: { name: "书籍节选" } },
      "正文翻译": { type: "rich_text", rich_text: [] },
    },
  }), null);
});

test("translated excerpts keep original titles in their source language and controls in Chinese", () => {
  for (const [language, lang, title] of [
    ["日文", "ja", "読書と思考 <script>"],
    ["英文", "en", "Reading & thinking"],
  ]) {
    const page: NotionPage = {
      id: "407e75a1-639c-81ca-8919-f4bff2a57884",
      url: "https://www.notion.so/excerpt",
      properties: {
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
    const detail = renderEinkDetail(excerpt, "/read", "/read/p");
    assert.match(detail, /<html lang="zh-CN">/);
    assert.match(detail, new RegExp(`<h1 lang="${lang}">`));
    assert.match(detail, /<div class="excerpt-body" lang="zh-CN">\n<p>中文译文<\/p>/);
    if (lang === "ja") assert.match(detail, /&lt;script&gt;<\/h1>/);
    assert.match(renderEinkList([excerpt], "/read"), new RegExp(`<li [^>]*lang="${lang}"`));

    page.properties!["标题翻译"] = { type: "rich_text", rich_text: [{ plain_text: "阅读与思考" }] };
    const translated = excerptFromPage(page);
    assert.ok(translated);
    assert.equal(translated.titleLang, "zh-CN");
    const translatedDetail = renderEinkDetail(translated, "/read", "/read/p");
    assert.match(translatedDetail, /<h1 lang="zh-CN">阅读与思考<\/h1>/);
    assert.match(translatedDetail, new RegExp(`阅读原文：<span lang="${lang}">`));
    if (lang === "ja") assert.match(translatedDetail, /&lt;script&gt;<\/span>/);

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
    new Request("https://example.workers.dev/read/rss"),
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
  assert.equal(item?.link, `https://example.workers.dev/read/d/${pageId}`);
  assert.equal(requests.some((href) => href.includes("/blocks/")), false);
});

test("detail pages turn excerpt image tags into proxied images while unrelated HTML stays escaped", () => {
  const pageId = "408e75a1-639c-8152-ab6f-f35a59ab2d27";
  const blockId = "28324ab7-0534-48a3-8fbe-fed8e055041d";
  const fileId = "8c289a44-4d96-46f6-a6ee-1d6374101e7e";
  const translation = `前文<br /><br /><image source="notion-file-block://${blockId}/${fileId}?name=photo.jpg" /><br /><br />后文 <script>x</script>`;
  const excerpt = excerptFromPage({ id: pageId, url: "https://notion.so/page", properties: { "正文翻译": { type: "rich_text", rich_text: [{ plain_text: translation }] } } });
  assert.ok(excerpt);
  const detail = renderEinkDetail(excerpt, "/read", "https://example.com/read/p");
  assert.match(detail, new RegExp(`<img src="https://example.com/read/p/${pageId}/${blockId}" alt="正文图片" />`));
  assert.match(detail, /前文<\/p>\n<p><img/);
  assert.match(detail, /<p>后文 &lt;script&gt;x&lt;\/script&gt;<\/p>/);
  assert.doesNotMatch(detail, /notion-file-block/);
});

test("detail pages render plain http img tags and escape unsafe ones", () => {
  const pageId = "408e75a1-639c-8152-ab6f-f35a59ab2d27";
  const translation = [
    `<img src="https://cdn.sanity.io/images/cover.png">`,
    `<img src='http://cdn.example.com/later.jpg' alt="later" />`,
    `<img src="javascript:alert(1)" />`,
    `<script>x</script>`,
  ].join("<br /><br />");
  const excerpt = excerptFromPage({
    id: pageId,
    url: "https://notion.so/page",
    properties: { "正文翻译": { type: "rich_text", rich_text: [{ plain_text: translation }] } },
  });
  assert.ok(excerpt);
  const detail = renderEinkDetail(excerpt, "/read", "https://example.com/read/p");
  assert.match(detail, /<img src="https:\/\/cdn\.sanity\.io\/images\/cover\.png" alt="正文图片" \/>/);
  assert.match(detail, /<img src="http:\/\/cdn\.example\.com\/later\.jpg" alt="正文图片" \/>/);
  assert.match(detail, /&lt;img src=&quot;javascript:alert\(1\)&quot; \/&gt;/);
  assert.match(detail, /&lt;script&gt;x&lt;\/script&gt;/);
});

test("detail pages turn captioned notion image wrappers into proxied images and ignore caption text", () => {
  const pageId = "408e75a1-639c-8152-ab6f-f35a59ab2d27";
  const blockId = "1a52e0b5-2ddd-4438-8257-9e6c5a426940";
  const fileId = "69d14bc7-c973-4ee7-9123-bde234614e89";
  const translation = [
    `<image source="notion-file-block://${blockId}/${fileId}?space_id=e9cde029-df5b-4155-b1ef-e48feea5c573&name=bunshun-93076-img1.jpg">`,
    "©文藝春秋",
    "</image>",
  ].join("\n");
  const excerpt = excerptFromPage({ id: pageId, url: "https://notion.so/page", properties: { "正文翻译": { type: "rich_text", rich_text: [{ plain_text: translation }] } } });
  assert.ok(excerpt);
  const detail = renderEinkDetail(excerpt, "/read", "https://example.com/read/p");
  assert.match(detail, new RegExp(`<img src="https://example.com/read/p/${pageId}/${blockId}" alt="正文图片" />`));
  assert.doesNotMatch(detail, /©文藝春秋|notion-file-block|<image|<\/image>/);
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
    "标题翻译": { type: "rich_text", rich_text: [{ plain_text: "“AI时代的RSS”" }] },
    "正文翻译": { type: "rich_text", rich_text: [{ plain_text: "使用API处理2026年数据。" }] },
    "出处": { type: "rich_text", rich_text: [{ plain_text: "Cloudflare Workers" }] },
  } });
  assert.ok(excerpt);
  const item = parseRssFeed(renderExcerptFeed([excerpt], "https://example.com/read/rss")).items?.[0];
  assert.equal(item?.title, "「AI 时代的 RSS」");
  assert.equal(item?.description, undefined);
  assert.equal(item?.link, `https://example.com/read/d/${pageId}`);
  const book = bookFromPage({ ...page, properties: {
    ...page.properties,
    "书名": { type: "title", title: [{ plain_text: "“AI时代的RSS”" }] },
    "简介": { type: "rich_text", rich_text: [{ plain_text: "保留API与2026年之间的原始排版 & <文字>" }] },
  } });
  assert.ok(book);
  const bookItem = parseRssFeed(renderFeed([book], "https://example.com/book/rss")).items?.[0];
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
  const item = parseRssFeed(renderExcerptFeed([excerpt], "https://example.com/read/rss")).items?.[0];
  assert.equal(item?.description, `<img src="https://example.com/read/p/${pageId}/${blockId}" alt="正文图片" />`);
  assert.doesNotMatch(item?.description ?? "", new RegExp(secondBlock));
});

test("RSS description uses the earliest plain img or notion image in the body", () => {
  const pageId = "408e75a1-639c-8152-ab6f-f35a59ab2d27";
  const blockId = "28324ab7-0534-48a3-8fbe-fed8e055041d";
  const fileId = "8c289a44-4d96-46f6-a6ee-1d6374101e7e";
  const feedUrl = "https://example.com/read/rss";

  const withImg = excerptFromPage({
    id: pageId,
    url: "https://notion.so/page",
    properties: {
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

test("e-ink list uses the RSS view and links to detail pages", async (context) => {
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

  const response = await worker.fetch(
    new Request("https://example.workers.dev/read"),
    {
      NOTION_TOKEN: "test",
      NOTION_EXCERPTS_DATA_SOURCE_ID: "excerpt-source",
      NOTION_EXCERPTS_VIEW_ID: viewId,
    },
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type") ?? "", /text\/html/);
  const html = await response.text();
  assert.match(html, /<title>阅读节选<\/title>/);
  assert.match(html, new RegExp(`href="/read/d/${pageId}"`));
  assert.match(html, new RegExp(`<li id="${pageId}" lang="zh-CN" tabindex="-1">`));
  assert.match(html, /AI 时代的 RSS/);
  assert.match(html, /科技 News · 作者：张三 AI/);
  assert.equal(requests[0]?.url, `https://api.notion.com/v1/views/${viewId}`);
  assert.equal((await worker.fetch(new Request("https://example.workers.dev/read"), {
    NOTION_TOKEN: "test",
    NOTION_EXCERPTS_DATA_SOURCE_ID: "excerpt-source",
  })).status, 503);
});

test("e-ink categories filter the view and preserve navigation context", async (context) => {
  const originalFetch = globalThis.fetch;
  const pageId = "407e75a1-639c-81ca-8919-f4bff2a57884";
  const nextId = "408e75a1-639c-8152-ab6f-f35a59ab2d27";
  const makePage = (id: string) => ({
    id, url: `https://www.notion.so/${id}`,
    parent: { type: "data_source_id", data_source_id: "source" },
    properties: {
      "标题翻译": { type: "rich_text", rich_text: [{ plain_text: id }] },
      "正文翻译": { type: "rich_text", rich_text: [{ plain_text: "正文" }] },
    },
  });
  const queries: Array<{ filter?: object }> = [];
  const viewFilter = { property: "正文翻译", rich_text: { is_not_empty: true } };
  const favoritesFilter = { property: "收藏", checkbox: { equals: true } };
  const favoritesSorts = [{ property: "发布日期", direction: "descending" }];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.endsWith("/views/saved-view")) {
      return Response.json({ data_source_id: "source", filter: favoritesFilter, sorts: favoritesSorts });
    }
    if (href.includes("/views/")) return Response.json({ data_source_id: "source", filter: viewFilter });
    if (href.includes("/pages/")) return Response.json(makePage(pageId));
    queries.push(JSON.parse(String(init?.body)));
    return Response.json({ results: [makePage(pageId), makePage(nextId)], has_more: false });
  }) as typeof fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const env = {
    NOTION_TOKEN: "test",
    NOTION_EXCERPTS_DATA_SOURCE_ID: "source",
    NOTION_EXCERPTS_VIEW_ID: "view",
    NOTION_EXCERPTS_FAVORITES_VIEW_ID: "saved-view",
  };
  for (const [category, label, marker] of [
    ["weekly", "周刊", "bunshun.jp/denshiban/articles/"],
    ["bunshun", "文春", "bunshun.jp/articles/"],
    ["novel", "小说", "epub"],
    ["news", "新闻", "news.ycombinator.com"],
  ]) {
    const response = await worker.fetch(new Request(`https://example.com/read?tab=${category}`), env);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, new RegExp(`aria-current="page">${label}</a>`));
    assert.match(html, new RegExp(`/read/d/${pageId}\\?tab=${category}`));
    assert.match(JSON.stringify(queries.at(-1)?.filter), new RegExp(marker.replaceAll(".", "\\.")));
    assert.match(JSON.stringify(queries.at(-1)?.filter), /正文翻译/);
    if (category === "weekly" || category === "bunshun") {
      assert.deepEqual(queries.at(-1)?.filter, { and: [viewFilter, { or: [
        { property: "原文链接", url: { contains: marker } },
        { property: "备注", rich_text: { contains: marker } },
      ] }] });
    }
  }
  const detail = await worker.fetch(new Request(`https://example.com/read/d/${pageId}?tab=weekly`, {
    headers: { Referer: "https://example.com/read?tab=weekly" },
  }), env);
  const html = await detail.text();
  assert.match(html, new RegExp(`/read\\?tab=weekly#${pageId}`));
  assert.match(html, new RegExp(`/read/d/${nextId}\\?tab=weekly`));
  assert.match(JSON.stringify(queries.at(-1)?.filter), /bunshun\.jp\/denshiban\/articles\//);

  const fallback = await worker.fetch(new Request("https://example.com/read?tab=unknown"), env);
  const fallbackHtml = await fallback.text();
  assert.match(fallbackHtml, /aria-current="page">全部<\/a>/);
  assert.match(fallbackHtml, /<a href="\/read\?tab=likes">收藏<\/a>/);
  assert.deepEqual(queries.at(-1)?.filter, viewFilter);

  const favorites = await worker.fetch(new Request("https://example.com/read?tab=likes"), env);
  assert.equal(favorites.status, 200);
  assert.match(await favorites.text(), /aria-current="page">收藏<\/a>/);
  assert.deepEqual(queries.at(-1), { page_size: 31, filter: favoritesFilter, sorts: favoritesSorts });

  const favoriteDetail = await worker.fetch(new Request(`https://example.com/read/d/${pageId}?tab=likes`, {
    headers: { Referer: "https://example.com/read?tab=likes" },
  }), env);
  const favoriteHtml = await favoriteDetail.text();
  assert.match(favoriteHtml, new RegExp(`/read\\?tab=likes#${pageId}`));
  assert.match(favoriteHtml, new RegExp(`/read/d/${nextId}\\?tab=likes`));
  assert.deepEqual(queries.at(-1), { page_size: 30, filter: favoritesFilter, sorts: favoritesSorts });

  const rss = await worker.fetch(new Request("https://example.com/read/rss?tab=likes"), env);
  assert.equal(rss.status, 200);
  assert.deepEqual(queries.at(-1)?.filter, viewFilter);
});

test("e-ink list loads more within its category and keeps the expanded list on return", async (context) => {
  const originalFetch = globalThis.fetch;
  const pageId = (index: number) => `407e75a1-639c-81ca-8919-${String(index).padStart(12, "0")}`;
  const pages = Array.from({ length: 65 }, (_, index) => ({
    id: pageId(index), url: `https://www.notion.so/${pageId(index)}`,
    parent: { type: "data_source_id", data_source_id: "source" },
    properties: {
      "标题翻译": { type: "rich_text", rich_text: [{ plain_text: `文章${index}` }] },
      "正文翻译": { type: "rich_text", rich_text: [{ plain_text: "正文" }] },
    },
  }));
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("/views/")) return Response.json({ data_source_id: "source" });
    if (href.includes("/pages/")) return Response.json(pages[40]);
    const query = JSON.parse(String(init?.body));
    const start = Number(query.start_cursor ?? 0);
    const end = Math.min(start + query.page_size, pages.length);
    return Response.json({ results: pages.slice(start, end), has_more: end < pages.length, next_cursor: end < pages.length ? String(end) : null });
  }) as typeof fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const env = { NOTION_TOKEN: "test", NOTION_EXCERPTS_DATA_SOURCE_ID: "source", NOTION_EXCERPTS_VIEW_ID: "view" };
  const get = async (path: string, headers?: HeadersInit) => (await worker.fetch(new Request(`https://example.com${path}`, { headers }), env)).text();
  const first = await get("/read?tab=weekly");
  assert.equal((first.match(/<li id=/g) ?? []).length, 30);
  assert.match(first, /tab=weekly&amp;page=2[^\"]*">加载更多/);
  const second = await get("/read?tab=weekly&page=2");
  assert.equal((second.match(/<li id=/g) ?? []).length, 60);
  assert.match(second, /tab=weekly&amp;page=3[^\"]*">加载更多/);
  assert.match(second, new RegExp(`/read/d/${pageId(40)}\\?tab=weekly&amp;page=2`));
  const detail = await get(`/read/d/${pageId(40)}?tab=weekly&page=2`, {
    Referer: "https://example.com/read?tab=weekly&page=2",
  });
  assert.match(detail, new RegExp(`/read\\?tab=weekly&amp;page=2#${pageId(40)}`));
  assert.match(detail, new RegExp(`/read/d/${pageId(41)}\\?tab=weekly&amp;page=2`));
  const last = await get("/read?tab=weekly&page=3");
  assert.equal((last.match(/<li id=/g) ?? []).length, 65);
  assert.doesNotMatch(last, />加载更多<\/a>/);
});

test("e-ink list displays every category without interaction", () => {
  const html = renderEinkList([], "/read");
  assert.match(html, /<h1>阅读节选<\/h1>/);
  for (const [href, label] of [
    ["/read", "全部"],
    ["/read?tab=weekly", "周刊"],
    ["/read?tab=bunshun", "文春"],
    ["/read?tab=novel", "小说"],
    ["/read?tab=news", "新闻"],
    ["/read?tab=likes", "收藏"],
  ]) {
    assert.ok(html.includes(`href="${href}"`), `${label} link is visible`);
  }
  const navigation = html.match(/<nav class="categories"[\s\S]*?<\/nav>/)?.[0];
  assert.ok(navigation);
  assert.doesNotMatch(navigation, /hidden/);
  assert.deepEqual(Array.from(navigation.matchAll(/<a [^>]*>([^<]+)<\/a>/g), (match) => match[1]),
    ["全部", "收藏", "新闻", "周刊", "文春", "小说"]);
});

test("e-ink list updates its return anchor only for normal article navigation", () => {
  const html = renderEinkList([], "/read");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  let activate: (event: object) => void = () => assert.fail("click listener was not registered");
  const state = { existing: "preserved" };
  const replacements: Array<{ state: unknown; url: string }> = [];
  const history = {
    state,
    replaceState(nextState: unknown, _title: string, url: string) {
      replacements.push({ state: nextState, url });
    },
  };
  const location = { pathname: "/read", search: "?source=rss", hash: "#older-article" };
  const scrollCalls: Array<{ block?: string } | boolean> = [];
  const targetRow = {
    scrollIntoView(arg: { block?: string } | boolean) { scrollCalls.push(arg); },
  };
  runInNewContext(script, {
    window: { history, location, addEventListener() {} }, history, location,
    document: {
      addEventListener(_event: string, handler: typeof activate) { activate = handler; },
      getElementById(id: string) { return id === "older-article" ? targetRow : null; },
    },
  });
  assert.equal(scrollCalls.length, 1);
  assert.equal(JSON.stringify(scrollCalls[0]), JSON.stringify({ block: "center" }));
  const link = {
    tagName: "A", className: "item-link", target: "", hasAttribute: () => false,
    parentNode: { tagName: "LI", id: "newer-article" },
  };
  const click = { target: { parentNode: link }, button: 0 };
  activate(click);
  assert.deepEqual(replacements, [{ state, url: "/read?source=rss#newer-article" }]);

  for (const modifier of ["ctrlKey", "metaKey", "shiftKey", "altKey", "defaultPrevented"]) {
    activate({ ...click, [modifier]: true });
  }
  activate({ ...click, button: 1 });
  activate({ ...click, target: { ...link, target: "_blank" } });
  assert.equal(replacements.length, 1);
  // Browsers without the History API still render ordinary working links.
  assert.doesNotThrow(() => runInNewContext(script, { window: {} }));
});

test("e-ink list pages only when the blank margins are tapped", () => {
  const html = renderEinkList([], "/read");
  const scripts = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g), (match) => match[1]);
  const script = scripts[1];
  assert.ok(script);
  const handlers = new Map<string, (event: object) => void>();
  const scrolls: number[] = [];
  const body = {};
  const root = {};
  const main = { getBoundingClientRect: () => ({ left: 300, right: 700 }) };
  let now = 1000;
  let selected = false;
  let desktop = false;
  const document = {
    body, documentElement: root,
    querySelector: () => main,
    addEventListener: (name: string, handler: (event: object) => void) => handlers.set(name, handler),
  };
  runInNewContext(script, {
    document,
    window: {
      innerHeight: 600,
      matchMedia: () => ({ matches: desktop }),
      scrollBy: (_x: number, y: number) => scrolls.push(y),
      getSelection: () => ({ rangeCount: 1, isCollapsed: !selected }),
    },
    Date: { now: () => now },
  });
  const dispatch = (name: string, event: object) => {
    const handler = handlers.get(name);
    assert.ok(handler);
    handler(event);
  };
  const click = (x: number, target: object = body, extra: object = {}) =>
    dispatch("click", { target, clientX: x, button: 0, ...extra });
  const startTouch = (x: number, target: object = body) =>
    dispatch("touchstart", { target, touches: [{ clientX: x, clientY: 200 }] });
  const endTouch = (x: number, target: object = body) => {
    let prevented = false;
    dispatch("touchend", {
      target, touches: [], changedTouches: [{ clientX: x, clientY: 200 }], cancelable: true,
      preventDefault() { prevented = true; },
    });
    return prevented;
  };

  click(100, body, { pointerType: "mouse" });
  desktop = true;
  click(900, root);
  desktop = false;
  assert.deepEqual(scrolls, []);
  click(100, body, { pointerType: "touch" });
  click(900, root, { pointerType: "touch" });
  click(500);
  click(100, { tagName: "A" });
  click(900, body, { ctrlKey: true });
  assert.deepEqual(scrolls, [-600, 600]);

  startTouch(900);
  assert.equal(endTouch(900), true);
  click(900);
  assert.deepEqual(scrolls, [-600, 600, 600], "the synthetic click must not scroll twice");
  now += 801;
  desktop = true;
  startTouch(100);
  assert.equal(endTouch(100), true, "touch still works on devices with a mouse");
  desktop = false;
  now += 801;
  startTouch(100);
  dispatch("touchmove", { touches: [{ clientX: 100, clientY: 250 }] });
  assert.equal(endTouch(100), false);
  now += 801;
  startTouch(100);
  now += 701;
  assert.equal(endTouch(100), false);
  now += 801;
  selected = true;
  startTouch(100);
  selected = false;
  assert.equal(endTouch(100), false);
  now += 801;
  startTouch(500);
  assert.equal(endTouch(500), false);
  assert.deepEqual(scrolls, [-600, 600, 600, -600]);
});

test("e-ink detail renders linked metadata on every device and reuses the image proxy", async (context) => {
  const originalFetch = globalThis.fetch;
  const pageId = "407e75a1-639c-81ca-8919-f4bff2a57884";
  const blockId = "28324ab7-0534-48a3-8fbe-fed8e055041d";
  const fileId = "8c289a44-4d96-46f6-a6ee-1d6374101e7e";
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    const href = String(url);
    if (href.includes(`/pages/${pageId}`)) {
      return Response.json({
        id: pageId,
        url: "https://www.notion.so/excerpt-1",
        parent: { type: "data_source_id", data_source_id: "excerpt-source" },
        properties: {
          "标题": { type: "title", title: [{ plain_text: "Original & title" }] },
          "标题翻译": { type: "rich_text", rich_text: [{ plain_text: "详情标题" }] },
          "正文翻译": { type: "rich_text", rich_text: [{ plain_text: `第一段<br /><br /><image source="notion-file-block://${blockId}/${fileId}" /><br /><br />第二段` }] },
          "出处": { type: "rich_text", rich_text: [{ plain_text: "某书" }] },
          "作者": { type: "rich_text", rich_text: [{ plain_text: "张三" }] },
          "出版方": { type: "rich_text", rich_text: [{ plain_text: "某出版社" }] },
          "章节": { type: "rich_text", rich_text: [{ plain_text: "第一章" }] },
          "发布日期": { type: "date", date: { start: "2025-06-12" } },
          "专有名词与术语": { type: "rich_text", rich_text: [{ plain_text: "术语 A<br />释义" }] },
          "原文链接": { type: "url", url: "https://example.com/original" },
        },
      });
    }
    throw new Error(`Unexpected fetch: ${href}`);
  }) as typeof fetch;
  context.after(() => { globalThis.fetch = originalFetch; });

  const response = await worker.fetch(
    new Request(`https://example.workers.dev/read/d/${pageId}`),
    { NOTION_TOKEN: "test", NOTION_EXCERPTS_DATA_SOURCE_ID: "excerpt-source" },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=300, must-revalidate");
  assert.equal(response.headers.get("Vary"), "Referer");
  const html = await response.text();
  assert.match(html, /<body class="detail">/);
  assert.doesNotMatch(html, /eink-weight/);
  assert.match(html, /<title>详情标题<\/title>/);
  assert.equal(html.match(/<nav class="nav-row" hidden>/g)?.length, 2);
  assert.match(html, /<p><cite>某书<\/cite> · 作者：张三<\/p>/);
  assert.match(html, /第一段/);
  assert.match(html, /第二段/);
  assert.match(html, /阅读原文：<a [^>]*lang="zh-CN" href="https:\/\/example\.com\/original">Original &amp; title<\/a>/);
  assert.match(html, /出版方：某出版社/);
  assert.match(html, /章节：第一章/);
  assert.match(html, /<span [^>]*role="button" tabindex="0" aria-controls="data-source"[^>]*>发布日期：2025-06-12<\/span><span id="data-source" hidden><br \/>数据来源：<a [^>]*href="https:\/\/www\.notion\.so\/excerpt-1">Notion<\/a><\/span>/);
  assert.match(html, new RegExp(`src="https://example\\.workers\\.dev/read/p/${pageId}/${blockId}"`));
  assert.match(html, /名词解释/);
  assert.match(html, /术语 A/);
  assert.doesNotMatch(html, /相关链接|class="actions"/);
  assert.doesNotMatch(html, /@media \(update: slow\)/);

  for (const userAgent of ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", "Mozilla/5.0 (Linux; Kindle) Silk/3.0"]) {
    const deviceResponse = await worker.fetch(
      new Request(`https://example.workers.dev/read/d/${pageId}`, { headers: { "User-Agent": userAgent } }),
      { NOTION_TOKEN: "test", NOTION_EXCERPTS_DATA_SOURCE_ID: "excerpt-source" },
    );
    assert.equal(await deviceResponse.text(), html);
  }

  assert.equal((await worker.fetch(
    new Request("https://example.workers.dev/read/d/not-a-page-id"),
    { NOTION_TOKEN: "test", NOTION_EXCERPTS_DATA_SOURCE_ID: "excerpt-source" },
  )).status, 404);
});

test("e-ink render helpers escape content and omit empty metadata", () => {
  const pageId = "407e75a1-639c-81ca-8919-f4bff2a57884";
  const list = renderEinkList([{
    id: pageId,
    title: "甲 & 乙",
    originalTitle: "甲 & 乙",
    body: "正文",
    chinese: false,
    lang: "zh-CN",
    titleLang: "zh-CN",
    originalLang: "zh-CN",
    terms: "",
    sourceTitle: "",
    author: "",
    chapter: "",
    publisher: "",
    originalUrl: null,
    publishedDate: "",
    link: "https://www.notion.so/1",
    pubDate: null,
  }], "/read");
  assert.match(list, /甲 &amp; 乙/);
  assert.match(list, new RegExp(`<li id="${pageId}" lang="zh-CN" tabindex="-1">`));
  assert.doesNotMatch(list, /作者：|class="meta"/);

  const detail = renderEinkDetail({
    id: pageId,
    title: "标题",
    originalTitle: "标题",
    body: "一段 <文字>",
    chinese: false,
    lang: "zh-CN",
    titleLang: "zh-CN",
    originalLang: "zh-CN",
    terms: "",
    sourceTitle: "It's",
    author: "作者",
    chapter: "",
    publisher: "",
    originalUrl: "https://example.com/original",
    publishedDate: "",
    link: "https://www.notion.so/1",
    pubDate: null,
  }, "/read", "https://example.com/read/p", { prevId: null, nextId: null });
  assert.match(detail, /一段 &lt;文字&gt;/);
  assert.match(detail, /<cite>It&#39;s<\/cite>/);
  assert.match(detail, new RegExp(`href="/read#${pageId}"[^>]*>返回列表`));
  assert.match(detail, /class="is-disabled">上一篇</);
  assert.match(detail, /class="is-disabled">下一篇</);
  assert.match(detail, /阅读原文：<a [^>]*href="https:\/\/example\.com\/original">标题<\/a>/);
  assert.match(detail, />发布日期：—<\/span>/);
  assert.doesNotMatch(detail, /名词解释/);
});

test("e-ink detail nav links previous and next excerpts beside back to list", () => {
  const first = "407e75a1-639c-81ca-8919-f4bff2a57884";
  const middle = "408e75a1-639c-8152-ab6f-f35a59ab2d27";
  const last = "409e75a1-639c-81ca-8919-f4bff2a57886";
  const stub = (id: string): Parameters<typeof renderEinkDetail>[0] => ({
    id,
    title: id,
    originalTitle: id,
    body: "正文",
    chinese: false,
    lang: "zh-CN",
    titleLang: "zh-CN",
    originalLang: "zh-CN",
    terms: "",
    sourceTitle: "",
    author: "",
    chapter: "",
    publisher: "",
    originalUrl: null,
    publishedDate: "",
    link: `https://www.notion.so/${id}`,
    pubDate: null,
  });
  assert.deepEqual(neighborsFor([stub(first), stub(middle), stub(last)], middle), {
    prevId: first,
    nextId: last,
  });
  const html = renderEinkDetail(stub(middle), "/read", "https://example.com/read/p", {
    prevId: first,
    nextId: last,
  });
  assert.match(html, new RegExp(`href="/read/d/${first}"[^>]*>上一篇`));
  assert.match(html, new RegExp(`href="/read#${middle}"[^>]*>返回列表`));
  assert.match(html, new RegExp(`href="/read/d/${last}"[^>]*>下一篇`));
  assert.doesNotMatch(html, /阅读原文：|@media \(update: slow\)/);
});

test("e-ink detail shows navigation by source and keeps hidden links available", async (context) => {
  const originalFetch = globalThis.fetch;
  const viewId = "excerpt-view";
  const first = "407e75a1-639c-81ca-8919-f4bff2a57884";
  const middle = "408e75a1-639c-8152-ab6f-f35a59ab2d27";
  const last = "409e75a1-639c-81ca-8919-f4bff2a57886";
  const pageJson = (id: string, title: string) => ({
    id,
    url: `https://www.notion.so/${id}`,
    parent: { type: "data_source_id", data_source_id: "excerpt-source" },
    properties: {
      "标题翻译": { type: "rich_text", rich_text: [{ plain_text: title }] },
      "正文翻译": { type: "rich_text", rich_text: [{ plain_text: "正文" }] },
    },
  });
  let viewRequests = 0;
  let viewUnavailable = false;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.includes(`/pages/${middle}`)) return Response.json(pageJson(middle, "中间"));
    if (href.includes(`/views/${viewId}`)) {
      viewRequests++;
      if (viewUnavailable) return new Response(null, { status: 503 });
      return Response.json({ data_source_id: "excerpt-source", filter: null, quick_filters: {}, sorts: [] });
    }
    if (init?.method === "POST" && href.includes("/data_sources/excerpt-source/query")) {
      return Response.json({
        results: [pageJson(first, "一"), pageJson(middle, "二"), pageJson(last, "三")],
        has_more: false,
      });
    }
    throw new Error(`Unexpected fetch: ${href}`);
  }) as typeof fetch;
  context.after(() => { globalThis.fetch = originalFetch; });

  const origin = "https://example.workers.dev";
  const env = {
    NOTION_TOKEN: "test",
    NOTION_EXCERPTS_DATA_SOURCE_ID: "excerpt-source",
    NOTION_EXCERPTS_VIEW_ID: viewId,
  };
  const open = async (referer?: string) => {
    const response = await worker.fetch(new Request(`${origin}/read/d/${middle}`, {
      headers: referer ? { Referer: referer } : {},
    }), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Vary"), "Referer");
    return response.text();
  };
  for (const source of [`${origin}/read`, `${origin}/read/d/${first}`]) {
    const html = await open(source);
    assert.equal(html.match(/<nav class="nav-row">/g)?.length, 2);
    assert.match(html, new RegExp(`href="/read/d/${first}"[^>]*>上一篇`));
    assert.match(html, new RegExp(`href="/read/d/${last}"[^>]*>下一篇`));
  }
  assert.equal(viewRequests, 2);

  for (const source of [undefined, "https://other.example/read", `${origin}/read/rss`, "invalid referrer"]) {
    const html = await open(source);
    assert.equal(html.match(/<nav class="nav-row" hidden>/g)?.length, 2);
    assert.match(html, /<p>正文<\/p>/);
    assert.match(html, new RegExp(`href="/read/d/${first}"[^>]*>上一篇`));
    assert.match(html, new RegExp(`href="/read/d/${last}"[^>]*>下一篇`));
  }
  assert.equal(viewRequests, 6);

  viewUnavailable = true;
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const html = await open();
    assert.match(html, /<p>正文<\/p>/);
    assert.equal(html.match(/<nav class="nav-row" hidden>/g)?.length, 2);
    assert.match(html, /class="is-disabled">上一篇/);
    assert.match(html, /class="is-disabled">下一篇/);
  } finally {
    console.error = originalConsoleError;
  }
});

test("e-ink detail taps left to scroll up and right to scroll down", () => {
  const pageId = "408e75a1-639c-8152-ab6f-f35a59ab2d27";
  const html = renderEinkDetail({
    id: pageId,
    title: "标题",
    originalTitle: "标题",
    body: "正文",
    chinese: false,
    lang: "zh-CN",
    titleLang: "zh-CN",
    originalLang: "zh-CN",
    terms: "",
    sourceTitle: "",
    author: "",
    chapter: "",
    publisher: "",
    originalUrl: null,
    publishedDate: "",
    link: "https://www.notion.so/1",
    pubDate: null,
  }, "/read", "https://example.com/read/p");
  assert.doesNotMatch(html, /class="pager"|向上|向下/);
  assert.match(html, /window\.scrollBy\(0,dir\*step\(\)\)/);
  assert.match(html, /clientX[\s\S]*innerWidth\/2/);
  assert.match(html, /tagName==='A'/);
  assert.match(html, /class="progress"/);
  assert.match(html, /id="progress-bar"/);
  assert.match(html, /localStorage\.setItem\(key,String\(scrollRatio\(\)\)\)/);
  assert.match(html, /localStorage\.getItem\(key\)/);
  assert.match(html, /eink-progress:/);
  assert.match(html, /saveSoon[\s\S]*setTimeout[\s\S]*400/);
  assert.match(html, /pagehide',saveNow/);

  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
  assert.ok(script);
  function setupPaging(desktop: boolean, pointerEvents = true) {
    const handlers = new Map<string, (event: object) => void>();
    const scrolls: number[] = [];
    const body = {};
    const dateAttributes = new Map([["aria-expanded", "false"]]);
    const dateKeyHandlers = new Map<string, (event: object) => void>();
    const navigation = [{ hidden: true }, { hidden: true }];
    const dateControl = {
      tagName: "SPAN",
      parentNode: body,
      setAttribute: (name: string, value: string) => dateAttributes.set(name, value),
      removeAttribute: (name: string) => dateAttributes.delete(name),
      addEventListener(name: string, handler: (event: object) => void) { dateKeyHandlers.set(name, handler); },
    };
    const dataSource = { hidden: true };
    const target = (tagName: string) => tagName === "SPAN" ? dateControl : { tagName, parentNode: body };
    let selected = false;
    let now = 1000;
    const document = {
      body, documentElement: { scrollHeight: 2000 },
      getElementById: (id: string) => id === "published-date" ? dateControl : id === "data-source" ? dataSource : null,
      querySelectorAll: () => navigation,
      addEventListener(name: string, handler: (event: object) => void) { handlers.set(name, handler); },
    };
    const window = {
      innerHeight: 600, innerWidth: 1000, scrollY: 0,
      PointerEvent: pointerEvents ? class {} : undefined,
      getSelection: () => ({ rangeCount: 1, isCollapsed: !selected }),
      matchMedia: () => ({ matches: desktop }),
      scrollBy: (_x: number, y: number) => scrolls.push(y),
      addEventListener: () => {},
    };
    runInNewContext(script, {
      window, document, location: { pathname: `/read/d/${pageId}` },
      Date: { now: () => now },
      localStorage: { getItem: () => null, setItem: () => {} },
    });
    function dispatch(name: string, event: object) {
      const handler = handlers.get(name);
      assert.ok(handler, `${name} listener was not registered`);
      handler(event);
    }
    return {
      scrolls,
      dataSource,
      navigation,
      dateAttributes,
      pressDateKey(key: string) {
        let prevented = false;
        const event = { key, preventDefault() { prevented = true; } };
        dateKeyHandlers.get("keydown")?.(event);
        dateKeyHandlers.get("keyup")?.(event);
        return prevented;
      },
      selectText(value: boolean) { selected = value; },
      advance(milliseconds: number) { now += milliseconds; },
      startPointer() { dispatch("pointerdown", {}); },
      startTouch(x = 750, y = 200) { dispatch("touchstart", { touches: [{ clientX: x, clientY: y }] }); },
      moveTouch(x: number, y: number) { dispatch("touchmove", { touches: [{ clientX: x, clientY: y }] }); },
      endTouch(x = 750, y = 200, tagName = "P") {
        let prevented = false;
        dispatch("touchend", {
          target: target(tagName),
          touches: [], changedTouches: [{ clientX: x, clientY: y }],
          cancelable: true, preventDefault() { prevented = true; },
        });
        return prevented;
      },
      click(pointerType?: string, tagName = "P", clientX = 750) {
        dispatch("click", { target: target(tagName), clientX, pointerType });
      },
    };
  }

  const desktop = setupPaging(true);
  desktop.click();
  desktop.click("touch");
  assert.deepEqual(desktop.scrolls, []);

  const touch = setupPaging(false);
  touch.click("mouse");
  touch.click(undefined, "A");
  touch.click("touch", "SPAN");
  assert.deepEqual(touch.scrolls, []);

  for (const pointerEvents of [true, false]) {
    const paging = setupPaging(false, pointerEvents);
    paging.startPointer();
    paging.selectText(true);
    paging.click("touch");
    assert.deepEqual(paging.scrolls, [], "a long press may still dispatch a click");

    paging.startPointer();
    paging.selectText(false);
    paging.click("touch");
    assert.deepEqual(paging.scrolls, [], "the dismissing tap can clear the selection before click");

    paging.startPointer();
    paging.click("touch");
    paging.startPointer();
    paging.click("touch", "P", 250);
    assert.deepEqual(paging.scrolls, [600, -600]);
  }

  for (const pointerEvents of [true, false]) {
    const paging = setupPaging(false, pointerEvents);
    paging.startTouch();
    assert.equal(paging.endTouch(), true, "paging suppresses the subsequent native click");
    paging.click("mouse");
    assert.deepEqual(paging.scrolls, [600], "a touch and its synthetic click scroll only once");

    paging.startTouch(250);
    paging.endTouch(250);
    assert.deepEqual(paging.scrolls, [600, -600]);

    paging.startTouch();
    paging.moveTouch(750, 250);
    assert.equal(paging.endTouch(750, 250), false);
    paging.click("touch");
    assert.deepEqual(paging.scrolls, [600, -600], "swiping does not trigger paging");

    paging.startTouch();
    paging.advance(800);
    paging.endTouch();
    assert.deepEqual(paging.scrolls, [600, -600], "a long press does not trigger paging");

    paging.selectText(true);
    paging.startTouch();
    paging.selectText(false);
    assert.equal(paging.endTouch(), false);
    paging.click("mouse");
    assert.deepEqual(paging.scrolls, [600, -600], "dismissing a selection does not trigger paging");

    paging.startTouch();
    assert.equal(paging.endTouch(750, 200, "A"), false);
    assert.deepEqual(paging.scrolls, [600, -600], "links keep their native behavior");
  }

  const sourceReveal = setupPaging(false);
  function tapDate() {
    sourceReveal.startTouch();
    assert.equal(sourceReveal.endTouch(750, 200, "SPAN"), false, "the date tap still produces a click");
    sourceReveal.click("touch", "SPAN");
    sourceReveal.advance(100);
  }
  tapDate();
  sourceReveal.advance(1000);
  tapDate();
  tapDate();
  assert.equal(sourceReveal.dataSource.hidden, true, "a pause breaks the sequence");
  sourceReveal.click("touch", "A");
  tapDate();
  tapDate();
  assert.equal(sourceReveal.dataSource.hidden, true, "an intervening click breaks the sequence");
  tapDate();
  assert.equal(sourceReveal.dataSource.hidden, false);
  assert.deepEqual(sourceReveal.navigation.map(({ hidden }) => hidden), [false, false]);
  assert.equal(sourceReveal.dateAttributes.get("aria-expanded"), "true");
  assert.deepEqual(sourceReveal.scrolls, [], "tapping the date does not page");

  const keyboardReveal = setupPaging(true);
  keyboardReveal.pressDateKey("Enter");
  assert.equal(keyboardReveal.pressDateKey(" "), true, "Space on the date does not scroll");
  assert.equal(keyboardReveal.dataSource.hidden, true);
  keyboardReveal.pressDateKey("Enter");
  assert.equal(keyboardReveal.dataSource.hidden, false);
  assert.deepEqual(keyboardReveal.navigation.map(({ hidden }) => hidden), [false, false]);

  const hybrid = setupPaging(true);
  hybrid.startTouch();
  hybrid.endTouch();
  assert.deepEqual(hybrid.scrolls, [600], "touch works on devices with a mouse or trackpad");
});

test("e-ink detail pangues all visible text without changing image proxy URLs", () => {
  const pageId = "408e75a1-639c-8152-ab6f-f35a59ab2d27";
  const blockId = "28324ab7-0534-48a3-8fbe-fed8e055041d";
  const fileId = "8c289a44-4d96-46f6-a6ee-1d6374101e7e";
  const html = renderEinkDetail({
    id: pageId,
    title: "AI时代的RSS",
    originalTitle: "Hello世界",
    body: `“使用API处理2026年数据。\n\n<image source="notion-file-block://${blockId}/${fileId}">图片说明“<br /><br />文字</image>\n\n结束。”`,
    chinese: false,
    lang: "zh-CN",
    titleLang: "zh-CN",
    originalLang: "en",
    terms: "API接口\nApplication Programming Interface",
    sourceTitle: "Cloudflare Workers",
    author: "张三AI",
    chapter: "Chapter1章节",
    publisher: "ABC出版社",
    originalUrl: "https://example.com/original",
    publishedDate: "2025-06-12",
    link: "https://www.notion.so/1",
    pubDate: null,
  }, "/read", "https://example.com/read/p");
  assert.match(html, /<title>AI 时代的 RSS<\/title>/);
  assert.match(html, /<h1 lang="zh-CN">AI 时代的 RSS<\/h1>/);
  assert.match(html, /作者：张三 AI/);
  assert.match(html, /使用 API 处理 2026 年数据/);
  assert.match(html, /<p>「使用 API 处理 2026 年数据。<\/p>/);
  assert.match(html, /<p>结束。」<\/p>/);
  assert.match(html, /阅读原文：<a [^>]*lang="en"[^>]*>Hello 世界<\/a>/);
  assert.match(html, /出版方：ABC 出版社/);
  assert.match(html, /章节：Chapter1 章节/);
  assert.match(html, /名词解释/);
  assert.match(html, /API 接口/);
  assert.match(html, new RegExp(`src="https://example\\.com/read/p/${pageId}/${blockId}"`));
  assert.doesNotMatch(html, /https:\/\/example\.com \/book|AI时代的RSS|使用API处理|Hello世界|ABC出版社|张三AI/);
});

test("excerpt image proxy serves only images referenced by the language body field", async (context) => {
  const pageId = "408e75a1-639c-8152-ab6f-f35a59ab2d27";
  const blockId = "28324ab7-0534-48a3-8fbe-fed8e055041d";
  const fileId = "8c289a44-4d96-46f6-a6ee-1d6374101e7e";
  const token = globalThis.fetch;
  let referenced = true;
  let correctParent = true;
  let mode: "translated" | "chinese" | "comic" = "translated";
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    if (String(url).includes("/pages/")) {
      const useOriginal = mode !== "translated";
      const field = useOriginal ? "正文" : "正文翻译";
      return Response.json({
        parent: { type: "data_source_id", data_source_id: correctParent ? "source" : "other" },
        properties: {
          "原文语言": { type: "select", select: { name: mode === "chinese" ? "中文" : "日文" } },
          ...(mode === "comic" ? { "内容形态": { type: "select", select: { name: "漫画" } } } : {}),
          [field]: { type: "rich_text", rich_text: [{ plain_text: referenced ? `<image source="notion-file-block://${blockId}/${fileId}" />` : "无图片" }] },
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
  referenced = false;
  assert.equal((await worker.fetch(new Request(url), env)).status, 404);
  referenced = true;
  mode = "chinese";
  assert.equal((await worker.fetch(new Request(url), env)).status, 200);
  mode = "comic";
  assert.equal((await worker.fetch(new Request(url), env)).status, 200);
  correctParent = false;
  assert.equal((await worker.fetch(new Request(url), env)).status, 404);
  assert.equal((await worker.fetch(new Request("https://example.com/read/p/invalid/invalid"), env)).status, 404);
});
