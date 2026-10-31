import { generateRssFeed, type RssFeed } from "feedsmith";
import pangu from "pangu";

const NOTION_VERSION = "2026-03-11";
const FEED_TITLE = "书籍推荐";
const FEED_DESCRIPTION = "来自 Notion「书籍推荐」的书目 RSS";
const NOTION_PAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FEED_PATH = "/book-express-rss";
const EXCERPT_FEED_PATH = "/book-excerpts-rss";
const KINDLE_PATH = "/book-excerpts-kindle";
const EXCERPT_QUERY_FILTER = {
  or: [
    { property: "正文翻译", rich_text: { is_not_empty: true } },
    { property: "原文语言", select: { equals: "中文" } },
  ],
};

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
  parent?: { type?: string; data_source_id?: string };
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
  body: string;
  chinese: boolean;
  terms: string;
  sourceTitle: string;
  author: string;
  chapter: string;
  publisher: string;
  originalUrl: string | null;
  publishedDate: string;
  link: string;
  pubDate: Date | null;
};

type NotionBlock = {
  id?: string;
  type?: string;
  paragraph?: { rich_text?: RichText[] };
  heading_1?: { rich_text?: RichText[] };
  heading_2?: { rich_text?: RichText[] };
  heading_3?: { rich_text?: RichText[] };
  quote?: { rich_text?: RichText[] };
  bulleted_list_item?: { rich_text?: RichText[] };
  numbered_list_item?: { rich_text?: RichText[] };
  code?: { rich_text?: RichText[] };
  image?: {
    type?: string;
    file?: { url?: string };
    caption?: RichText[];
  };
};

const TEXT_BLOCK_TYPES = [
  "paragraph",
  "heading_1",
  "heading_2",
  "heading_3",
  "quote",
  "bulleted_list_item",
  "numbered_list_item",
  "code",
] as const;

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

