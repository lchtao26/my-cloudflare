import { captureException, logger } from "@sentry/core";
import { generateRssFeed, type RssFeed } from "feedsmith";
import { canonicalText, hashText, resolveAnchor } from "./highlight-anchor.ts";
import { formatText } from "./format-text.ts";
import { addReadLater, readLaterFeed } from "./read-later.ts";
import { favoriteRequest, type FavoriteBindings } from "./favorite.ts";
import { explanationMarkdown } from "./explanation-markdown.ts";
import { EINK_STYLE } from "./reader-style.ts";
import { readCategory, readPage, type ReadCategory, type ReaderArticle, type ReaderItem, type ReaderList, type ReaderParagraph, type ResolvedHighlight } from "./reader-data.ts";

const NOTION_VERSION = "2026-03-11";
const FEED_TITLE = "书籍推荐";
const FEED_DESCRIPTION = "来自 Notion「书籍推荐」的书目 RSS";
const NOTION_PAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BOOK_FEED_PATH = "/book.xml";
const BOOK_ASSET_PREFIX = "/book/p";
const READ_LIST_PATH = "/read";
const READ_DETAIL_PREFIX = "/r";
const READ_FEED_PATH = "/read.xml";
const READ_ASSET_PREFIX = "/read/p";
const SHORT_SHARE_PREFIX = "/s";
// Notion ID property whose auto-increment number becomes the detail and share code.
const SHORT_ID_PROPERTY = "ID";
// Codes are a keyed 32-bit Feistel permutation of the ID, written as 6 base62 characters.
// IDs stay below 2^20, so a random code decodes to a valid ID only about 1 time in 4096.
// Changing the keys or alphabet breaks every detail and share link already sent out.
const SHORT_ID_LIMIT = 2 ** 20;
const JEV_CANDIDATE_RADIUS = 8;
const JEV_CANDIDATE_TEXT_LIMIT = 1200;
const SHARE_CODE_KEYS = [0x3c6e, 0xa54f, 0x510e, 0x9b05];
const SHARE_CODE_ALPHABET = "hqAiRYEFKT2xePmzuOfgrw4dBbNscH78S9kI30LQjpaGUJXonCMZ6ly15DtWvV";
const SHARE_CODE = /^[0-9A-Za-z]{6}$/;
const FEED_ITEM_LIMIT = 30;

