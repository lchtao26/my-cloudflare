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

function rssDescription(value) {
  return xml(value).replaceAll("\n", "<br>\n");
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

function coverFileUrl(page) {
  const files = page?.properties?.["封面"]?.files;
  if (!Array.isArray(files)) return null;
  for (const file of files) {
    const url = file?.type === "external" ? file.external?.url : file?.type === "file" ? file.file?.url : null;
    const href = externalUrl(url);
    if (href) return href;
  }
  return null;
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
    hasCover: coverFileUrl(page) !== null,
    pubDate: Number.isNaN(date.getTime()) ? null : date.toUTCString(),
  };
}

function itemDescription(book, feedUrl) {
  const text = rssDescription(book.description);
  if (!book.hasCover) return text;
  const src = `${feedUrl}/cover/${encodeURIComponent(book.id)}`;
  return `<img src="${xml(src)}" alt="封面" /><br>\n${text}`;
}

export function renderFeed(books, feedUrl) {
  const items = books.map((book) => `    <item>
      <title>${xml(book.title)}</title>
      <link>${xml(book.link)}</link>
      <guid isPermaLink="false">notion:${xml(book.id)}</guid>
      <description>${itemDescription(book, feedUrl)}</description>${book.pubDate ? `
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

const NOTION_PAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FEED_PATH = "/book-express-rss";

function coverIdFromPath(pathname) {
  const match = pathname.match(/^\/book-express-rss\/cover\/([^/]+)$/);
  return match && NOTION_PAGE_ID.test(match[1]) ? match[1] : null;
}

async function fetchCover(env, pageId) {
  const response = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
    },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Notion API returned ${response.status}`);

  const imageUrl = coverFileUrl(await response.json());
  if (!imageUrl) return null;
  const image = await fetch(imageUrl);
  if (!image.ok) throw new Error(`Cover image returned ${image.status}`);
  const contentType = image.headers.get("Content-Type") ?? "";
  if (!contentType.startsWith("image/")) throw new Error("Cover image has an unexpected content type");
  return new Response(image.body, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const coverId = coverIdFromPath(url.pathname);
    if (url.pathname !== FEED_PATH && !coverId) {
      return new Response("Not found", { status: 404 });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    if (!env.NOTION_TOKEN || !env.NOTION_DATA_SOURCE_ID) {
      return new Response("Feed is not configured", { status: 503 });
    }

    try {
      if (coverId) {
        const cover = await fetchCover(env, coverId);
        if (!cover) return new Response("Not found", { status: 404 });
        return request.method === "HEAD" ? new Response(null, { status: cover.status, headers: cover.headers }) : cover;
      }

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
      console.error(coverId ? "Failed to load book cover" : "Failed to build book RSS", error);
      return new Response(coverId ? "Cover temporarily unavailable" : "Feed temporarily unavailable", { status: 502 });
    }
  },
};
