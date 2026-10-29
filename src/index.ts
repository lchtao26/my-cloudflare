import { generateRssFeed, type RssFeed } from "feedsmith";

const NOTION_VERSION = "2026-03-11";
const FEED_TITLE = "书籍推荐";
const FEED_DESCRIPTION = "来自 Notion「书籍推荐」的书目 RSS";
const NOTION_PAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FEED_PATH = "/book-express-rss";
const EXCERPT_FEED_PATH = "/book-excerpts-rss";

type RichText = { plain_text?: string; text?: { content?: string } };

type NotionFile = {
  name?: string;
  type?: string;
  file?: { url?: string };
  external?: { url?: string };
};

type NotionProperty = {
  type?: string;
  title?: RichText[];
  rich_text?: RichText[];
  url?: string | null;
  files?: NotionFile[];
  select?: { name?: string } | null;
  date?: { start?: string } | null;
};

type WorkerBindings = {
  NOTION_TOKEN?: string;
  NOTION_DATA_SOURCE_ID?: string;
  NOTION_EXCERPTS_DATA_SOURCE_ID?: string;
};

type ConfiguredBindings = {
  NOTION_TOKEN: string;
  NOTION_DATA_SOURCE_ID: string;
};

export type NotionPage = {
  id?: string;
  url?: string | null;
  last_edited_time?: string;
  created_time?: string;
  properties?: Record<string, NotionProperty | undefined>;
};

type NotionQuery = {
  results?: NotionPage[];
  has_more?: boolean;
  next_cursor?: string | null;
  request_status?: { type?: string };
};

type Excerpt = {
  id: string;
  title: string;
  originalTitle: string;
  translation: string;
  sourceTitle: string;
  contentType: string;
  author: string;
  chapter: string;
  publisher: string;
  originalLanguage: string;
  originalUrl: string | null;
  publishedDate: string;
  link: string;
  pubDate: Date | null;
};

export type Book = {
  id: string;
  title: string;
  author: string;
  authorIntro: string;
  summary: string;
  link: string;
  hasCover: boolean;
  publisher: string;
  sourceName: string;
  sourceUrl: string | null;
  pubDate: Date | null;
};

function htmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function textProperty(properties: NotionPage["properties"], name: string): string {
  const property = properties?.[name];
  if (property?.type !== "title" && property?.type !== "rich_text") return "";
  const parts = property.type === "title" ? property.title : property.rich_text;
  return (parts ?? []).map((part) => part.plain_text ?? part.text?.content ?? "").join("").trim();
}

function selectProperty(properties: NotionPage["properties"], name: string): string {
  const property = properties?.[name];
  if (property?.type !== "select") return "";
  return property.select?.name?.trim() ?? "";
}

function externalUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function coverFileUrl(page: NotionPage): string | null {
  const property = page.properties?.["封面"];
  if (property?.type !== "files" || !Array.isArray(property.files)) return null;
  for (const file of property.files) {
    const url = file.type === "external" ? file.external?.url : file.type === "file" ? file.file?.url : undefined;
    const href = externalUrl(url);
    if (href) return href;
  }
  return null;
}

export function bookFromPage(page: NotionPage): Book | null {
  const properties = page.properties ?? {};
  const title = textProperty(properties, "书名");
  const externalLink = properties["详情链接"];
  const link = externalUrl(externalLink?.type === "url" ? externalLink.url : null) ?? externalUrl(page.url);
  if (!title || !link || !page.id) return null;

  const recommendation = properties["推荐来源"];
  const date = new Date(page.last_edited_time ?? page.created_time ?? "");
  return {
    id: page.id,
    title,
    author: textProperty(properties, "作者"),
    authorIntro: textProperty(properties, "作者介绍"),
    summary: textProperty(properties, "简介"),
    link,
    hasCover: coverFileUrl(page) !== null,
    publisher: textProperty(properties, "出版社 / 品牌"),
    sourceName: selectProperty(properties, "来源"),
    sourceUrl: externalUrl(recommendation?.type === "url" ? recommendation.url : null),
    pubDate: Number.isNaN(date.getTime()) ? null : date,
  };
}