function displayText(value: string): string {
  return htmlText(pangu.spaceText(value));
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
  const author = [book.author, book.authorIntro].filter(Boolean).map(displayText).join(" | ");
  const lines = [
    `作者：${author}`,
    `简介：${displayText(book.summary)}`,
  ];
  if (book.publisher) lines.push(`出版社：${displayText(book.publisher)}`);
  if (book.sourceName) {
    const name = displayText(book.sourceName);
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
      title: pangu.spaceText(book.title),
      link: book.link,
      description: itemDescription(book, feedUrl),
      guid: { value: `notion:${book.id}`, isPermaLink: false },
    };
    if (book.pubDate) item.pubDate = book.pubDate;
    return item;
  });

  return generateRssFeed({
    title: pangu.spaceText(FEED_TITLE),
    link: feedUrl,
    description: pangu.spaceText(FEED_DESCRIPTION),
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
  const chinese = selectProperty(properties, "原文语言") === "中文";
  const link = externalUrl(page.url);
  if (!link || !page.id || (!translation && !chinese)) return null;
  const originalTitle = textProperty(properties, "标题");
  const originalLink = properties?.["原文链接"];
  const published = properties?.["发布日期"];
  const date = new Date(page.last_edited_time ?? page.created_time ?? "");
  return {
    id: page.id,
    title: chinese
      ? originalTitle || textProperty(properties, "标题翻译") || "无标题"
      : textProperty(properties, "标题翻译") || originalTitle || "无标题",
    originalTitle,
    // Chinese body comes from the Notion page content, never from 正文翻译.
    body: chinese ? "" : translation,
    chinese,
    terms: textProperty(properties, "专有名词与术语"),
    sourceTitle: textProperty(properties, "出处"),
    author: textProperty(properties, "作者"),
    chapter: textProperty(properties, "章节"),
    publisher: textProperty(properties, "出版方"),
    originalUrl: externalUrl(originalLink?.type === "url" ? originalLink.url : null),
    publishedDate: published?.type === "date" ? published.date?.start?.slice(0, 10) ?? "" : "",
    link,
    pubDate: Number.isNaN(date.getTime()) ? null : date,
  };
}

export function renderExcerptFeed(excerpts: Excerpt[], feedUrl: string): string {
  return generateRssFeed({
    title: pangu.spaceText("阅读节选"),
    link: feedUrl,
    description: pangu.spaceText("来自 Notion「阅读节选」的书籍、杂志与网页译文及中文原文 RSS"),
    language: "zh-CN",
    atom: { links: [{ href: feedUrl, rel: "self", type: "application/rss+xml" }] },
    items: excerpts.map((excerpt) => ({
      title: pangu.spaceText(excerpt.title),
      link: excerpt.link,
      description: excerptDescription(excerpt, feedUrl),
      guid: { value: `notion:${excerpt.id}`, isPermaLink: false },
      ...(excerpt.pubDate ? { pubDate: excerpt.pubDate } : {}),
    })),
  });
}

function excerptDescription(excerpt: Excerpt, feedUrl: string): string {
  const source = [
    excerpt.sourceTitle ? `<cite>${displayText(excerpt.sourceTitle)}</cite>` : "",
    excerpt.author ? `作者：${displayText(excerpt.author)}` : "",
  ].filter(Boolean).join(" · ");
  const details = [
    ["原标题", excerpt.originalTitle !== excerpt.title ? excerpt.originalTitle : ""],
    ["出版方", excerpt.publisher],
    ["章节", excerpt.chapter],
    ["发布日期", excerpt.publishedDate],
  ].filter(([, value]) => value).map(([label, value]) => `${label}：${displayText(value)}`);
  const links = [
    excerpt.originalUrl ? `<a href="${htmlText(excerpt.originalUrl)}">阅读原文</a>` : "",
    `<a href="${htmlText(excerpt.link)}">在 Notion 中查看</a>`,
  ].filter(Boolean).join(" · ");
  const body = excerpt.body ? translationParagraphs(excerpt.body, excerpt.id, feedUrl) : "";
  const terms = excerpt.terms ? translationParagraphs(excerpt.terms, excerpt.id, feedUrl) : "";
  return [
    ...(source ? [`<p>${source}</p>`] : []),
    ...(body ? [body] : []),
    "<hr />",
    ...(details.length ? [`<p>${details.join("<br />\n")}</p>`] : []),
    `<p>${links}</p>`,
    ...(terms ? ["<hr />", `<p>${displayText("专有名词与术语")}</p>`, terms] : []),
  ].join("\n");
}

function richTextValue(parts?: RichText[]): string {
  return (parts ?? []).map((part) => part.plain_text ?? part.text?.content ?? "").join("").trim();
}

export function pageBodyFromBlocks(blocks: NotionBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (!block.id || !block.type) continue;
    if (block.type === "image") {
      if (block.image?.type !== "file" || !NOTION_PAGE_ID.test(block.id)) continue;
      const caption = richTextValue(block.image.caption);
      // Proxy only needs the block ID; reuse it as the file-id slot for IMAGE_TAG.
      parts.push(caption
        ? `<image source="notion-file-block://${block.id}/${block.id}">${caption}</image>`
        : `<image source="notion-file-block://${block.id}/${block.id}" />`);
      continue;
    }
    if (!(TEXT_BLOCK_TYPES as readonly string[]).includes(block.type)) continue;
    const text = richTextValue(block[block.type as typeof TEXT_BLOCK_TYPES[number]]?.rich_text);
    if (text) parts.push(text);
  }
  return parts.join("\n\n");
}

async function fetchPageBody(env: ConfiguredBindings, pageId: string): Promise<string> {
  const blocks: NotionBlock[] = [];
  let cursor: string | null | undefined;
  do {
    const url = new URL(`https://api.notion.com/v1/blocks/${encodeURIComponent(pageId)}/children`);
    url.searchParams.set("page_size", "100");
    if (cursor) url.searchParams.set("start_cursor", cursor);
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        "Notion-Version": NOTION_VERSION,
      },
    });
    if (!response.ok) throw new Error(`Notion API returned ${response.status}`);
    const data = await response.json() as {
      results?: NotionBlock[];
      has_more?: boolean;
      next_cursor?: string | null;
    };
    blocks.push(...data.results ?? []);
    cursor = data.has_more ? data.next_cursor : null;
    if (data.has_more && !cursor) throw new Error("Notion returned an incomplete page without a cursor");
  } while (cursor);
  return pageBodyFromBlocks(blocks);
}