function shareCodeRound(half: number, key: number): number {
  let value = Math.imul(half ^ key, 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return (value ^ (value >>> 16)) & 0xffff;
}

export function shareCode(id: number): string {
  let left = id >>> 16;
  let right = id & 0xffff;
  for (const key of SHARE_CODE_KEYS) [left, right] = [right, left ^ shareCodeRound(right, key)];
  let value = (left * 0x10000) + right;
  const digits: number[] = [];
  for (let i = 0; i < 6; i++) {
    digits.unshift(value % 62);
    value = Math.floor(value / 62);
  }
  // 2^32 only reaches the first five leading digits; mixing in the rest spreads the first character.
  digits[0] = digits.reduce((sum, digit) => sum + digit, 0) % 62;
  return digits.map((digit) => SHARE_CODE_ALPHABET[digit]).join("");
}

export function shareCodeId(code: string): number | null {
  if (!SHARE_CODE.test(code)) return null;
  const digits = Array.from(code, (char) => SHARE_CODE_ALPHABET.indexOf(char));
  digits[0] = ((digits[0]! - digits.slice(1).reduce((sum, digit) => sum + digit, 0)) % 62 + 62) % 62;
  const value = digits.reduce((total, digit) => total * 62 + digit, 0);
  if (value >= 2 ** 32) return null;
  let left = Math.floor(value / 0x10000);
  let right = value & 0xffff;
  for (const key of [...SHARE_CODE_KEYS].reverse()) [left, right] = [right ^ shareCodeRound(left, key), left];
  const id = (left * 0x10000) + right;
  return id > 0 && id < SHORT_ID_LIMIT ? id : null;
}

function pathCodeId(path: string, prefix: string): number | null {
  if (!path.startsWith(`${prefix}/`)) return null;
  return shareCodeId(path.slice(prefix.length + 1));
}

function categoryFilter(category: ReadCategory): object | undefined {
  if (category === "later") return { property: "提取来源", select: { equals: "稍后阅读" } };
  if (category === "novel") return { property: "提取来源", select: { equals: "epub" } };
  if (category === "weekly" || category === "bunshun") {
    const path = category === "weekly" ? "bunshun.jp/denshiban/articles/" : "bunshun.jp/articles/";
    return { or: [
      { property: "原文链接", url: { contains: path } },
      { property: "备注", rich_text: { contains: path } },
    ] };
  }
  if (category === "news") return { or: [
    { property: "原文链接", url: { contains: "news.ycombinator.com" } },
    { property: "备注", rich_text: { starts_with: "HN " } },
  ] };
  return undefined;
}

type RichText = { plain_text?: string; text?: { content?: string } };

type NotionFile = {
  name?: string;
  type?: string;
  file?: { url?: string };
  external?: { url?: string };
};

type NotionProperty = {
  type?: string;
  checkbox?: boolean;
  title?: RichText[];
  rich_text?: RichText[];
  url?: string | null;
  files?: NotionFile[];
  select?: { name?: string } | null;
  date?: { start?: string } | null;
  unique_id?: { number?: number | null } | null;
};

type WorkerBindings = FavoriteBindings & {
  HIGHLIGHTS_DB?: D1Database;
  AI302_API_KEY?: string;
  INSTAPAPER_CONSUMER_ID?: string;
  INSTAPAPER_CONSUMER_SECRET?: string;
  INSTAPAPER_OAUTH_TOKEN?: string;
  INSTAPAPER_OAUTH_TOKEN_SECRET?: string;
  NOTION_TOKEN?: string;
  NOTION_DATA_SOURCE_ID?: string;
  NOTION_EXCERPTS_DATA_SOURCE_ID?: string;
  NOTION_EXCERPTS_VIEW_ID?: string;
  NOTION_EXCERPTS_FAVORITES_VIEW_ID?: string;
};

type ConfiguredBindings = {
  NOTION_TOKEN: string;
  NOTION_DATA_SOURCE_ID: string;
};

type NotionView = {
  object?: string;
  id?: string;
  name?: string;
  data_source_id?: string;
  filter?: object | null;
  sorts?: object[] | null;
  quick_filters?: Record<string, object> | null;
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
  originalBody?: string;
  chinese: boolean;
  /** BCP 47 tag for the displayed body (translations are Chinese). */
  lang: string;
  titleLang: string;
  originalLang: string;
  terms: string;
  sourceTitle: string;
  author: string;
  chapter: string;
  publisher: string;
  originalUrl: string | null;
  publishedDate: string;
  link: string;
  pubDate: Date | null;
  /** Obfuscated Notion ID number used in detail and share URLs. */
  code: string;
  favorite?: boolean;
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
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function displayText(value: string): string {
  return htmlText(value);
}

/** Format visible e-ink text before escaping it for HTML. */
function einkText(value: string): string {
  return htmlText(formatText(value));
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

/** Chinese posts use the original title/body; other entries use translations. */
function usesOriginalContent(properties: NotionPage["properties"]): boolean {
  return selectProperty(properties, "原文语言") === "中文";
}

/** Source language is also needed for original titles alongside Chinese translations. */
function excerptOriginalLang(properties: NotionPage["properties"]): string {
  const language = selectProperty(properties, "原文语言");
  if (language === "日文") return "ja";
  if (language === "英文") return "en";
  return "zh-CN";
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
  const date = new Date(page.created_time ?? page.last_edited_time ?? "");
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
  const author = [book.author, book.authorIntro].filter(Boolean).map((value) => displayText(value)).join(" | ");
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
    const src = htmlText(`${new URL(feedUrl).origin}${BOOK_ASSET_PREFIX}/${encodeURIComponent(book.id)}`);
    lines.push(`<img src="${src}" alt="封面" />`);
  }
  return lines.join("<br />\n");
}

export function renderFeed(books: Book[], feedUrl: string): string {
  const items: Array<RssFeed.Item<Date>> = books.map((book) => {
    const item: RssFeed.Item<Date> = {
      title: formatText(book.title),
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
  const chinese = selectProperty(properties, "原文语言") === "中文";
  const useOriginal = usesOriginalContent(properties);
  const body = useOriginal ? textProperty(properties, "正文") : textProperty(properties, "正文翻译");
  const link = externalUrl(page.url);
  const uniqueId = properties?.[SHORT_ID_PROPERTY];
  const shortId = uniqueId?.type === "unique_id" ? uniqueId.unique_id?.number : null;
  const validShortId = typeof shortId === "number" && Number.isInteger(shortId) && shortId > 0 && shortId < SHORT_ID_LIMIT;
  if (!link || !page.id || !body || !validShortId) return null;
  const originalTitle = textProperty(properties, "标题");
  const translatedTitle = useOriginal ? "" : textProperty(properties, "标题翻译");
  const originalLang = excerptOriginalLang(properties);
  const originalLink = properties?.["原文链接"];
  const published = properties?.["发布日期"];
  const date = new Date(page.created_time ?? page.last_edited_time ?? "");
  return {
    id: page.id,
    title: translatedTitle || originalTitle || "无标题",
    originalTitle,
    body,
    originalBody: useOriginal ? "" : textProperty(properties, "正文"),
    chinese,
    lang: useOriginal ? originalLang : "zh-CN",
    titleLang: translatedTitle || !originalTitle ? "zh-CN" : originalLang,
    originalLang,
    terms: textProperty(properties, "专有名词与术语"),
    sourceTitle: textProperty(properties, "出处"),
    author: textProperty(properties, "作者"),
    chapter: textProperty(properties, "章节"),
    publisher: textProperty(properties, "出版方"),
    originalUrl: externalUrl(originalLink?.type === "url" ? originalLink.url : null),
    publishedDate: published?.type === "date" ? published.date?.start?.slice(0, 10) ?? "" : "",
    link,
    pubDate: Number.isNaN(date.getTime()) ? null : date,
    code: shareCode(shortId),
    favorite: properties?.["已收藏"]?.type === "checkbox" && properties["已收藏"]?.checkbox === true,
  };
}

function excerptDetailUrl(feedUrl: string, code: string): string {
  return `${new URL(feedUrl).origin}${READ_DETAIL_PREFIX}/${code}`;
}

// Stop a caption at the next image so a standalone opening tag cannot consume it.
const IMAGE_TAG = /<image\s+source="notion-file-block:\/\/([0-9a-f-]{36})\/([0-9a-f-]{36})(?:\?[^"<>]*)?"\s*(?:\/>|>(?:((?:(?!<image\b)[\s\S])*?)<\/image>)?)/gi;
// RSS only needs the first source ids; skip matching the rest of the tag or caption body.
const IMAGE_SOURCE = /<image\s+source="notion-file-block:\/\/([0-9a-f-]{36})\/([0-9a-f-]{36})/gi;
const HTML_IMG = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi;

function excerptDescription(excerpt: Excerpt, feedUrl: string): string | undefined {
  let earliest: { index: number; html: string } | undefined;

  if (NOTION_PAGE_ID.test(excerpt.id)) {
    for (const match of excerpt.body.matchAll(IMAGE_SOURCE)) {
      const blockId = match[1]!;
      const fileId = match[2]!;
      if (!NOTION_PAGE_ID.test(blockId) || !NOTION_PAGE_ID.test(fileId)) continue;
      const src = htmlText(`${new URL(feedUrl).origin}${READ_ASSET_PREFIX}/${excerpt.id}/${blockId}`);
      earliest = { index: match.index ?? 0, html: `<img src="${src}" alt="正文图片" />` };
      break;
    }
  }

  for (const match of excerpt.body.matchAll(HTML_IMG)) {
    const href = externalUrl(match[1] || match[2]);
    if (!href) continue;
    const index = match.index ?? 0;
    if (earliest && earliest.index <= index) break;
    earliest = { index, html: `<img src="${htmlText(href)}" alt="正文图片" />` };
    break;
  }

  return earliest?.html;
}

export function renderExcerptFeed(excerpts: Excerpt[], feedUrl: string): string {
  return generateRssFeed({
    title: "阅读节选",
    link: feedUrl,
    description: "来自 Notion「阅读节选」的书籍、杂志与网页译文及中文原文 RSS",
    language: "zh-CN",
    atom: { links: [{ href: feedUrl, rel: "self", type: "application/rss+xml" }] },
    items: excerpts.map((excerpt) => {
      const item: RssFeed.Item<Date> = {
        title: formatText(excerpt.title),
        link: excerptDetailUrl(feedUrl, excerpt.code),
        guid: { value: `notion:${excerpt.id}`, isPermaLink: false },
      };
      const description = excerptDescription(excerpt, feedUrl);
      if (description) item.description = description;
      if (excerpt.pubDate) item.pubDate = excerpt.pubDate;
      return item;
    }),
  });
}

function einkDocument(
  title: string,
  body: string,
  panguedTitle = false,
  afterMain = "",
  bodyClass = "",
): string {
  const bodyAttrs = bodyClass ? ` class="${bodyClass}"` : "";
  return [
    "<!DOCTYPE html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="color-scheme" content="light dark" />',
    `<meta name="viewport" content="width=device-width, initial-scale=1${bodyClass === "read-list" ? ", viewport-fit=cover" : ""}" />`,
    '<link rel="icon" type="image/png" sizes="32x32" href="/favicon.png" />',
    '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />',
    '<link rel="manifest" href="/manifest.webmanifest" />',
    `<title>${panguedTitle ? einkText(title) : displayText(title)}</title>`,
    `<style>${EINK_STYLE}</style>`,
    "</head>",
    `<body${bodyAttrs}>\n<main>\n${body}\n</main>${afterMain ? `\n${afterMain}` : ""}\n</body>`,
    "</html>",
  ].join("\n");
}

export type EinkNeighbors = {
  prevCode: string | null;
  nextCode: string | null;
};

export function neighborsFor(excerpts: Excerpt[], code: string): EinkNeighbors | undefined {
  const index = excerpts.findIndex((item) => item.code === code);
  if (index < 0) return undefined;
  return {
    prevCode: index > 0 ? excerpts[index - 1]!.code : null,
    nextCode: index < excerpts.length - 1 ? excerpts[index + 1]!.code : null,
  };
}

type HighlightRow = {
  id: string; excerpt_number: number; excerpt_page_id: string; field: "original" | "translation" | "terms";
  start: number; end: number; quote: string; prefix: string; suffix: string; body_hash: string; created_at: string;
};

function bodyText(excerpt: Excerpt, field: string): string | null {
  const raw = field === "translation" ? (!excerpt.chinese ? excerpt.body : "") :
    field === "original" ? (excerpt.chinese ? excerpt.body : excerpt.originalBody || "") :
    field === "terms" ? excerpt.terms : "";
  if (!raw) return null;
  return canonicalText(readerParagraphs(raw, excerpt.id, "").map(({ quote }) => quote).join(""));
}

async function resolveHighlights(excerpt: Excerpt, rows: HighlightRow[]): Promise<ResolvedHighlight[]> {
  const fields = new Map<string, { text: string; hash: string }>();
  for (const field of ["original", "translation", "terms"]) {
    const text = bodyText(excerpt, field);
    if (text !== null) fields.set(field, { text, hash: await hashText(text) });
  }
  return rows.flatMap((row) => {
    const body = fields.get(row.field);
    if (!body || row.excerpt_page_id !== excerpt.id) return [];
    const range = resolveAnchor(body.text, body.hash, { ...row, bodyHash: row.body_hash });
    return range ? [{ id: row.id, field: row.field, ...range }] : [];
  });
}

function highlightError(message: string, status: number): Response {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

async function fetchHighlightExcerpts(env: ConfiguredBindings, ids: number[]): Promise<Map<number, Excerpt>> {
  const found = new Map<number, Excerpt>();
  for (let offset = 0; offset < ids.length; offset += 50) {
    const batch = ids.slice(offset, offset + 50);
    let cursor: string | undefined;
    do {
      const response = await fetchNotionJson(`https://api.notion.com/v1/data_sources/${encodeURIComponent(env.NOTION_DATA_SOURCE_ID)}/query`, {
        method: "POST", headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
        body: JSON.stringify({ page_size: 100, filter: { or: batch.map(id => ({ property: SHORT_ID_PROPERTY, unique_id: { equals: id } })) }, ...(cursor ? { start_cursor: cursor } : {}) }),
      });
      if (!response.ok) throw new Error(`Notion API returned ${response.status}`);
      const result = await response.json() as NotionQuery;
      if (result.request_status?.type === "incomplete" || (result.has_more && !result.next_cursor)) throw new Error("Notion query incomplete");
      for (const page of result.results || []) {
        const excerpt = excerptFromPage(page);
        if (excerpt) { const id = shareCodeId(excerpt.code); if (id !== null) found.set(id, excerpt); }
      }
      cursor = result.has_more ? result.next_cursor || undefined : undefined;
    } while (cursor);
  }
  return found;
}

async function loadHighlightList(db: D1Database | undefined, env: ConfiguredBindings, page: number) {
  if (!db) return { rows: [], excerpts: new Map<number, Excerpt>(), resolved: new Set<string>(), hasMore: false };
  const limit = FEED_ITEM_LIMIT;
  const result = await db.prepare('SELECT * FROM highlights ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?').bind(limit + 1, (page - 1) * limit).all<HighlightRow>();
  const rows = result.results.slice(0, limit);
  const excerpts = await fetchHighlightExcerpts(env, [...new Set(rows.map(row => row.excerpt_number))]);
  const resolved = new Set<string>();
  for (const [id, excerpt] of excerpts) for (const row of await resolveHighlights(excerpt, rows.filter(row => row.excerpt_number === id))) resolved.add(row.id);
  return { rows, excerpts, resolved, hasMore: result.results.length > limit && page < 999 };
}

async function fetchExcerptByShortId(env: ConfiguredBindings, shortId: number): Promise<Excerpt | null> {
  const response = await fetchNotionJson(`https://api.notion.com/v1/data_sources/${encodeURIComponent(env.NOTION_DATA_SOURCE_ID)}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ page_size: 1, filter: { property: SHORT_ID_PROPERTY, unique_id: { equals: shortId } } }),
  });
  if (!response.ok) throw new Error(`Notion API returned ${response.status}`);
  const page = (await response.json() as NotionQuery).results?.[0];
  return page ? excerptFromPage(page) : null;
}

function einkParagraphTexts(translation: string, pageId: string): string[] {
  // Existing translations contain literal <br /> separators. Interpret only
  // attribute-free line breaks, Notion file images, and http(s) <img> tags;
  // all other markup remains escaped text.
  // Captions are not displayed, so exclude them before processing quotes and paragraphs.
  const withoutCaptions = translation.replace(IMAGE_TAG, (match, blockId: string, fileId: string) => {
    if (!NOTION_PAGE_ID.test(pageId) || !NOTION_PAGE_ID.test(blockId) || !NOTION_PAGE_ID.test(fileId)) return match;
    return match.replace(/>[\s\S]*<\/image>$/i, "></image>");
  });
  return formatText(withoutCaptions.replace(/\r\n?/g, "\n").replace(/<br\s*\/?\s*>/gi, "\n").trim())
    .split(/\n(?:[^\S\n]*\n)+/);
}

function readerParagraphs(translation: string, pageId: string, imageBaseUrl: string): ReaderParagraph[] {
  if (!translation) return [];
  let start = 0;
  // Use the same paragraph boundaries for display and Jev candidate selection.
  return einkParagraphTexts(translation, pageId)
    .map((paragraph) => {
      const replacements: Array<{ index: number; length: number; image: string }> = [];
      for (const match of paragraph.matchAll(IMAGE_TAG)) {
        const blockId = match[1];
        const fileId = match[2];
        if (!NOTION_PAGE_ID.test(pageId) || !NOTION_PAGE_ID.test(blockId) || !NOTION_PAGE_ID.test(fileId)) continue;
        // Caption text inside <image>...</image> is ignored; only the file reference is used.
        replacements.push({
          index: match.index ?? 0,
          length: match[0].length,
          image: `${imageBaseUrl}/${pageId}/${blockId}`,
        });
      }
      for (const match of paragraph.matchAll(HTML_IMG)) {
        const href = externalUrl(match[1] || match[2]);
        if (!href) continue;
        replacements.push({
          index: match.index ?? 0,
          length: match[0].length,
          image: href,
        });
      }
      replacements.sort((a, b) => a.index - b.index);

      const parts: ReaderParagraph["parts"] = [];
      let offset = 0;
      for (const replacement of replacements) {
        if (replacement.index < offset) continue;
        parts.push({ text: paragraph.slice(offset, replacement.index) }, { image: replacement.image });
        offset = replacement.index + replacement.length;
      }
      parts.push({ text: paragraph.slice(offset) });
      const quote = parts.map(part => "text" in part ? part.text : "").join("");
      const end = start + canonicalText(quote).length;
      const result = { parts, quote, start, end };
      start = end;
      return result;
    });
}

async function appendNotionPage(response: Response, pages: NotionPage[]): Promise<string | null | undefined> {
  if (!response.ok) throw new Error(`Notion API returned ${response.status}`);
  const data = await response.json() as NotionQuery;
  if (data.request_status?.type === "incomplete") throw new Error("Notion query result is incomplete");
  pages.push(...data.results ?? []);
  const cursor = data.has_more ? data.next_cursor : null;
  if (data.has_more && !cursor) throw new Error("Notion returned an incomplete page without a cursor");
  return cursor;
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
        page_size: FEED_ITEM_LIMIT - pages.length,
        sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
        ...(filter ? { filter } : {}),
        ...(cursor ? { start_cursor: cursor } : {}),
      }),
    });

    cursor = await appendNotionPage(response, pages);
  } while (cursor && pages.length < FEED_ITEM_LIMIT);

  return pages.slice(0, FEED_ITEM_LIMIT);
}

async function fetchNotionJson(url: string, init: RequestInit): Promise<Response> {
  let attempt = 0;
  while (true) {
    const response = await fetch(url, init);
    if (response.status !== 429 || attempt >= 4) return response;
    const retryAfter = Number(response.headers.get("Retry-After") ?? "");
    const delayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    attempt += 1;
  }
}

export function viewQueryFilter(view: NotionView): object | undefined {
  // Notion ANDs the saved filter with each column quick filter. One clause stays unwrapped.
  const quick = Object.entries(view.quick_filters ?? {}).flatMap(([property, condition]) => {
    if (!condition || typeof condition !== "object" || Array.isArray(condition)) return [];
    if (Object.keys(condition).length === 0) return [];
    return [{ ...(condition as Record<string, unknown>), property }];
  });
  const parts = [...(view.filter ? [view.filter] : []), ...quick];
  if (parts.length <= 1) return parts[0];
  return { and: parts };
}

async function fetchExcerptPages(env: ConfiguredBindings, viewId: string, category: ReadCategory = "all", limit = FEED_ITEM_LIMIT): Promise<NotionPage[]> {
  // Read the saved view filter, quick filters, and sort, then query the data source for full pages.
  // This follows the Notion view without N+1 page fetches (which hit rate limits).
  const headers = {
    Authorization: `Bearer ${env.NOTION_TOKEN}`,
    "Notion-Version": NOTION_VERSION,
  };
  const viewResponse = await fetchNotionJson(`https://api.notion.com/v1/views/${encodeURIComponent(viewId)}`, { headers });
  if (!viewResponse.ok) throw new Error(`Notion API returned ${viewResponse.status}`);
  const view = await viewResponse.json() as NotionView;
  const dataSourceId = view.data_source_id ?? env.NOTION_DATA_SOURCE_ID;
  if (!dataSourceId) throw new Error("Notion view is missing a data source");

  const pages: NotionPage[] = [];
  // The read-later category includes entries outside the RSS view's filters.
  const viewFilter = category === "later" ? undefined : viewQueryFilter(view);
  const selectedFilter = categoryFilter(category);
  const filter = viewFilter && selectedFilter
    ? { and: [...("and" in viewFilter && Array.isArray(viewFilter.and) ? viewFilter.and : [viewFilter]), selectedFilter] }
    : viewFilter ?? selectedFilter;
  let cursor: string | null | undefined;
  do {
    const response = await fetchNotionJson(`https://api.notion.com/v1/data_sources/${encodeURIComponent(dataSourceId)}/query`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        page_size: Math.min(100, limit - pages.length),
        // Favorites are ordered by the most recently edited page, regardless of the view's saved sort.
        ...(category === "favorites"
          ? { sorts: [{ timestamp: "last_edited_time", direction: "descending" }] }
          : view.sorts?.length ? { sorts: view.sorts } : {}),
        ...(filter ? { filter } : {}),
        ...(cursor ? { start_cursor: cursor } : {}),
      }),
    });
    cursor = await appendNotionPage(response, pages);
  } while (cursor && pages.length < limit);

  return pages.slice(0, limit);
}

function coverIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/book\/p\/([^/]+)$/);
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

// Raster formats only: SVG can run scripts on this origin when a proxy URL is opened directly.
const PROXIED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"]);

async function fetchImage(imageUrl: string): Promise<Response> {
  const image = await fetch(imageUrl);
  if (!image.ok) throw new Error(`Cover image returned ${image.status}`);
  const contentType = image.headers.get("Content-Type") ?? "";
  const mediaType = contentType.split(";")[0]!.trim().toLowerCase();
  if (!PROXIED_IMAGE_TYPES.has(mediaType)) throw new Error("Cover image has an unexpected content type");
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
  const original = textProperty(page.properties, "正文");
  const translation = textProperty(page.properties, "正文翻译");
  const bodies = usesOriginalContent(page.properties) ? [original] : translation ? [translation, original] : [];
  const referenced = bodies.some((body) => Array.from(body.matchAll(IMAGE_TAG)).some((match) =>
    match[1]?.toLowerCase() === blockId.toLowerCase() && NOTION_PAGE_ID.test(match[2] ?? "")));
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

function readerItem(excerpt: Excerpt): ReaderItem {
  return {
    code: excerpt.code,
    title: formatText(excerpt.title),
    titleLang: excerpt.titleLang,
    source: formatText(excerpt.sourceTitle),
    author: formatText(excerpt.author),
  };
}

function readerResponse(data: ReaderList | ReaderArticle, method: string, cacheable: boolean): Response {
  return new Response(method === "HEAD" ? null : JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheable ? "public, max-age=300, must-revalidate" : "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function highlightRanges(data: URLSearchParams, allowMultiple: boolean): Array<{ start: number; end: number; quote: string }> {
  const rangesJson = allowMultiple ? data.get("ranges") : null;
  let ranges: Array<{ start: number; end: number; quote: string }>;
  if (rangesJson !== null) {
    try { ranges = JSON.parse(rangesJson); } catch { throw highlightError("选区无效。", 400); }
    if (!Array.isArray(ranges) || !ranges.length || ranges.length > 1500) throw highlightError("选区无效。", 400);
  } else {
    const start = data.get("start") || "";
    const end = data.get("end") || "";
    if (!/^(0|[1-9]\d{0,8})$/.test(start) || !/^(0|[1-9]\d{0,8})$/.test(end)) throw highlightError("选区无效。", 400);
    ranges = [{ start: Number(start), end: Number(end), quote: data.get("quote") || "" }];
  }
  let previousEnd = 0, selectedLength = 0;
  for (const range of ranges) {
    if (!range || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || typeof range.quote !== "string" || range.start < previousEnd || range.end <= range.start || range.end > 999999999) throw highlightError("选区无效。", 400);
    const clean = canonicalText(range.quote);
    if (clean.length !== range.end - range.start || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(clean)) throw highlightError("选区无效。", 400);
    selectedLength += clean.length;
    if (selectedLength > 1500) throw highlightError("选区无效。", 400);
    previousEnd = range.end;
  }
  return ranges;
}

const worker = {
  async fetch(request: Request, env: WorkerBindings): Promise<Response> {
    const url = new URL(request.url);
    const readerApi = /^\/api\/(?:read|[rs]\/[0-9A-Za-z]{6})$/.test(url.pathname);
    if (readerApi) url.pathname = url.pathname.slice("/api".length);
    if (url.pathname.startsWith("/read/highlight/")) {
      const code = url.pathname.slice("/read/highlight/".length);
      const id = shareCodeId(code);
      if (id === null) return highlightError("未找到文章。", 404);
      if (!env.HIGHLIGHTS_DB) return highlightError("划线数据库未配置。", 503);
      const db = env.HIGHLIGHTS_DB;
      return favoriteRequest(request, env, code, async (_desired, data) => {
        if (data.get("action") === "verify") return { verified: true };
        if (data.get("action") === "delete") {
          const highlightId = data.get("id") || "";
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(highlightId)) throw highlightError("划线无效。", 400);
          try {
            const result = await db.prepare("DELETE FROM highlights WHERE id=? AND excerpt_number=?").bind(highlightId, id).run();
            return { id: highlightId, deleted: (result.meta?.changes ?? 0) > 0 };
          } catch (error) {
            if (error instanceof Response) throw error;
            throw highlightError("取消划线失败，请稍后再试。", 502);
          }
        }
        const field = data.get("field") || "";
        const quote = data.get("quote") || "";
        const explaining = data.get("action") === "explain";
        const matchingOriginal = data.get("action") === "original";
        if (!/^(original|translation|terms)$/.test(field)) throw highlightError("选区无效。", 400);
        const ranges = highlightRanges(data, explaining || matchingOriginal);
        const { start, end } = ranges[0]!;
        if (!env.NOTION_TOKEN || !env.NOTION_EXCERPTS_DATA_SOURCE_ID) throw highlightError("文章服务未配置。", 503);
        const excerpt = await fetchExcerptByShortId({ NOTION_TOKEN: env.NOTION_TOKEN, NOTION_DATA_SOURCE_ID: env.NOTION_EXCERPTS_DATA_SOURCE_ID }, id);
        if (!excerpt) throw highlightError("未找到文章。", 404);
        const text = bodyText(excerpt, field);
        if (text === null) throw highlightError("划线内容不存在。", 400);
        if (ranges.some(range => text.slice(range.start, range.end) !== canonicalText(range.quote))) throw highlightError("正文已更新，请刷新后重试。", 409);
        if (explaining) {
          if (!env.AI302_API_KEY) throw highlightError("解释服务未配置，请设置 AI302_API_KEY。", 503);
          const context = field === "original" ? (excerpt.chinese ? excerpt.body : excerpt.originalBody || "") : field === "terms" ? excerpt.terms : excerpt.body;
          const source = excerpt.originalUrl ? `\n原文地址：${excerpt.originalUrl}` : "";
          const response = await fetch("https://api.302.ai/v1/responses", {
            method: "POST",
            headers: { Authorization: `Bearer ${env.AI302_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ model: "gpt-6-luna", store: false, reasoning: { effort: "none" }, max_output_tokens: 1500,
              input: `文章标题：${excerpt.title}${source}\n文章上下文（过长时可能截断）：\n${context.slice(0, 40000)}\n\n解释一下：${ranges.map(range => range.quote).join("\n")}` }),
            signal: AbortSignal.timeout(60000),
          });
          if (!response.ok) {
            const failure = await response.json().catch(() => null) as { error?: { type?: unknown; code?: unknown } } | null;
            console.error("Explanation API request failed", { status: response.status, type: typeof failure?.error?.type === "string" ? failure.error.type : undefined, code: typeof failure?.error?.code === "string" ? failure.error.code : undefined });
            throw highlightError("解释服务暂不可用，请稍后再试。", 502);
          }
          const result = await response.json() as { status?: string; output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> };
          const explanation = result.output?.flatMap(item => item.type === "message" ? item.content || [] : []).filter(part => part.type === "output_text" && typeof part.text === "string").map(part => part.text).join("\n").trim();
          if (!explanation || result.status === "incomplete") throw highlightError("未能生成完整解释，请稍后再试。", 502);
          return { explanation, markdown: explanationMarkdown(explanation) };
        }
        if (matchingOriginal) {
          if (!env.AI302_API_KEY) throw highlightError("原文匹配服务未配置，请设置 AI302_API_KEY。", 503);
          if (excerpt.chinese || !excerpt.originalBody) throw highlightError("这篇文章没有可匹配的原文。", 400);
          const allCandidates = einkParagraphTexts(excerpt.originalBody, excerpt.id)
            .map((paragraph) => paragraph.replace(IMAGE_TAG, " ").replace(HTML_IMG, " ").trim())
            .filter((paragraph) => canonicalText(paragraph).length > 0);
          if (!allCandidates.length) throw highlightError("这篇文章没有可匹配的原文。", 400);
          const estimatedIndex = Math.min(allCandidates.length - 1, Math.floor((start / Math.max(text.length, 1)) * allCandidates.length));
          const firstCandidate = Math.max(0, estimatedIndex - JEV_CANDIDATE_RADIUS);
          const lastCandidate = Math.min(allCandidates.length, estimatedIndex + JEV_CANDIDATE_RADIUS + 1);
          const candidates = allCandidates.slice(firstCandidate, lastCandidate);
          const criteria = Object.fromEntries(candidates.map((paragraph, index) => [`p${index}`, Array.from(paragraph).slice(0, JEV_CANDIDATE_TEXT_LIMIT).join("")]));
          const response = await fetch("https://api.302.ai/typesafeai/v1/systemone", {
            method: "POST",
            headers: { Authorization: `Bearer ${env.AI302_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "jev-latest",
              state: JSON.stringify({ title: excerpt.originalTitle || excerpt.title, selected_paragraph: ranges.map((range) => range.quote).join("\n"), estimated_source_position: `${estimatedIndex + 1} / ${allCandidates.length}` }),
              questions: { match: { type: "choice", instructions: "从原文候选段落中，选择与所选译文段落内容最对应的原文。依据语义、实体、细节和段落主旨匹配，不要只按关键词匹配。若都不匹配，也选择最可能的一段。", criteria } },
            }),
            signal: AbortSignal.timeout(30000),
          });
          if (!response.ok) {
            console.error("302.AI Jev request failed", { status: response.status });
            throw highlightError("原文匹配服务暂不可用，请稍后再试。", 502);
          }
          const result = await response.json() as { answers?: { match?: { type?: string; choice?: string; confidence?: number } } };
          const answer = result.answers?.match;
          const choice = answer?.type === "choice" ? answer.choice || "" : "";
          const confidence = answer?.confidence;
          const index = /^p(?:0|[1-9]\d{0,2})$/.test(choice) ? Number(choice.slice(1)) : -1;
          if (index < 0 || index >= candidates.length || typeof confidence !== "number") throw highlightError("未能匹配原文段落，请稍后再试。", 502);
          return { paragraph: candidates[index], confidence };
        }
        const cleanQuote = canonicalText(quote);
        const hash = await hashText(text), uuid = crypto.randomUUID();
        await db.prepare('INSERT OR IGNORE INTO highlights (id,excerpt_number,excerpt_page_id,field,start,"end",quote,prefix,suffix,body_hash,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM highlights WHERE excerpt_number=?) < 200')
          .bind(uuid, id, excerpt.id, field, start, end, Array.from(quote).length <= 1500 ? quote : cleanQuote, text.slice(Math.max(0, start - 32), start), text.slice(end, end + 32), hash, new Date().toISOString(), id).run();
        const row = await db.prepare('SELECT id,field,start,"end" FROM highlights WHERE excerpt_number=? AND excerpt_page_id=? AND field=? AND start=? AND "end"=? AND body_hash=?').bind(id, excerpt.id, field, start, end, hash).first<ResolvedHighlight>();
        if (!row) throw highlightError("每篇文章最多保存 200 条划线。", 429);
        return { highlight: row };
      }, einkDocument, { maxBytes: 16384, errorMessage: "请求失败，请稍后再试。" });
    }
    if (url.pathname.startsWith("/read/add-later/")) {
      const code = url.pathname.slice("/read/add-later/".length);
      const shortId = shareCodeId(code);
      if (shortId === null) return new Response("Not found", { status: 404 });
      return favoriteRequest(request, env, code, async () => {
        if (!env.NOTION_TOKEN || !env.NOTION_EXCERPTS_DATA_SOURCE_ID) throw new Error("Notion is not configured");
        const excerpt = await fetchExcerptByShortId({ NOTION_TOKEN: env.NOTION_TOKEN, NOTION_DATA_SOURCE_ID: env.NOTION_EXCERPTS_DATA_SOURCE_ID }, shortId);
        if (!excerpt) return false;
        await addReadLater(env, excerpt.originalUrl || new URL(`/s/${code}`, url.origin).toString(), excerpt.originalTitle || excerpt.title);
        return { added: true };
      }, einkDocument, { errorMessage: "加入待读失败，请稍后再试。" });
    }
    if (url.pathname.startsWith("/read/favorite/")) {
      const code = url.pathname.slice("/read/favorite/".length);
      const shortId = shareCodeId(code);
      if (shortId === null) return new Response("Not found", { status: 404 });
      return favoriteRequest(request, env, code, async (desired) => {
        if (!env.NOTION_TOKEN || !env.NOTION_EXCERPTS_DATA_SOURCE_ID) throw new Error("Notion is not configured");
        const excerpt = await fetchExcerptByShortId({ NOTION_TOKEN: env.NOTION_TOKEN, NOTION_DATA_SOURCE_ID: env.NOTION_EXCERPTS_DATA_SOURCE_ID }, shortId);
        if (!excerpt || !NOTION_PAGE_ID.test(excerpt.id)) return false;
        const response = await fetchNotionJson(`https://api.notion.com/v1/pages/${encodeURIComponent(excerpt.id)}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
          body: JSON.stringify({ properties: { "已收藏": { checkbox: desired } } }),
        });
        if (!response.ok) throw new Error(`Notion returned ${response.status}`);
        return true;
      }, einkDocument);
    }
    if (url.pathname === "/read/later.xml") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
      }
      return readLaterFeed(request, env);
    }
    const category = readCategory(url.searchParams.get("tab") ?? url.searchParams.get("category"));
    const page = readPage(url.searchParams.get("page"));
    const coverId = coverIdFromPath(url.pathname);
    const isBookFeed = url.pathname === BOOK_FEED_PATH;
    const isExcerptFeed = url.pathname === READ_FEED_PATH;
    const isEinkList = readerApi && url.pathname === READ_LIST_PATH;
    const detailShortId = readerApi ? pathCodeId(url.pathname, READ_DETAIL_PREFIX) : null;
    const shortId = detailShortId ?? (readerApi ? pathCodeId(url.pathname, SHORT_SHARE_PREFIX) : null);
    const imageMatch = url.pathname.match(/^\/read\/p\/([^/]+)\/([^/]+)$/);
    const imageIds = imageMatch && NOTION_PAGE_ID.test(imageMatch[1] ?? "") && NOTION_PAGE_ID.test(imageMatch[2] ?? "") ? [imageMatch[1]!, imageMatch[2]!] : null;
    const usesExcerpts = isExcerptFeed || isEinkList || shortId !== null || Boolean(imageIds);
    if (!isBookFeed && !usesExcerpts && !coverId) {
      return readerApi ? highlightError("未找到文章。", 404) : new Response("Not found", { status: 404 });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    const notionToken = env.NOTION_TOKEN;
    const dataSourceId = usesExcerpts ? env.NOTION_EXCERPTS_DATA_SOURCE_ID : env.NOTION_DATA_SOURCE_ID;
    const useFavoritesView = (isEinkList || detailShortId !== null) && category === "favorites";
    const excerptsViewId = useFavoritesView ? env.NOTION_EXCERPTS_FAVORITES_VIEW_ID : env.NOTION_EXCERPTS_VIEW_ID;
    const needsView = isExcerptFeed || (isEinkList && category !== "highlights");
    if (!notionToken || !dataSourceId || (needsView && !excerptsViewId)) {
      return readerApi ? highlightError("阅读服务未配置。", 503) : new Response("Feed is not configured", { status: 503 });
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

      if (shortId !== null) {
        const showNavigation = detailShortId !== null;
        // Load the selected list in parallel so prev/next follow the same order as /read.
        const excerptPromise = fetchExcerptByShortId(configured, shortId);
        const highlightPromise = env.HIGHLIGHTS_DB && showNavigation ? Promise.resolve().then(() => env.HIGHLIGHTS_DB!.prepare('SELECT * FROM highlights WHERE excerpt_number=? ORDER BY created_at, id').bind(shortId).all<HighlightRow>()).then(r => r.results).catch(error => { captureException(error); console.error("Failed to load highlights", error); return [] as HighlightRow[]; }) : Promise.resolve([] as HighlightRow[]);
        const listPromise = env.HIGHLIGHTS_DB && showNavigation && category === "highlights"
          ? Promise.resolve().then(() => env.HIGHLIGHTS_DB!.prepare('SELECT excerpt_number FROM highlights ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?').bind(FEED_ITEM_LIMIT, (page - 1) * FEED_ITEM_LIMIT).all<{ excerpt_number: number }>()).then(async result => {
              const ids = [...new Set(result.results.map(row => row.excerpt_number))];
              const excerpts = await fetchHighlightExcerpts(configured, ids);
              return ids.flatMap(id => excerpts.has(id) ? [excerpts.get(id)!] : []);
            }).catch(error => { captureException(error); console.error("Failed to load highlight navigation", error); return [] as Excerpt[]; })
          : excerptsViewId && showNavigation && category !== "highlights"
          ? fetchExcerptPages(configured, excerptsViewId, category, page * FEED_ITEM_LIMIT).then((pages) =>
            pages.map(excerptFromPage).filter((item): item is Excerpt => item !== null)).catch((error) => {
              captureException(error);
              console.error("Failed to load article navigation", error);
              return [] as Excerpt[];
            })
          : Promise.resolve([] as Excerpt[]);
        const [excerpt, list, highlightRows] = await Promise.all([excerptPromise, listPromise, highlightPromise]);
        // Cache misses too, so probing unused codes does not reach Notion on every request.
        if (!excerpt) return readerApi ? highlightError("未找到文章。", 404) : new Response("Not found", { status: 404, headers: { "Cache-Control": "public, max-age=300" } });
        const neighbors = neighborsFor(list, excerpt.code) ?? { prevCode: null, nextCode: null };
        const highlights = showNavigation ? await resolveHighlights(excerpt, highlightRows) : [];
        const paragraphs = (text: string) => readerParagraphs(text, excerpt.id, READ_ASSET_PREFIX);
        return readerResponse({
          item: readerItem(excerpt),
          lang: excerpt.lang,
          originalLang: excerpt.originalLang,
          originalTitle: formatText(excerpt.originalTitle),
          originalUrl: excerpt.originalUrl,
          publisher: formatText(excerpt.publisher),
          chapter: formatText(excerpt.chapter),
          date: excerpt.publishedDate,
          field: excerpt.chinese ? "original" : "translation",
          body: paragraphs(excerpt.body),
          original: showNavigation && !excerpt.chinese ? paragraphs(excerpt.originalBody ?? "") : [],
          terms: showNavigation ? paragraphs(excerpt.terms) : [],
          actions: showNavigation ? {
            favorite: Boolean(excerpt.favorite),
            notionUrl: excerpt.link,
            highlightsEnabled: Boolean(env.HIGHLIGHTS_DB),
            highlights,
            ...neighbors,
          } : null,
        }, request.method, !showNavigation);
      }

      if (isEinkList && category === "highlights") {
        const { rows, excerpts, resolved, hasMore } = await loadHighlightList(env.HIGHLIGHTS_DB, configured, page);
        return readerResponse({
          kind: "highlights", hasMore, available: Boolean(env.HIGHLIGHTS_DB),
          items: rows.map(row => {
            const excerpt = excerpts.get(row.excerpt_number);
            return { id: row.id, quote: row.quote, located: resolved.has(row.id), article: excerpt ? readerItem(excerpt) : null };
          }),
        }, request.method, false);
      }
      if (isEinkList) {
        const limit = page * FEED_ITEM_LIMIT;
        const pages = await fetchExcerptPages(configured, excerptsViewId!, category, limit + 1);
        const excerpts = pages.slice(0, limit)
          .map(excerptFromPage)
          .filter((item): item is Excerpt => item !== null);
        return readerResponse({
          kind: "articles", items: excerpts.map(readerItem), hasMore: pages.length > limit && page < 999,
        }, request.method, category !== "favorites");
      }

      const feedUrl = `${url.origin}${url.pathname}`;
      const feed = isExcerptFeed
        ? renderExcerptFeed(
          (await fetchExcerptPages(configured, excerptsViewId!)).map(excerptFromPage).filter((item): item is Excerpt => item !== null),
          feedUrl,
        )
        : renderFeed(
          (await fetchPages(configured)).map(bookFromPage).filter((item): item is Book => item !== null),
          feedUrl,
        );
      return new Response(request.method === "HEAD" ? null : feed, {
        headers: {
          "Content-Type": "application/rss+xml; charset=utf-8",
          // Cache for five minutes, but never serve an expired feed if Notion fails.
          "Cache-Control": "public, max-age=300, must-revalidate",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      logger.error("Failed to build RSS or reader response");
      captureException(error);
      console.error(coverId || imageIds ? "Failed to load image" : isEinkList || shortId !== null ? "Failed to build e-ink page" : "Failed to build book RSS", error);
      if (readerApi) return highlightError("暂时无法读取，请稍后重试。", 502);
      return new Response(
        coverId || imageIds ? "Image temporarily unavailable" : isEinkList || shortId !== null ? "Page temporarily unavailable" : "Feed temporarily unavailable",
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }
  },
};

export default worker;
