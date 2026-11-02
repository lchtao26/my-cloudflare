import assert from "node:assert/strict";
import test from "node:test";
import { parseRssFeed } from "feedsmith";
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
  assert.doesNotMatch(feed, /<item>[\s\S]*?<description>|一行 &lt;文字&gt;|阅读原文|专有名词与术语/);
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
  assert.match(detail, /<p><cite>书<\/cite><\/p>\n<p>正文<\/p>/);
  assert.doesNotMatch(detail, /作者：|出版方：|章节：|原标题：|内容类型：|专有名词与术语|阅读原文|javascript:/);
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
  const item = parseRssFeed(renderExcerptFeed([excerpt], "https://example.com/read/rss")).items?.[0];
  assert.equal(item?.title, "中文标题");
  assert.equal(item?.description, undefined);
  const detail = renderEinkDetail(excerpt, "/read", "https://example.com/read/p");
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
  const item = parseRssFeed(renderExcerptFeed([excerpt], "https://example.com/read/rss")).items?.[0];
  assert.equal(item?.title, "《漫画》第189話");
  assert.equal(item?.description, undefined);
  const detail = renderEinkDetail(excerpt, "/read", "https://example.com/read/p");
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

test("RSS preserves original title spacing; book feed still escapes description content", () => {
  const pageId = "408e75a1-639c-8152-ab6f-f35a59ab2d27";
  const excerpt = excerptFromPage({ id: pageId, url: "https://notion.so/page", properties: {
    "标题翻译": { type: "rich_text", rich_text: [{ plain_text: "AI时代的RSS" }] },
    "正文翻译": { type: "rich_text", rich_text: [{ plain_text: "使用API处理2026年数据。" }] },
    "出处": { type: "rich_text", rich_text: [{ plain_text: "Cloudflare Workers" }] },
  } });
  assert.ok(excerpt);
  const item = parseRssFeed(renderExcerptFeed([excerpt], "https://example.com/read/rss")).items?.[0];
  assert.equal(item?.title, "AI时代的RSS");
  assert.equal(item?.description, undefined);
  assert.equal(item?.link, `https://example.com/read/d/${pageId}`);
  const book = bookFromPage({ ...page, properties: {
    ...page.properties,
    "书名": { type: "title", title: [{ plain_text: "AI时代的RSS" }] },
    "简介": { type: "rich_text", rich_text: [{ plain_text: "保留API与2026年之间的原始排版 & <文字>" }] },
  } });
  assert.ok(book);
  const bookItem = parseRssFeed(renderFeed([book], "https://example.com/book/rss")).items?.[0];
  assert.equal(bookItem?.title, "AI时代的RSS");
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
          "标题翻译": { type: "rich_text", rich_text: [{ plain_text: "第一节" }] },
          "正文翻译": { type: "rich_text", rich_text: [{ plain_text: "正文" }] },
          "出处": { type: "rich_text", rich_text: [{ plain_text: "某书" }] },
          "作者": { type: "rich_text", rich_text: [{ plain_text: "张三" }] },
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
  assert.match(html, new RegExp(`<li id="${pageId}" tabindex="-1">`));
  assert.match(html, /li:target/);
  assert.match(html, /第一节/);
  assert.match(html, /某书 · 作者：张三/);
  assert.equal(requests[0]?.url, `https://api.notion.com/v1/views/${viewId}`);
  assert.equal((await worker.fetch(new Request("https://example.workers.dev/read"), {
    NOTION_TOKEN: "test",
    NOTION_EXCERPTS_DATA_SOURCE_ID: "excerpt-source",
  })).status, 503);
});