async function excerptsFromPages(env: ConfiguredBindings, pages: NotionPage[]): Promise<Excerpt[]> {
  const excerpts = pages.map(excerptFromPage).filter((item): item is Excerpt => item !== null);
  await Promise.all(excerpts.map(async (excerpt) => {
    if (!excerpt.chinese) return;
    excerpt.body = await fetchPageBody(env, excerpt.id);
  }));
  return excerpts;
}

async function fetchExcerptById(env: ConfiguredBindings, pageId: string): Promise<Excerpt | null> {
  const response = await fetch(`https://api.notion.com/v1/pages/${encodeURIComponent(pageId)}`, {
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
    },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Notion API returned ${response.status}`);
  const page = await response.json() as NotionPage;
  if (page.parent?.type !== "data_source_id" || page.parent.data_source_id !== env.NOTION_DATA_SOURCE_ID) return null;
  const excerpt = excerptFromPage(page);
  if (!excerpt) return null;
  if (excerpt.chinese) excerpt.body = await fetchPageBody(env, excerpt.id);
  return excerpt;
}

const KINDLE_STYLE = [
  "body{font-family:serif;font-size:1.25em;line-height:1.7;color:#000;background:#fff;margin:1em;}",
  "a{color:#000;}",
  "h1{font-size:1.35em;line-height:1.4;margin:0 0 0.75em;}",
  "p,li{margin:0.75em 0;}",
  "ul{padding-left:1.25em;}",
  "img{max-width:100%;height:auto;}",
  "hr{border:0;border-top:1px solid #000;margin:1.25em 0;}",
  ".meta{font-size:0.9em;}",
  ".nav{margin:1.25em 0;}",
].join("");

function kindleDocument(title: string, body: string): string {
  return [
    "<!DOCTYPE html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${displayText(title)}</title>`,
    `<style>${KINDLE_STYLE}</style>`,
    "</head>",
    `<body>\n${body}\n</body>`,
    "</html>",
  ].join("\n");
}

export function renderKindleList(excerpts: Excerpt[], listPath: string): string {
  const items = excerpts.map((excerpt) => {
    const href = htmlText(`${listPath}/${excerpt.id}`);
    const meta = [
      excerpt.sourceTitle ? displayText(excerpt.sourceTitle) : "",
      excerpt.author ? `作者：${displayText(excerpt.author)}` : "",
    ].filter(Boolean).join(" · ");
    return [
      "<li>",
      `<a href="${href}">${displayText(excerpt.title)}</a>`,
      ...(meta ? [`<br /><span class="meta">${meta}</span>`] : []),
      "</li>",
    ].join("");
  }).join("\n");
  return kindleDocument("阅读节选", [
    `<h1>${displayText("阅读节选")}</h1>`,
    items ? `<ul>\n${items}\n</ul>` : `<p>${displayText("暂无条目")}</p>`,
  ].join("\n"));
}

export function renderKindleDetail(excerpt: Excerpt, listPath: string, imageBaseUrl: string): string {
  const source = [
    excerpt.sourceTitle ? `<cite>${displayText(excerpt.sourceTitle)}</cite>` : "",
    excerpt.author ? `作者：${displayText(excerpt.author)}` : "",
  ].filter(Boolean).join(" · ");
  const details = [
    ["原标题", excerpt.originalTitle !== excerpt.title ? excerpt.originalTitle : ""],
    ["出版方", excerpt.publisher],
    ["章节", excerpt.chapter],
    ["发布日期", excerpt.publishedDate],
  ].filter(([, value]) => value).map(([label, value]) => `${label}：${displayText(value)}`);
  const links = [
    excerpt.originalUrl ? `<a href="${htmlText(excerpt.originalUrl)}">阅读原文</a>` : "",
  ].filter(Boolean).join(" · ");
  const body = excerpt.body ? translationParagraphs(excerpt.body, excerpt.id, imageBaseUrl) : "";
  const terms = excerpt.terms ? translationParagraphs(excerpt.terms, excerpt.id, imageBaseUrl) : "";
  const back = `<p class="nav"><a href="${htmlText(listPath)}">${displayText("返回列表")}</a></p>`;
  return kindleDocument(excerpt.title, [
    back,
    `<h1>${displayText(excerpt.title)}</h1>`,
    ...(source ? [`<p class="meta">${source}</p>`] : []),
    ...(body ? [body] : []),
    "<hr />",
    ...(details.length ? [`<p class="meta">${details.join("<br />\n")}</p>`] : []),
    ...(links ? [`<p>${links}</p>`] : []),
    ...(terms ? ["<hr />", `<p>${displayText("专有名词与术语")}</p>`, terms] : []),
    back,
  ].join("\n"));
}