function itemDescription(book: Book, feedUrl: string): string {
  const author = [book.author, book.authorIntro].filter(Boolean).map(htmlText).join(" | ");
  const lines = [
    `作者：${author}`,
    `简介：${htmlText(book.summary)}`,
  ];
  if (book.publisher) lines.push(`出版社：${htmlText(book.publisher)}`);
  if (book.sourceName) {
    const name = htmlText(book.sourceName);
    const source = book.sourceUrl ? `<a href="${htmlText(book.sourceUrl)}">${name}</a>` : name;
    lines.push(`来源：${source}`);
  }
  if (book.hasCover) {
    const src = htmlText(`${feedUrl}/cover/${encodeURIComponent(book.id)}`);
    lines.push(`<img src="${src}" alt="封面" />`);
  }
  return lines.join("<br />\n");
}

export function renderFeed(books: Book[], feedUrl: string): string {
  const items: Array<RssFeed.Item<Date>> = books.map((book) => {
    const item: RssFeed.Item<Date> = {
      title: book.title,
      link: book.link,
      description: itemDescription(book, feedUrl),
      guid: { value: `notion:${book.id}`, isPermaLink: false },
    };
    if (book.pubDate) item.pubDate = book.pubDate;
    return item;
  });

  return generateRssFeed({
    title: FEED_TITLE,
    link: feedUrl,
    description: FEED_DESCRIPTION,
    language: "zh-CN",
    atom: {
      links: [{ href: feedUrl, rel: "self", type: "application/rss+xml" }],
    },
    items,
  });
}

export function excerptFromPage(page: NotionPage): Excerpt | null {
  const properties = page.properties;
  const translation = textProperty(properties, "正文翻译");
  const link = externalUrl(page.url);
  if (!translation || !link || !page.id) return null;
  const originalTitle = textProperty(properties, "标题");
  const originalLink = properties?.["原文链接"];
  const published = properties?.["发布日期"];
  const date = new Date(page.last_edited_time ?? page.created_time ?? "");
  return {
    id: page.id,
    title: textProperty(properties, "标题翻译") || originalTitle || "无标题",
    originalTitle,
    translation,
    sourceTitle: textProperty(properties, "出处"),
    contentType: selectProperty(properties, "内容类型"),
    author: textProperty(properties, "作者"),
    chapter: textProperty(properties, "章节"),
    publisher: textProperty(properties, "出版方"),
    originalLanguage: selectProperty(properties, "原文语言"),
    originalUrl: externalUrl(originalLink?.type === "url" ? originalLink.url : null),
    publishedDate: published?.type === "date" ? published.date?.start?.slice(0, 10) ?? "" : "",
    link,
    pubDate: Number.isNaN(date.getTime()) ? null : date,
  };
}

export function renderExcerptFeed(excerpts: Excerpt[], feedUrl: string): string {
  return generateRssFeed({
    title: "阅读节选",
    link: feedUrl,
    description: "来自 Notion「阅读节选」的书籍、杂志与网页译文 RSS",
    language: "zh-CN",
    atom: { links: [{ href: feedUrl, rel: "self", type: "application/rss+xml" }] },
    items: excerpts.map((excerpt) => ({
      title: excerpt.title,
      link: excerpt.link,
      description: excerptDescription(excerpt),
      guid: { value: `notion:${excerpt.id}`, isPermaLink: false },
      ...(excerpt.pubDate ? { pubDate: excerpt.pubDate } : {}),
    })),
  });
}