test("e-ink detail renders body metadata, action buttons, and reuses the image proxy", async (context) => {
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
  const html = await response.text();
  assert.match(html, /<title>详情标题<\/title>/);
  assert.match(html, new RegExp(`href="/read#${pageId}"`));
  assert.match(html, /class="nav-row"/);
  assert.match(html, /上一篇/);
  assert.match(html, /下一篇/);
  assert.match(html, /@media \(update: slow\)\{\.actions\{display:none/);
  assert.match(html, /<p><cite>某书<\/cite> · 作者：张三<\/p>/);
  assert.match(html, /第一段/);
  assert.match(html, /第二段/);
  assert.match(html, /原标题：Original &amp; title/);
  assert.match(html, /出版方：某出版社/);
  assert.match(html, /章节：第一章/);
  assert.match(html, /发布日期：2025-06-12/);
  assert.match(html, new RegExp(`src="https://example\\.workers\\.dev/read/p/${pageId}/${blockId}"`));
  assert.match(html, /专有名词与术语/);
  assert.match(html, /术语 A/);
  assert.match(html, /class="btn"[^>]*href="https:\/\/example\.com\/original"/);
  assert.match(html, /class="btn"[^>]*href="https:\/\/www\.notion\.so\/excerpt-1"/);
  assert.match(html, /阅读原文/);
  assert.match(html, /在 Notion 中查看/);
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
  assert.match(list, new RegExp(`<li id="${pageId}" tabindex="-1">`));
  assert.doesNotMatch(list, /作者：|class="meta"/);

  const detail = renderEinkDetail({
    id: pageId,
    title: "标题",
    originalTitle: "标题",
    body: "一段 <文字>",
    chinese: false,
    terms: "",
    sourceTitle: "出处",
    author: "作者",
    chapter: "",
    publisher: "",
    originalUrl: "https://example.com/original",
    publishedDate: "",
    link: "https://www.notion.so/1",
    pubDate: null,
  }, "/read", "https://example.com/read/p");
  assert.match(detail, /一段 &lt;文字&gt;/);
  assert.match(detail, new RegExp(`href="/read#${pageId}"[^>]*>返回列表`));
  assert.match(detail, /class="is-disabled">上一篇</);
  assert.match(detail, /class="is-disabled">下一篇</);
  assert.match(detail, /class="btn"[^>]*href="https:\/\/example\.com\/original"/);
  assert.match(detail, /class="btn"[^>]*href="https:\/\/www\.notion\.so\/1"/);
  assert.match(detail, /阅读原文/);
  assert.match(detail, /在 Notion 中查看/);
  assert.doesNotMatch(detail, /专有名词与术语|原标题：/);
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
  assert.match(html, /@media \(update: slow\)\{\.actions\{display:none/);
});

test("e-ink detail loads view neighbors for article navigation", async (context) => {
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
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.includes(`/pages/${middle}`)) return Response.json(pageJson(middle, "中间"));
    if (href.includes(`/views/${viewId}`)) {
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

  const response = await worker.fetch(
    new Request(`https://example.workers.dev/read/d/${middle}`),
    {
      NOTION_TOKEN: "test",
      NOTION_EXCERPTS_DATA_SOURCE_ID: "excerpt-source",
      NOTION_EXCERPTS_VIEW_ID: viewId,
    },
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, new RegExp(`href="/read/d/${first}"[^>]*>上一篇`));
  assert.match(html, new RegExp(`href="/read/d/${last}"[^>]*>下一篇`));
});

test("e-ink detail taps left to scroll up and right to scroll down", () => {
  const pageId = "408e75a1-639c-8152-ab6f-f35a59ab2d27";
  const html = renderEinkDetail({
    id: pageId,
    title: "标题",
    originalTitle: "标题",
    body: "正文",
    chinese: false,
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
});

test("e-ink detail pangues all visible text without changing image proxy URLs", () => {
  const pageId = "408e75a1-639c-8152-ab6f-f35a59ab2d27";
  const blockId = "28324ab7-0534-48a3-8fbe-fed8e055041d";
  const fileId = "8c289a44-4d96-46f6-a6ee-1d6374101e7e";
  const html = renderEinkDetail({
    id: pageId,
    title: "AI时代的RSS",
    originalTitle: "Hello世界",
    body: `使用API处理2026年数据。\n\n<image source="notion-file-block://${blockId}/${fileId}" />`,
    chinese: false,
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
  assert.match(html, /<h1>AI 时代的 RSS<\/h1>/);
  assert.match(html, /作者：张三 AI/);
  assert.match(html, /使用 API 处理 2026 年数据/);
  assert.match(html, /原标题：Hello 世界/);
  assert.match(html, /出版方：ABC 出版社/);
  assert.match(html, /章节：Chapter1 章节/);
  assert.match(html, /专有名词与术语/);
  assert.match(html, /API 接口/);
  assert.match(html, /在 Notion 中查看/);
  assert.match(html, /阅读原文/);
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