// Self-closing tags and captioned <image>...</image> wrappers both count.
const IMAGE_TAG = /<image\s+source="notion-file-block:\/\/([0-9a-f-]{36})\/([0-9a-f-]{36})(?:\?[^"<>]*)?"\s*(?:\/>|>([\s\S]*?)<\/image>)/gi;

function translationParagraphs(translation: string, pageId: string, feedUrl: string): string {
  // Existing translations contain literal <br /> separators. Interpret only
  // attribute-free line breaks; all other markup remains escaped text.
  return translation.replace(/\r\n?/g, "\n").replace(/<br\s*\/?\s*>/gi, "\n").trim()
    .split(/\n(?:[^\S\n]*\n)+/)
    .map((paragraph) => {
      let output = "";
      let offset = 0;
      for (const match of paragraph.matchAll(IMAGE_TAG)) {
        const blockId = match[1];
        const fileId = match[2];
        if (!NOTION_PAGE_ID.test(pageId) || !NOTION_PAGE_ID.test(blockId) || !NOTION_PAGE_ID.test(fileId)) continue;
        const caption = (match[3] ?? "").replace(/<br\s*\/?\s*>/gi, "\n").trim();
        const alt = caption ? displayText(caption.replaceAll("\n", " ")) : "正文图片";
        output += displayText(paragraph.slice(offset, match.index)).replaceAll("\n", "<br />\n");
        output += `<img src="${htmlText(`${feedUrl}/image/${pageId}/${blockId}`)}" alt="${alt}" />`;
        if (caption) output += `<br />\n${displayText(caption).replaceAll("\n", "<br />\n")}`;
        offset = match.index + match[0].length;
      }
      return `<p>${output}${displayText(paragraph.slice(offset)).replaceAll("\n", "<br />\n")}</p>`;
    })
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
  return fetchImage(imageUrl);
}