function excerptDescription(excerpt: Excerpt): string {
  const source = [
    excerpt.sourceTitle ? `<cite>${htmlText(excerpt.sourceTitle)}</cite>` : "",
    excerpt.author ? `作者：${htmlText(excerpt.author)}` : "",
  ].filter(Boolean).join(" · ");
  const details = [
    ["原标题", excerpt.originalTitle !== excerpt.title ? excerpt.originalTitle : ""],
    ["内容类型", excerpt.contentType],
    ["出版方", excerpt.publisher],
    ["章节", excerpt.chapter],
    ["原文语言", excerpt.originalLanguage],
    ["原文发布日期", excerpt.publishedDate],
  ].filter(([, value]) => value).map(([label, value]) => `${label}：${htmlText(value)}`);
  const links = [
    excerpt.originalUrl ? `<a href="${htmlText(excerpt.originalUrl)}">阅读原文</a>` : "",
    `<a href="${htmlText(excerpt.link)}">在 Notion 中查看</a>`,
  ].filter(Boolean).join(" · ");
  return [
    ...(source ? [`<p>${source}</p>`] : []),
    translationParagraphs(excerpt.translation),
    "<hr />",
    ...(details.length ? [`<p>${details.join("<br />\n")}</p>`] : []),
    `<p>${links}</p>`,
  ].join("\n");
}

function translationParagraphs(translation: string): string {
  // Existing translations contain literal <br /> separators. Interpret only
  // attribute-free line breaks; all other markup remains escaped text.
  return translation.replace(/\r\n?/g, "\n").replace(/<br\s*\/?\s*>/gi, "\n").trim()
    .split(/\n(?:[^\S\n]*\n)+/)
    .map((paragraph) => `<p>${htmlText(paragraph).replaceAll("\n", "<br />\n")}</p>`)
    .join("\n");
}

async function fetchPages(env: ConfiguredBindings, filter?: object): Promise<NotionPage[]> {
  const pages: NotionPage[] = [];
  let cursor: string | null | undefined;

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
        ...(filter ? { filter } : {}),
        ...(cursor ? { start_cursor: cursor } : {}),
      }),
    });

    if (!response.ok) {
      throw new Error(`Notion API returned ${response.status}`);
    }

    const data = await response.json() as NotionQuery;
    if (data.request_status?.type === "incomplete") throw new Error("Notion query result is incomplete");
    pages.push(...data.results ?? []);
    cursor = data.has_more ? data.next_cursor : null;
    if (data.has_more && !cursor) throw new Error("Notion returned an incomplete page without a cursor");
  } while (cursor);

  return pages;
}

function coverIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/book-express-rss\/cover\/([^/]+)$/);
  return match?.[1] && NOTION_PAGE_ID.test(match[1]) ? match[1] : null;
}

async function fetchCover(env: ConfiguredBindings, pageId: string): Promise<Response | null> {
  const response = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
    },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Notion API returned ${response.status}`);

  const imageUrl = coverFileUrl(await response.json() as NotionPage);
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

const worker = {
  async fetch(request: Request, env: WorkerBindings): Promise<Response> {
    const url = new URL(request.url);
    const coverId = coverIdFromPath(url.pathname);
    const isExcerptFeed = url.pathname === EXCERPT_FEED_PATH;
    if (url.pathname !== FEED_PATH && !isExcerptFeed && !coverId) {
      return new Response("Not found", { status: 404 });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    const notionToken = env.NOTION_TOKEN;
    const dataSourceId = isExcerptFeed ? env.NOTION_EXCERPTS_DATA_SOURCE_ID : env.NOTION_DATA_SOURCE_ID;
    if (!notionToken || !dataSourceId) {
      return new Response("Feed is not configured", { status: 503 });
    }
    const configured = { NOTION_TOKEN: notionToken, NOTION_DATA_SOURCE_ID: dataSourceId };

    try {
      if (coverId) {
        const cover = await fetchCover(configured, coverId);
        if (!cover) return new Response("Not found", { status: 404 });
        return request.method === "HEAD" ? new Response(null, { status: cover.status, headers: cover.headers }) : cover;
      }

      const pages = await fetchPages(configured, isExcerptFeed
        ? { property: "正文翻译", rich_text: { is_not_empty: true } }
        : undefined);
      const feedUrl = `${url.origin}${url.pathname}`;
      const feed = isExcerptFeed
        ? renderExcerptFeed(pages.map(excerptFromPage).filter((item): item is Excerpt => item !== null), feedUrl)
        : renderFeed(pages.map(bookFromPage).filter((item): item is Book => item !== null), feedUrl);
      return new Response(request.method === "HEAD" ? null : feed, {
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

export default worker;
