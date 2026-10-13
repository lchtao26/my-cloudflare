const NOTION_VERSION = "2026-03-11";
const FEED_TITLE = "书籍推荐";
const FEED_DESCRIPTION = "来自 Notion「书籍推荐」的书目 RSS";

function xml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function textProperty(properties, name) {
  const property = properties?.[name];
  if (property?.type !== "title" && property?.type !== "rich_text") return "";
  return (property[property.type] ?? []).map((part) => part.plain_text ?? part.text?.content ?? "").join("").trim();
}

function externalUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

export function bookFromPage(page) {
  const properties = page?.properties ?? {};
  const title = textProperty(properties, "书名");
  const link = externalUrl(properties["豆瓣 / 亚马逊"]?.url) ?? externalUrl(page?.url);
  if (!title || !link || !page?.id) return null;

  const description = [
    `书名：${title}`,
    `作者：${textProperty(properties, "作者")}`,
    `简介：${textProperty(properties, "简介")}`,
  ].join("\n");

  const date = new Date(page.last_edited_time ?? page.created_time);
  return {
    id: page.id,
    title,
    link,
    description,
    pubDate: Number.isNaN(date.getTime()) ? null : date.toUTCString(),
  };
}

export function renderFeed(books, feedUrl) {
  const items = books.map((book) => `    <item>
      <title>${xml(book.title)}</title>
      <link>${xml(book.link)}</link>
      <guid isPermaLink="false">notion:${xml(book.id)}</guid>
      <description>${xml(book.description)}</description>${book.pubDate ? `
      <pubDate>${xml(book.pubDate)}</pubDate>` : ""}
    </item>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xml(FEED_TITLE)}</title>
    <link>${xml(feedUrl)}</link>
    <atom:link href="${xml(feedUrl)}" rel="self" type="application/rss+xml" />
    <description>${xml(FEED_DESCRIPTION)}</description>
    <language>zh-CN</language>
${items}
  </channel>
</rss>`;
}

async function fetchBooks(env) {
  const books = [];
  let cursor;

  do {
    const response = await fetch(`https://api.notion.com/v1/data_sources/${encodeURIComponent(env.NOTION_DATA_SOURCE_ID)}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        page_size: 100,
        sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
        ...(cursor ? { start_cursor: cursor } : {}),
      }),
    });

    if (!response.ok) {
      throw new Error(`Notion API returned ${response.status}`);
    }

    const data = await response.json();
    for (const page of data.results ?? []) {
      const book = bookFromPage(page);
      if (book) books.push(book);
    }
    cursor = data.has_more ? data.next_cursor : null;
    if (data.has_more && !cursor) throw new Error("Notion returned an incomplete page without a cursor");
  } while (cursor);

  return books;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/book-express-rss") {
      return new Response("Not found", { status: 404 });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    if (!env.NOTION_TOKEN || !env.NOTION_DATA_SOURCE_ID) {
      return new Response("Feed is not configured", { status: 503 });
    }

    try {
      const books = await fetchBooks(env);
      const feedUrl = `${url.origin}${url.pathname}`;
      return new Response(request.method === "HEAD" ? null : renderFeed(books, feedUrl), {
        headers: {
          "Content-Type": "application/rss+xml; charset=utf-8",
          "Cache-Control": "public, max-age=300",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      console.error("Failed to build book RSS", error);
      return new Response("Feed temporarily unavailable", { status: 502 });
    }
  },
};