async function fetchImage(imageUrl: string): Promise<Response> {
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

async function fetchExcerptImage(env: ConfiguredBindings, pageId: string, blockId: string): Promise<Response | null> {
  const headers = { Authorization: `Bearer ${env.NOTION_TOKEN}`, "Notion-Version": NOTION_VERSION };
  const pageResponse = await fetch(`https://api.notion.com/v1/pages/${pageId}`, { headers });
  if (pageResponse.status === 404) return null;
  if (!pageResponse.ok) throw new Error(`Notion API returned ${pageResponse.status}`);
  const page = await pageResponse.json() as NotionPage;
  if (page.parent?.type !== "data_source_id" || page.parent.data_source_id !== env.NOTION_DATA_SOURCE_ID) return null;
  const chinese = selectProperty(page.properties, "原文语言") === "中文";
  const translation = textProperty(page.properties, "正文翻译");
  const referenced = chinese || Array.from(translation.matchAll(IMAGE_TAG)).some((match) =>
    match[1]?.toLowerCase() === blockId.toLowerCase() && NOTION_PAGE_ID.test(match[2] ?? ""));
  if (!referenced) return null;
  const blockResponse = await fetch(`https://api.notion.com/v1/blocks/${blockId}`, { headers });
  if (blockResponse.status === 404) return null;
  if (!blockResponse.ok) throw new Error(`Notion API returned ${blockResponse.status}`);
  const block = await blockResponse.json() as {
    type?: string; parent?: { type?: string; page_id?: string };
    image?: { type?: string; file?: { url?: string } };
  };
  if (block.type !== "image" || block.parent?.type !== "page_id" || block.parent.page_id !== pageId || block.image?.type !== "file") return null;
  const imageUrl = externalUrl(block.image.file?.url);
  return imageUrl ? fetchImage(imageUrl) : null;
}

const worker = {
  async fetch(request: Request, env: WorkerBindings): Promise<Response> {
    const url = new URL(request.url);
    const coverId = coverIdFromPath(url.pathname);
    const isExcerptFeed = url.pathname === EXCERPT_FEED_PATH;
    const isKindleList = url.pathname === KINDLE_PATH;
    const kindleDetailMatch = url.pathname.match(/^\/book-excerpts-kindle\/([^/]+)$/);
    const kindleDetailId = kindleDetailMatch?.[1] && NOTION_PAGE_ID.test(kindleDetailMatch[1]) ? kindleDetailMatch[1] : null;
    const imageMatch = url.pathname.match(/^\/book-excerpts-rss\/image\/([^/]+)\/([^/]+)$/);
    const imageIds = imageMatch && NOTION_PAGE_ID.test(imageMatch[1] ?? "") && NOTION_PAGE_ID.test(imageMatch[2] ?? "") ? [imageMatch[1]!, imageMatch[2]!] : null;
    const usesExcerpts = isExcerptFeed || isKindleList || Boolean(kindleDetailId) || Boolean(imageIds);
    if (url.pathname !== FEED_PATH && !usesExcerpts && !coverId) {
      return new Response("Not found", { status: 404 });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    const notionToken = env.NOTION_TOKEN;
    const dataSourceId = usesExcerpts ? env.NOTION_EXCERPTS_DATA_SOURCE_ID : env.NOTION_DATA_SOURCE_ID;
    if (!notionToken || !dataSourceId) {
      return new Response("Feed is not configured", { status: 503 });
    }
    const configured = { NOTION_TOKEN: notionToken, NOTION_DATA_SOURCE_ID: dataSourceId };

    try {
      if (imageIds) {
        const image = await fetchExcerptImage(configured, imageIds[0]!, imageIds[1]!);
        if (!image) return new Response("Not found", { status: 404 });
        return request.method === "HEAD" ? new Response(null, { status: image.status, headers: image.headers }) : image;
      }
      if (coverId) {
        const cover = await fetchCover(configured, coverId);
        if (!cover) return new Response("Not found", { status: 404 });
        return request.method === "HEAD" ? new Response(null, { status: cover.status, headers: cover.headers }) : cover;
      }

      if (kindleDetailId) {
        const excerpt = await fetchExcerptById(configured, kindleDetailId);
        if (!excerpt) return new Response("Not found", { status: 404 });
        const html = renderKindleDetail(excerpt, KINDLE_PATH, `${url.origin}${EXCERPT_FEED_PATH}`);
        return new Response(request.method === "HEAD" ? null : html, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "public, max-age=300",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }

      if (isKindleList) {
        const pages = await fetchPages(configured, EXCERPT_QUERY_FILTER);
        const html = renderKindleList(await excerptsFromPages(configured, pages), KINDLE_PATH);
        return new Response(request.method === "HEAD" ? null : html, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "public, max-age=300",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }

      const pages = await fetchPages(configured, isExcerptFeed ? EXCERPT_QUERY_FILTER : undefined);
      const feedUrl = `${url.origin}${url.pathname}`;
      const feed = isExcerptFeed
        ? renderExcerptFeed(await excerptsFromPages(configured, pages), feedUrl)
        : renderFeed(pages.map(bookFromPage).filter((item): item is Book => item !== null), feedUrl);
      return new Response(request.method === "HEAD" ? null : feed, {
        headers: {
          "Content-Type": "application/rss+xml; charset=utf-8",
          "Cache-Control": "public, max-age=300",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      console.error(coverId || imageIds ? "Failed to load image" : "Failed to build book RSS", error);
      return new Response(coverId || imageIds ? "Image temporarily unavailable" : "Feed temporarily unavailable", { status: 502 });
    }
  },
};

export default worker;
