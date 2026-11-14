import { generateRssFeed, type RssFeed } from "feedsmith";
import { canonicalText, hashText, resolveAnchor } from "./highlight-anchor.ts";
import { formatText } from "./format-text.ts";
import { readLaterFeed } from "./read-later.ts";
import { favoriteRequest, PIN_FIELD, PIN_STYLE, type FavoriteBindings } from "./favorite.ts";
import { explanationMarkdown } from "./explanation-markdown.ts";

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

const READ_CATEGORIES = [
  { id: "all", label: "全部" },
  { id: "weekly", label: "周刊" },
  { id: "bunshun", label: "文春" },
  { id: "novel", label: "连载" },
  { id: "news", label: "IT" },
  { id: "favorites", label: "收藏" },
  { id: "highlights", label: "划线" },
  { id: "later", label: "稍后阅读" },
] as const;
type ReadCategory = typeof READ_CATEGORIES[number]["id"];

function readCategory(value: string | null): ReadCategory {
  return READ_CATEGORIES.find((category) => category.id === (value === "likes" ? "favorites" : value))?.id ?? "all";
}

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

function categorySearch(category: ReadCategory, page = 1): string {
  const params = new URLSearchParams();
  if (category !== "all") params.set("tab", category === "favorites" ? "likes" : category);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `?${query}` : "";
}

function categoryFilter(category: ReadCategory): object | undefined {
  if (category === "later") return { property: "提取来源", select: { equals: "Instapaper" } };
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

function einkOriginalTitle(excerpt: Excerpt): string {
  if (!excerpt.originalUrl && (!excerpt.originalTitle || excerpt.originalTitle === excerpt.title)) return "";

  const label = einkText("原文：");
  const lang = htmlText(excerpt.originalTitle ? excerpt.originalLang : excerpt.titleLang);
  const title = einkText(excerpt.originalTitle || excerpt.title);
  return excerpt.originalUrl
    ? `${label}<a class="metadata-link" lang="${lang}" href="${htmlText(excerpt.originalUrl)}">${title}</a>`
    : `${label}<span lang="${lang}">${title}</span>`;
}

function excerptDetailBody(excerpt: Excerpt, imageBaseUrl: string, showActions: boolean, category: ReadCategory, page: number, highlightsEnabled: boolean): string {
  const query = categorySearch(category, page);
  const favoriteUrl = `/read/favorite/${excerpt.code}${query}${query ? "&" : "?"}favorite=${excerpt.favorite ? "0" : "1"}`;
  const source = [
    excerpt.sourceTitle ? `<cite>${einkText(excerpt.sourceTitle)}</cite>` : "",
    excerpt.author ? einkText(`作者：${excerpt.author}`) : "",
  ].filter(Boolean).join(" · ");
  const details = [
    einkOriginalTitle(excerpt),
    excerpt.publisher ? einkText(`来源：${excerpt.publisher}`) : "",
    excerpt.chapter ? einkText(`章节：${excerpt.chapter}`) : "",
    einkText(`日期：${excerpt.publishedDate || "—"}`),
  ].filter(Boolean);
  const body = excerpt.body ? einkParagraphs(excerpt.body, excerpt.id, imageBaseUrl) : "";
  const originalBody = showActions && !excerpt.chinese && excerpt.body && excerpt.originalBody
    ? einkParagraphs(excerpt.originalBody, excerpt.id, imageBaseUrl) : "";
  const terms = showActions && excerpt.terms ? einkParagraphs(excerpt.terms, excerpt.id, imageBaseUrl) : "";
  return [
    ...(source ? [`<p>${source}</p>`] : []),
    ...(body ? [`<div class="excerpt-body"${originalBody ? ' id="translated-body"' : ""}${highlightsEnabled ? ` data-field="${excerpt.chinese ? "original" : "translation"}"` : ""} lang="${htmlText(excerpt.lang)}">\n${body}\n</div>`] : []),
    ...(originalBody ? [`<div class="excerpt-body" id="original-body"${highlightsEnabled ? ' data-field="original"' : ""} lang="${htmlText(excerpt.originalLang)}" hidden>\n${originalBody}\n</div>`] : []),
    ...(showActions && (originalBody || highlightsEnabled) ? [`<dialog id="body-actions" aria-label="正文操作" closedby="any" hidden><div id="body-preview-scroll"><p id="body-preview"></p></div><div id="body-actions-buttons"><button type="button" id="body-toggle"${originalBody && highlightsEnabled ? "" : " hidden"}>显示原文</button>${highlightsEnabled ? ' <button type="button" id="body-explain" hidden>解释</button>' : ""} <button type="button" id="body-highlight" hidden>划线</button>${highlightsEnabled ? ' <button type="button" id="body-unhighlight">取消划线</button>' : ""}</div></dialog>`] : []),
    ...(showActions ? [`<p class="other">${originalBody ? '<button type="button" class="other-link" id="body-view-toggle" aria-controls="original-body" aria-expanded="false" hidden>显示原文</button> ' : ""}<a class="other-link" id="favorite-link" data-favorite="${excerpt.favorite ? "true" : "false"}" href="${htmlText(favoriteUrl)}"><span id="favorite-status" role="status">${excerpt.favorite ? "取消收藏" : "收藏"}</span></a> <a class="other-link" href="${htmlText(excerpt.link)}">管理</a> <button type="button" class="other-link" id="share-copy" data-path="${htmlText(`${SHORT_SHARE_PREFIX}/${excerpt.code}`)}"><span id="share-status" role="status">分享</span></button></p><p id="favorite-message" role="status"></p><dialog id="favorite-dialog" aria-label="收藏验证"><form id="favorite-form" method="post" action="${htmlText(favoriteUrl)}">${PIN_FIELD}<p id="favorite-error" role="alert"></p></form><form method="dialog"><button type="submit" class="favorite-close">取消</button></form></dialog>`] : []),
    "<hr />",
    `<p class="detail-metadata">${details.join("<br />\n")}</p>`,
    ...(terms ? ["<hr />", `<p>${einkText("名词解释")}</p>`, highlightsEnabled ? `<div class="excerpt-body" data-field="terms">\n${terms}\n</div>` : terms] : []),
  ].join("\n");
}

// E-ink: pure black/white, serif, wide leading, capped line length, no motion/hover-only UI.
const EINK_STYLE = [
  "*,*::before,*::after{box-sizing:border-box;animation:none!important;transition:none!important;}",
  "html{-webkit-text-size-adjust:100%;}",
  "html,body{scrollbar-width:none;-ms-overflow-style:none;}html::-webkit-scrollbar,body::-webkit-scrollbar{display:none;width:0;height:0;}",
  // Fixed rem gutters + main max-width (no vw); Kindles often ignore CSS min()/max().
  // OS-bundled faces first: Safari hides user-installed fonts, and partial installs (e.g. Heavy only) render body text too bold in Chrome.
  "body{margin:0;padding:1.25rem 1.625rem 2.5rem;font-family:serif;font-size:1.0625rem;font-weight:400;line-height:1.75;letter-spacing:normal;text-align:left;word-break:normal;overflow-wrap:break-word;color:#000;background:#fff;}",
  ":lang(zh){font-family:\"Songti SC\",\"STSong\",\"Noto Serif CJK SC\",\"SimSun\",serif;}",
  ":lang(ja){font-family:\"Hiragino Mincho ProN\",\"Hiragino Mincho Pro\",\"Yu Mincho\",\"YuMincho\",\"Noto Serif CJK JP\",\"MS PMincho\",serif;}",
  ":lang(en){font-family:Georgia,\"Times New Roman\",serif;}",
  ":lang(zh),:lang(ja){line-break:strict;}",
  // Pangu already inserts mixed-script spaces; leave unsupported CSS harmless on old readers.
  "body{text-autospace:no-autospace;}",
  // 6\" Kindle: 365px column. Scribe (≥720px): 36rem + larger type.
  "main{max-width:365px;margin:0 auto;}",
  "h1{font-size:1.5rem;line-height:1.35;font-weight:700;margin:0 0 1rem;}",
  // Keep mixed-language reading text evenly spaced and scale paragraph gaps with its size.
  "p{margin:0.85em 0;}",
  "li{margin:0;}",
  "ul{list-style:none;margin:0;padding:0;}",
  "li{border-top:2px solid #000;padding:2rem 0;}",
  "li:last-child{border-bottom:2px solid #000;}",
  // Fragment return from detail: no UA focus ring (scroll centering is JS).
  "li:focus{outline:none;}",
  "li:target{position:relative;padding-left:0.9rem;}",
  // Center the marker on the title's first line; retain the old offset for older readers.
  "li:target::before{content:\"\";position:absolute;left:0;top:2.35rem;top:calc(2rem + 0.525em);width:0;height:0;border-top:0.35em solid transparent;border-bottom:0.35em solid transparent;border-left:0.55em solid #000;}",
  "a{color:#000;text-decoration:none;}",
  "a:hover{text-decoration:underline;text-underline-offset:0.35em;}",
  "a:focus-visible{outline:3px solid #000;outline-offset:3px;}",
  ".item-link{display:block;font-weight:700;}",
  ".categories{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0.2rem;margin:0 0 1rem;}",
  ".visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;}",
  ".categories a{min-width:0;display:flex;align-items:center;justify-content:center;min-height:2.2rem;padding:0.2rem 0.1rem;border:1px solid #000;font-size:0.85em;font-weight:700;text-align:center;}",
  ".categories{position:fixed;z-index:2;left:1.625rem;right:1.625rem;bottom:0;width:auto;max-width:365px;margin:0 auto;padding:0.65rem 0;padding-bottom:calc(0.65rem + env(safe-area-inset-bottom, 0px));background:#fff;border-top:1px solid #000;box-sizing:border-box;}",
  ".categories::after{content:'';position:absolute;top:100%;left:0;right:0;height:100vh;background:#fff;pointer-events:none;}",
  "@media (min-width:440px){.categories{left:1.25rem;right:1.25rem;}}",
  "@media (min-width:720px){.categories{left:1.25rem;right:1.25rem;max-width:36rem;}}",
  "body.read-list{padding-top:max(1.25rem,env(safe-area-inset-top, 0px));padding-bottom:calc(8rem + env(safe-area-inset-bottom, 0px));}",

  ".categories a[aria-current=page]{background:#000;color:#fff;}",
  ".meta{font-size:1rem;margin:0.65em 0 0;}",
  // Responsive type must follow the base heading/meta rules to win the cascade.
  "@media (min-width:440px){body{font-size:1.125rem;padding-right:1.25rem;padding-left:1.25rem;}}",
  "@media (min-width:720px){body{font-size:1.25rem;}h1{font-size:1.65rem;}.meta{font-size:1.0625rem;}main{max-width:36rem;}}",
  ".nav-row{display:flex;gap:0.5rem;align-items:stretch;margin:0.85rem 0;}",
  ".nav-row[hidden]{display:none;}",
  ".nav-row a,.nav-row span{flex:1;display:flex;align-items:center;justify-content:center;min-height:3rem;padding:0.75rem 0.35rem;font-weight:700;text-align:center;}",
  ".nav-row .is-disabled{opacity:0.4;}",
  ".nav-row a:focus-visible{outline:3px solid #000;outline-offset:3px;}",
  "a.metadata-link{text-decoration:underline;text-decoration-thickness:1px;text-decoration-skip-ink:none;text-underline-offset:0.28em;}",
  ".btn{display:block;border:2px solid #000;padding:0.85rem 1rem;margin:0.75rem 0;text-align:center;text-decoration:none;font-weight:700;min-height:3rem;}",
  ".btn:focus-visible{outline:3px solid #000;outline-offset:3px;}",
  ".detail-metadata{margin-bottom:0;}",
  ".other{margin:0;}",
  ".other-link{color:inherit;font:inherit;text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:0.28em;}",
  ".other-link + .other-link{margin-left:0.35em;}",
  "button.other-link{padding:0;border:0;background:transparent;cursor:pointer;}",
  "button.other-link:focus-visible{outline:3px solid #000;outline-offset:3px;}",
  ".other-link[aria-disabled=true]{opacity:0.4;cursor:default;}",
  PIN_STYLE,
  "#favorite-dialog:not([open]){display:none;}#favorite-dialog{width:calc(100% - 3rem);max-width:24rem;padding:1.5rem;border:2px solid #000;background:#fff;color:#000;}",
  "#favorite-dialog:modal{overscroll-behavior:contain;}#favorite-dialog::backdrop{background:rgba(0,0,0,0.45);overflow:hidden;overscroll-behavior:contain;}",
  "#favorite-dialog p:first-child{margin-top:0;}#favorite-error:empty,#favorite-message:empty{display:none;}.favorite-close{display:block;margin:1rem auto 0;border:0;background:none;color:inherit;font:inherit;text-decoration:underline;cursor:pointer;min-height:3rem;min-width:3rem;}.favorite-close:focus-visible{outline:3px solid #000;outline-offset:3px;}",
  "#highlight-error[hidden]{display:none}#highlight-error:not([open]){display:none}#highlight-error{position:fixed;z-index:12;top:50%;left:50%;width:calc(100% - 3rem);max-width:24rem;margin:0;padding:1.5rem;border:2px solid #000;background:#fff;color:#000;transform:translate(-50%,-50%)}#highlight-error:modal{overscroll-behavior:contain}#highlight-error::backdrop{background:rgba(0,0,0,0.45);overflow:hidden;overscroll-behavior:contain}#highlight-error p{margin:0}#highlight-error div{display:flex;justify-content:flex-end;margin-top:1rem}#highlight-error button{flex:none;min-height:2.25rem;min-width:3.25rem;margin:0 0 0 0.35rem;padding:0.2rem 0.5rem;border:1px solid #000;background:#fff;color:#000;font:inherit}#highlight-error button:focus-visible{outline:3px solid #000;outline-offset:3px}",
  ".list-actions{display:flex;justify-content:flex-end;gap:0.25rem;margin:1rem 0 2rem;}",
  ".list-actions .btn{flex:none;min-width:3.25rem;min-height:2.25rem;margin:0.15rem 0;padding:0.2rem 0.5rem;border:0;background:#fff;font:inherit;text-align:center;}",
  ".list-actions .btn[hidden]{display:none;}",
  ".list-actions #load-more[aria-disabled=true]{color:#777;opacity:0.55;pointer-events:none;}",
  "img{max-width:100%;height:auto;display:block;margin:1rem 0;}",
  // Mobile article images may extend beyond the reading column to the screen edges.
  "@media (max-width:440px){@supports (container-type:inline-size) and (width:100cqw){html{container-type:inline-size;}.excerpt-body img{width:100cqw;max-width:none;margin-left:calc(50% - 50cqw);}}}",
  "hr{border:0;border-top:2px solid #000;margin:1.5rem 0;}",
  "cite{font-style:normal;font-weight:700;}",
  // Thin bottom progress track; width updates from scroll position (no animation).
  ".progress{position:fixed;left:0;right:0;bottom:0;height:4px;background:#fff;border-top:1px solid #000;z-index:1;}",
  ".progress-bar{display:block;height:100%;width:0;background:#000;}",
  "#body-actions[hidden]{display:none}#body-actions:modal{overscroll-behavior:contain}#body-actions::backdrop{background:transparent;overflow:hidden;overscroll-behavior:contain}#body-actions{position:fixed;z-index:9;top:auto;right:0;bottom:4px;left:0;background:#fff;border:0;border-top:1px solid #000}#body-actions div{display:flex;justify-content:flex-end}#body-actions button{flex:none;min-height:2.25rem;min-width:3.25rem;margin:0.15rem;padding:0.2rem 0.5rem;border:1px solid #000;background:#fff;color:#000;font:inherit}#body-toggle{order:0}#body-highlight{order:1}#body-unhighlight{order:2}#body-actions[data-mode=mark] #body-toggle,#body-actions[data-mode=mark] #body-highlight{display:none}#body-actions:not([data-mode=mark]) #body-unhighlight{display:none}#body-actions button:focus{outline:none}#body-actions button[hidden]{display:none}mark.hl{background:none;color:inherit;border-bottom:2px solid #000}",


  "#body-actions[open]{width:calc(100% - 3.25rem);max-width:365px;margin:0 auto;display:flex;flex-direction:column;box-sizing:border-box;bottom:0;height:auto;max-height:90vh;padding:1rem;border-top:0;font-size:0.9375rem;line-height:1.6}#body-actions::backdrop{background:rgba(0,0,0,.35)}#body-actions #body-preview-scroll{display:block;flex:none;height:32vh;max-height:calc(90vh - 6rem);min-height:0;overflow-y:auto}#body-preview{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}#body-actions #body-actions-buttons{flex:none;display:flex;justify-content:flex-end;margin:0 -1rem;padding:0.75rem 1rem 0;border-top:1px solid #000}@media (min-width:440px){#body-actions{width:calc(100% - 2.5rem)}}@media (min-width:720px){#body-actions{max-width:36rem}}",
  "#body-actions #body-toggle{margin-right:auto}#body-explain{order:1}#body-highlight{order:2}#body-unhighlight{order:3}#explanation-dialog[open],#original-match-dialog[open]{position:fixed;inset:0;width:calc(100% - 3.25rem);max-width:365px;max-height:80vh;overflow:auto;background:#fff;color:#000;border:2px solid #000;padding:1rem}@media (min-width:440px){#explanation-dialog[open],#original-match-dialog[open]{width:calc(100% - 2.5rem)}}@media (min-width:720px){#explanation-dialog[open],#original-match-dialog[open]{max-width:36rem}}#explanation-dialog:modal,#original-match-dialog:modal{overscroll-behavior:contain}#explanation-dialog::backdrop,#original-match-dialog::backdrop{background:rgba(0,0,0,.35);overflow:hidden;overscroll-behavior:contain}#explanation-text,#original-match-text{white-space:pre-wrap;overflow-wrap:anywhere}",
  "#body-actions button{font-size:0.9375rem;line-height:1.6}",
  "#body-actions button:disabled{opacity:0.4;}",

  "#explanation-dialog,#original-match-dialog{font-size:0.9375rem;line-height:1.6}#explanation-dialog[open],#original-match-dialog[open]{display:flex;flex-direction:column;overflow:hidden}#explanation-text{flex:1;min-height:0;overflow-y:auto;white-space:normal}#original-match-content{display:flex;flex:1;flex-direction:column;min-height:0}#original-match-content section{flex:1;min-height:0;overflow-y:auto;padding:0.35rem 0;white-space:pre-wrap;overflow-wrap:anywhere}#original-match-content section:first-child{padding-bottom:1rem;padding-block-end:1rem}#original-match-content section+section{border-top:1px solid #000;padding-top:1rem;padding-block-start:1rem}#original-match-content h2{margin:0 0 0.35rem;font-size:0.875rem;line-height:1.4}#original-match-content p{margin:0}#explanation-text :is(ul,ol){list-style:revert;padding-left:1.5em}#explanation-text li,#explanation-text li:last-child{border:0;padding:0;margin:0}#explanation-text :is(h1,h2,h3,h4,h5,h6){font-size:1em;line-height:1.6;margin:0.85em 0;font-weight:700}#explanation-text blockquote{border-left:2px solid #000;margin:0.85em 0;padding-left:0.75em}#explanation-text pre{overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}#explanation-text :is(pre,code){font-family:monospace;font-size:0.95em}",
  "#favorite-dialog .favorite-close{min-height:2.25rem;min-width:3.25rem;margin:0.15rem 0 0.15rem auto;padding:0.2rem 0.5rem;border:1px solid #000;background:#fff;text-decoration:none}",
].join("");

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

// Keep the list's history entry anchored to the article being opened, including
// when it already has an older fragment from a previous "返回列表" navigation.
// Hash targets are scrolled toward the middle of the viewport (not flush top).
const EINK_LIST_NAV = [
  "<script>",
  "(function(){",
  "function centerHash(){",
  "try{",
  "var hash=window.location&&window.location.hash;",
  "if(!hash)return;",
  "var id=decodeURIComponent(hash.slice(1));",
  "if(!id||!document||typeof document.getElementById!=='function')return;",
  "var row=document.getElementById(id);",
  "if(!row||typeof row.scrollIntoView!=='function')return;",
  "row.scrollIntoView({block:'center'});",
  "}catch(err){}",
  "}",
  "centerHash();",
  "if(window.addEventListener){",
  "window.addEventListener('load',centerHash,false);",
  "window.addEventListener('hashchange',centerHash,false);",
  "}",
  "if(!window.history||!window.history.replaceState)return;",
  "document.addEventListener('click',function(e){",
  "if(e.defaultPrevented||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey||(typeof e.button==='number'&&e.button!==0))return;",
  "var link=e.target;",
  "while(link&&link!==document.body&&link.tagName!=='A')link=link.parentNode;",
  "if(!link||link.tagName!=='A'||(' '+link.className+' ').indexOf(' item-link ')<0)return;",
  "if((link.target&&link.target!=='_self')||link.hasAttribute('download'))return;",
  "var row=link.parentNode;",
  "if(!row||row.tagName!=='LI'||!row.id)return;",
  "try{history.replaceState(history.state,'',location.pathname+location.search+'#'+encodeURIComponent(row.id));}catch(err){}",
  "},false);",
  "})();",
  "</script>",
].join("\n");

const EINK_LIST_PAGING = [
  "<script>",
  "(function(){",
  "var main=document.querySelector('main');",
  "if(!main)return;",
  "function direction(x,target){",
  "if(target!==document.body&&target!==document.documentElement)return 0;",
  "var bounds=main.getBoundingClientRect();",
  "return x<bounds.left?-1:x>bounds.right?1:0;",
  "}",
  "function hasSelection(){",
  "var selection=typeof window.getSelection==='function'&&window.getSelection();",
  "return !!(selection&&selection.rangeCount&&!selection.isCollapsed);",
  "}",
  "function go(dir){window.scrollBy(0,dir*Math.max(80,window.innerHeight));}",
  "var start=null,ignoreClickUntil=0,selectionAtStart=false;",
  "document.addEventListener('pointerdown',function(){selectionAtStart=hasSelection();},true);",
  "document.addEventListener('touchstart',function(e){",
  "selectionAtStart=hasSelection();",
  "if(e.touches.length!==1){start=null;return;}",
  "var touch=e.touches[0];",
  "start={x:touch.clientX,y:touch.clientY,time:Date.now(),selected:selectionAtStart,dir:direction(touch.clientX,e.target)};",
  "},true);",
  "document.addEventListener('touchmove',function(e){",
  "if(!start||e.touches.length!==1){start=null;return;}",
  "var touch=e.touches[0];",
  "if(Math.abs(touch.clientX-start.x)>15||Math.abs(touch.clientY-start.y)>15)start=null;",
  "},true);",
  "document.addEventListener('touchcancel',function(){start=null;ignoreClickUntil=Date.now()+800;},true);",
  "document.addEventListener('touchend',function(e){",
  "ignoreClickUntil=Date.now()+800;",
  "var tap=start;start=null;",
  "if(!tap||!tap.dir||e.touches.length||e.changedTouches.length!==1||Date.now()-tap.time>700)return;",
  "var touch=e.changedTouches[0];",
  "if(Math.abs(touch.clientX-tap.x)>15||Math.abs(touch.clientY-tap.y)>15)return;",
  "if(e.defaultPrevented||tap.selected||hasSelection()||direction(touch.clientX,e.target)!==tap.dir)return;",
  "if(e.cancelable)e.preventDefault();",
  "go(tap.dir);",
  "},true);",
  "document.addEventListener('click',function(e){",
  "var selected=selectionAtStart;selectionAtStart=false;",
  "if(Date.now()<ignoreClickUntil||e.defaultPrevented||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey||(typeof e.button==='number'&&e.button!==0)||selected||hasSelection())return;",
  "if(e.pointerType==='mouse'||(window.matchMedia&&window.matchMedia('(hover: hover) and (pointer: fine)').matches))return;",
  "var dir=direction(e.clientX,e.target);",
  "if(dir)go(dir);",
  "},false);",
  "var more=document.getElementById('load-more');",
  "if(more)more.addEventListener('click',function(e){if(more.getAttribute('aria-disabled')==='true'){e.preventDefault();return;}more.setAttribute('aria-disabled','true');more.textContent='正在加载';},false);",
  "})();",
  "</script>",
].join("\n");

// Exclude the return button's own row when deciding whether content overflows.
const EINK_LIST_BACK_TO_TOP = [
  "<script>",
  "(function(){",
  "var top=document.getElementById('back-to-top');",
  "var actions=document.getElementById('list-actions');",
  "var more=document.getElementById('load-more');",
  "var main=document.querySelector('main');",
  "if(!top||!actions||!main)return;",
  "function update(){",
  "var extra=0;",
  "if(!top.hidden){",
  "var moreHeight=0;",
  "if(more){var style=window.getComputedStyle(more);moreHeight=more.offsetHeight+(parseFloat(style.marginTop)||0)+(parseFloat(style.marginBottom)||0);}",
  "extra=Math.max(0,actions.offsetHeight-moreHeight);",
  "}",
  "top.hidden=document.documentElement.scrollHeight-extra<=document.documentElement.clientHeight;",
  "}",
  "update();",
  "window.addEventListener('load',update,false);",
  "window.addEventListener('resize',update,false);",
  "if(typeof ResizeObserver==='function')new ResizeObserver(update).observe(main);",
  "})();",
  "</script>",
].join("\n");

export function renderEinkList(excerpts: Excerpt[], listPath: string, category: ReadCategory = "all", page = 1, hasMore = false): string {
  const items = excerpts.map((excerpt) => {
    const href = htmlText(`${READ_DETAIL_PREFIX}/${excerpt.code}${categorySearch(category, page)}`);
    const meta = [
      excerpt.sourceTitle ? einkText(excerpt.sourceTitle) : "",
      excerpt.author ? einkText(`作者：${excerpt.author}`) : "",
    ].filter(Boolean).join(" · ");
    return [
      `<li id="${htmlText(excerpt.code)}" lang="${htmlText(excerpt.titleLang)}" tabindex="-1">`,
      `<a class="item-link" href="${href}">${einkText(excerpt.title)}</a>`,
      ...(meta ? [`<p class="meta" lang="zh-CN">${meta}</p>`] : []),
      "</li>",
    ].join("");
  }).join("\n");
  return einkDocument("阅读节选", [
    `<h1 class="visually-hidden">${displayText("阅读节选")}</h1>`,
    `<nav class="categories" aria-label="阅读分类">${READ_CATEGORIES.map((item) =>
      `<a${item.id === "later" ? ' class="category-later"' : ""} href="${htmlText(`${listPath}${categorySearch(item.id)}`)}"${item.id === category ? ' aria-current="page"' : ""}>${item.label}</a>`
    ).join("")}</nav>`,
    items ? `<ul>\n${items}\n</ul>` : `<p>${displayText("暂无条目")}</p>`,
    ...((items || hasMore) ? [
      `<div class="list-actions" id="list-actions"><a class="btn" id="back-to-top" href="#" hidden>返回顶部</a>${hasMore ? `<a class="btn" id="load-more" href="${htmlText(`${listPath}${categorySearch(category, page + 1)}${excerpts.length ? `#${excerpts[excerpts.length - 1]!.code}` : ""}`)}">加载更多</a>` : ""}</div>`,
    ] : []),
  ].join("\n"), false, EINK_LIST_NAV + "\n" + EINK_LIST_PAGING + "\n" + EINK_LIST_BACK_TO_TOP, "read-list");
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

function einkNav(listPath: string, code: string, neighbors: EinkNeighbors, category: ReadCategory, page: number, hidden = false): string {
  const prev = neighbors.prevCode
    ? `<a href="${htmlText(`${READ_DETAIL_PREFIX}/${neighbors.prevCode}${categorySearch(category, page)}`)}">${einkText("上一篇")}</a>`
    : `<span class="is-disabled">${einkText("上一篇")}</span>`;
  const next = neighbors.nextCode
    ? `<a href="${htmlText(`${READ_DETAIL_PREFIX}/${neighbors.nextCode}${categorySearch(category, page)}`)}">${einkText("下一篇")}</a>`
    : `<span class="is-disabled">${einkText("下一篇")}</span>`;
  const back = `<a href="${htmlText(`${listPath}${categorySearch(category, page)}#${code}`)}">${einkText("返回列表")}</a>`;
  return `<nav class="nav-row"${hidden ? " hidden" : ""}>\n${prev}\n${back}\n${next}\n</nav>`;
}

// Detail pages: blank-margin tap paging, bottom progress bar, and localStorage resume.
// Links and buttons keep their default click behavior.
const EINK_DETAIL_CHROME = [
  `<div class="progress" aria-hidden="true"><span class="progress-bar" id="progress-bar"></span></div>`,
  "<script>",
  "(function(){",
  "function step(){return Math.max(80,window.innerHeight);}",
  "var main=document.querySelector('main');",
  "function resultDialogVisible(){var a=document.getElementById('explanation-dialog'),b=document.getElementById('original-match-dialog');return !!((a&&!a.hidden)||(b&&!b.hidden));}",
  "function direction(x,target){",
  "if(resultDialogVisible()||!main||(target!==document.body&&target!==document.documentElement))return 0;",
  "var bounds=main.getBoundingClientRect();",
  "return x<bounds.left?-1:x>bounds.right?1:0;",
  "}",
  "function pageKey(){var m=location.pathname.match(/^\\/r\\/([0-9A-Za-z]{6})$/);return m?'eink-progress:'+m[1]:null;}",
  "function scrollMax(){return document.documentElement.scrollHeight-window.innerHeight;}",
  "function scrollRatio(){var max=scrollMax();return max>0?Math.min(1,Math.max(0,(window.scrollY||window.pageYOffset||0)/max)):1;}",
  "function progress(){",
  "var bar=document.getElementById('progress-bar');",
  "if(bar)bar.style.width=(scrollRatio()*100)+'%';",
  "}",
  "var saveTimer=0;",
  "function saveNow(){",
  "var key=pageKey();",
  "if(!key)return;",
  "try{localStorage.setItem(key,String(scrollRatio()));}catch(err){}",
  "}",
  // Manual scroll can fire dozens of events; throttle localStorage writes.
  "function saveSoon(){if(saveTimer)return;saveTimer=setTimeout(function(){saveTimer=0;saveNow();},400);}",
  "function restore(){",
  "if((location.hash||'').indexOf('#hl-')===0)return;",
  "var key=pageKey();",
  "if(!key)return;",
  "var raw;",
  "try{raw=localStorage.getItem(key);}catch(err){return;}",
  "if(raw==null)return;",
  "var p=parseFloat(raw);",
  "if(!(p>=0&&p<=1))return;",
  "var max=scrollMax();",
  "if(max>0)window.scrollTo(0,p*max);",
  "}",
  "var shareCopy=document.getElementById('share-copy');",
  "var translatedBody=document.getElementById('translated-body');",
  "var originalBody=document.getElementById('original-body');",
  "var bodyViewToggle=document.getElementById('body-view-toggle');",
  "function syncBodyViewToggle(){if(!bodyViewToggle||!originalBody)return;bodyViewToggle.hidden=false;bodyViewToggle.textContent=originalBody.hidden?'显示原文':'显示译文';bodyViewToggle.setAttribute('aria-expanded',originalBody.hidden?'false':'true');}",
  "if(bodyViewToggle&&translatedBody&&originalBody){bodyViewToggle.addEventListener('click',function(){var showOriginal=originalBody.hidden;originalBody.hidden=!showOriginal;translatedBody.hidden=showOriginal;syncBodyViewToggle();progress();saveSoon();});window.syncBodyViewToggle=syncBodyViewToggle;syncBodyViewToggle();}",
  "var actionPreview=document.getElementById('body-preview'),actions=document.getElementById('body-actions'),toggle=document.getElementById('body-toggle'),highlightAction=document.getElementById('body-highlight'),explainAction=document.getElementById('body-explain'),unhighlightAction=document.getElementById('body-unhighlight');",
  "if(actions&&document.querySelectorAll){",
  "var tapCount=0,lastTap=0,lastParagraph=null,touchTap=null,mouseTap=null,ignoreBodyClickUntil=0,actionParagraph=null,actionBody=null,actionHighlight=null,actionFocus=null,openingEvent=null,ignoreActionUntil=0,oldPaddingBottom=null,dismissTouch=false,suppressClickUntil=0;",
  "function resetTaps(){tapCount=0;lastTap=0;lastParagraph=null;}",
  "function paragraph(target,body){while(target&&target!==body){if(/^(A|BUTTON|INPUT|SELECT|TEXTAREA|IMG)$/.test(target.tagName||''))return null;if(target.tagName==='P')return target;target=target.parentNode;}return null;}",
  "function scrollY(){return window.scrollY||window.pageYOffset||0;}",
  "function highlightMark(target,body){while(target&&target!==body){if(target.tagName==='MARK'&&target.className==='hl'&&target.getAttribute&&target.getAttribute('data-hl'))return target;target=target.parentNode;}return null;}",
  "function startTap(point,target,body){return {x:point.clientX,y:point.clientY,scroll:scrollY(),time:Date.now(),paragraph:paragraph(target,body),mark:highlightMark(target,body),selected:hasSelection()};}",
  "function validTap(start,point){return start&&(start.paragraph||start.mark)&&Date.now()-start.time<=500&&Math.abs(point.clientX-start.x)<=10&&Math.abs(point.clientY-start.y)<=10&&Math.abs(scrollY()-start.scroll)<=5;}",
  "function closeActions(){if(actions.open&&actions.close)actions.close();actions.hidden=true;actionHighlight=null;if(actions.removeAttribute)actions.removeAttribute('data-mode');if(document.body&&oldPaddingBottom!==null){document.body.style.paddingBottom=oldPaddingBottom;oldPaddingBottom=null;}if(actionFocus&&actionFocus.focus)actionFocus.focus();}",
  "function openActions(mode,event){if(actionPreview){actionPreview.textContent=actionParagraph&&actionParagraph.textContent||'';if(actionPreview.parentNode)actionPreview.parentNode.scrollTop=0;}if(actions.setAttribute)actions.setAttribute('data-mode',mode);openingEvent=event;actions.hidden=false;if(typeof actions.showModal==='function'&&!actions.open)actions.showModal();else if(!actions.open&&actions.setAttribute)actions.setAttribute('open','');if(document.body&&document.body.style){oldPaddingBottom=document.body.style.paddingBottom;document.body.style.paddingBottom=(actions.offsetHeight+40)+'px';}if(window.getSelection){var selection=window.getSelection();if(selection&&selection.removeAllRanges)selection.removeAllRanges();}if(mode==='mark'){if(unhighlightAction)unhighlightAction.focus();}else if(toggle&&!toggle.hidden)toggle.focus();else if(highlightAction&&!highlightAction.hidden)highlightAction.focus();}",
  "function countTap(start,body,event){var now=Date.now();tapCount=lastTap&&now-lastTap<=500&&lastParagraph===start.paragraph?tapCount+1:1;lastTap=now;lastParagraph=start.paragraph;if(tapCount===2){resetTaps();actionParagraph=start.paragraph;actionBody=body;actionFocus=document.activeElement;if(toggle)toggle.hidden=!translatedBody||body!==translatedBody||!window.performParagraphAction;openActions('body',event);}}",
  "function markTap(start){return !!(start.mark&&!start.selected&&!hasSelection()&&window.removeHighlight);}",
  "function openMark(start,body,event){resetTaps();actionParagraph=start.paragraph;actionBody=body;actionHighlight=start.mark.getAttribute('data-hl');actionFocus=document.activeElement;openActions('mark',event);}",
  "if(toggle)toggle.addEventListener('click',function(){if(Date.now()<ignoreActionUntil||toggle.disabled||!window.performParagraphAction)return;toggle.disabled=true;window.performParagraphAction(actionParagraph,actionBody,'original',function(){toggle.disabled=false;if(!actions.hidden)closeActions();});});",
  "if(highlightAction)highlightAction.addEventListener('click',function(){if(Date.now()<ignoreActionUntil)return;closeActions();if(window.performParagraphAction)window.performParagraphAction(actionParagraph,actionBody,'highlight');});",
  "if(explainAction)explainAction.addEventListener('click',function(){if(Date.now()<ignoreActionUntil||explainAction.disabled||!window.performParagraphAction)return;explainAction.disabled=true;window.performParagraphAction(actionParagraph,actionBody,'explain',function(){explainAction.disabled=false;if(!actions.hidden)closeActions();});});",
  "if(unhighlightAction)unhighlightAction.addEventListener('click',function(){if(Date.now()<ignoreActionUntil)return;var id=actionHighlight;closeActions();if(window.removeHighlight)window.removeHighlight(id);});",
  "function outside(e){if(!actions.contains(e.target))return true;if(e.target!==actions)return false;var r=actions.getBoundingClientRect(),p=e.touches&&e.touches.length?e.touches[0]:e;return p.clientX<r.left||p.clientX>r.right||p.clientY<r.top||p.clientY>r.bottom;}",
  "function stop(e){if(e.cancelable)e.preventDefault();if(e.stopImmediatePropagation)e.stopImmediatePropagation();else if(e.stopPropagation)e.stopPropagation();}",
  "document.addEventListener('touchstart',function(e){if(!actions.hidden&&outside(e)){dismissTouch=true;closeActions();stop(e);}},true);",
  "document.addEventListener('touchend',function(e){if(dismissTouch){dismissTouch=false;suppressClickUntil=Date.now()+800;stop(e);}},true);",
  "document.addEventListener('mousedown',function(e){if(!actions.hidden&&outside(e)){suppressClickUntil=Date.now()+800;closeActions();stop(e);}},true);",
  "document.addEventListener('click',function(e){if(Date.now()<suppressClickUntil){suppressClickUntil=0;stop(e);return;}if(!actions.hidden&&e!==openingEvent&&outside(e)){closeActions();stop(e);}},true);",
  "actions.addEventListener('close',function(){if(!actions.hidden)closeActions();});actions.addEventListener('cancel',function(e){e.preventDefault();closeActions();});actions.addEventListener('keydown',function(e){if(e.key==='Escape'||e.keyCode===27){e.preventDefault();closeActions();}});",
  "function bindBody(body){",
  "body.addEventListener('touchstart',function(e){if(resultDialogVisible()||e.touches.length!==1){touchTap=null;resetTaps();return;}touchTap=startTap(e.touches[0],e.target,body);},false);",
  "body.addEventListener('touchmove',function(e){if(!touchTap||e.touches.length!==1||!validTap(touchTap,e.touches[0])){touchTap=null;resetTaps();}},false);",
  "body.addEventListener('touchcancel',function(){touchTap=null;resetTaps();ignoreBodyClickUntil=Date.now()+800;},false);",
  "body.addEventListener('touchend',function(e){ignoreBodyClickUntil=Date.now()+800;var start=touchTap;touchTap=null;if(e.touches.length||e.changedTouches.length!==1||!validTap(start,e.changedTouches[0])){resetTaps();return;}if(markTap(start)){ignoreActionUntil=Date.now()+600;if(e.cancelable)e.preventDefault();openMark(start,body,e);return;}if(tapCount===1&&lastParagraph===start.paragraph&&Date.now()-lastTap<=500){ignoreActionUntil=Date.now()+600;if(e.cancelable)e.preventDefault();}countTap(start,body,e);},false);",
  "body.addEventListener('mousedown',function(e){if(resultDialogVisible()||Date.now()<ignoreBodyClickUntil||e.button!==0||e.ctrlKey||e.metaKey||e.altKey||e.shiftKey){mouseTap=null;return;}mouseTap=startTap(e,e.target,body);},false);",
  "body.addEventListener('click',function(e){if(Date.now()<ignoreBodyClickUntil)return;var start=mouseTap;mouseTap=null;if(e.defaultPrevented||!validTap(start,e)){resetTaps();return;}if(markTap(start)){openMark(start,body,e);return;}countTap(start,body,e);},false);",
  "}",
  "var bodies=document.querySelectorAll('.excerpt-body');for(var i=0;i<bodies.length;i++)bindBody(bodies[i]);",
  "window.addEventListener('scroll',resetTaps,false);",
  "}",
  "var shareStatus=document.getElementById('share-status');",
  "if(shareCopy)shareCopy.addEventListener('click',function(){",
  "var link=location.origin+shareCopy.getAttribute('data-path');",
  "function fallback(){",
  "var input=document.createElement('textarea');input.value=link;input.style.position='fixed';input.style.left='-9999px';document.body.appendChild(input);input.select();",
  "var copied=false;try{copied=document.execCommand('copy');}catch(err){}document.body.removeChild(input);",
  "if(shareStatus)shareStatus.textContent=copied?'已复制':'复制失败';",
  "}",
  "if(window.navigator&&window.navigator.clipboard&&window.navigator.clipboard.writeText){",
  "window.navigator.clipboard.writeText(link).then(function(){if(shareStatus)shareStatus.textContent='已复制';},fallback);",
  "}else fallback();",
  "},false);",
  "function go(dir){window.scrollBy(0,dir*step());progress();saveNow();}",
  "function hasSelection(){",
  "var selection=typeof window.getSelection==='function'&&window.getSelection();",
  "return !!(selection&&selection.rangeCount&&!selection.isCollapsed);",
  "}",
  // The browser can clear the selection between the start of a tap and its click.
  "var selectionAtTapStart=false;",
  "document.addEventListener('pointerdown',function(){",
  "selectionAtTapStart=hasSelection();",
  "},true);",
  "var touchStart=null,ignoreClickUntil=0;",
  "document.addEventListener('touchstart',function(e){",
  "selectionAtTapStart=hasSelection();",
  "if(e.touches.length!==1){touchStart=null;return;}",
  "var touch=e.touches[0];",
  "touchStart={x:touch.clientX,y:touch.clientY,time:Date.now(),selected:selectionAtTapStart,dir:direction(touch.clientX,e.target)};",
  "},true);",
  "document.addEventListener('touchmove',function(e){",
  "if(!touchStart||e.touches.length!==1){touchStart=null;return;}",
  "var touch=e.touches[0];",
  "if(Math.abs(touch.clientX-touchStart.x)>15||Math.abs(touch.clientY-touchStart.y)>15)touchStart=null;",
  "},true);",
  "document.addEventListener('touchcancel',function(){touchStart=null;ignoreClickUntil=Date.now()+800;},true);",
  "document.addEventListener('touchend',function(e){",
  "ignoreClickUntil=Date.now()+800;",
  "var start=touchStart;touchStart=null;",
  "if(!start||!start.dir||e.touches.length||e.changedTouches.length!==1||Date.now()-start.time>700)return;",
  "var touch=e.changedTouches[0];",
  "if(Math.abs(touch.clientX-start.x)>15||Math.abs(touch.clientY-start.y)>15)return;",
  "if(e.defaultPrevented||start.selected||hasSelection()||direction(touch.clientX,e.target)!==start.dir)return;",
  "if(e.cancelable)e.preventDefault();",
  "go(start.dir);",
  "},true);",
  "document.addEventListener('click',function(e){",
  "var hadSelection=selectionAtTapStart;",
  "selectionAtTapStart=false;",
  "if(Date.now()<ignoreClickUntil||e.defaultPrevented||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey||(typeof e.button==='number'&&e.button!==0))return;",
  "if(e.pointerType==='mouse'||(window.matchMedia&&window.matchMedia('(hover: hover) and (pointer: fine)').matches))return;",
  "if(hadSelection||hasSelection())return;",
  "var dir=direction(e.clientX,e.target);",
  "if(dir)go(dir);",
  "},false);",
  "window.addEventListener('scroll',function(){progress();saveSoon();},false);",
  "window.addEventListener('pagehide',saveNow,false);",
  "window.addEventListener('load',function(){restore();progress();},false);",
  "restore();",
  "progress();",
  "})();",
  "</script>",
].join("\n");

const EINK_FAVORITE_CHROME = `<script>
(function(){
  var link=document.getElementById('favorite-link');
  var dialog=document.getElementById('favorite-dialog');
  var form=document.getElementById('favorite-form');
  var pin=document.getElementById('pin');
  var error=document.getElementById('favorite-error');
  var message=document.getElementById('favorite-message');
  var status=document.getElementById('favorite-status');
  if(!link||!dialog||typeof dialog.showModal!=='function'||typeof window.fetch!=='function'||typeof URLSearchParams==='undefined')return;
  var csrf='',busy=false,slots=pin.nextElementSibling.children,pinContinuation=null;
  function mark(){var active=Math.min(pin.selectionStart||0,5);for(var i=0;i<slots.length;i++){slots[i].classList.toggle('active',i===active);slots[i].classList.toggle('filled',i<pin.value.length)}}
  function showPin(message){error.textContent=message||'';pin.value='';mark();if(!dialog.open)dialog.showModal();pin.focus()}
  function label(){status.textContent=link.dataset.favorite==='true'?'取消收藏':'收藏'}
  function setBusy(value){busy=value;if(value)link.setAttribute('aria-disabled','true');else link.removeAttribute('aria-disabled')}
  function fail(text){if(dialog.open){error.textContent=text;pin.value='';mark();pin.focus()}else{label();message.textContent=text}}
  function post(value){
    var data=new URLSearchParams();data.set('csrf',csrf);data.set('favorite',link.dataset.favorite==='true'?'0':'1');if(value)data.set('pin',value);
    return fetch(link.href,{method:'POST',headers:{'Accept':'application/json','Content-Type':'application/x-www-form-urlencoded'},body:data.toString(),credentials:'same-origin'})
      .then(function(response){return response.json().then(function(result){return {status:response.status,data:result}})})
      .then(function(result){
        if(result.status===200&&result.data.ok){if(dialog.open)dialog.close();pin.value='';link.dataset.favorite=result.data.favorite?'true':'false';var next=new URL(link.href);next.searchParams.set('favorite',result.data.favorite?'0':'1');link.href=next.toString();form.action=link.href;label();return}
        if(result.data.requiresPin){if(value&&!dialog.open){label();return}showPin(result.data.error);return}
        fail(result.status===403&&dialog.open?'验证已过期，请关闭后重试。':result.data.error||'收藏失败，请重试。');
      });
  }
  function finish(){setBusy(false);pin.disabled=false;if(dialog.open)pin.focus()}
  link.addEventListener('click',function(event){
    if(busy){event.preventDefault();return}
    if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
    event.preventDefault();setBusy(true);message.textContent='';
    fetch(link.href,{headers:{'Accept':'application/json'},credentials:'same-origin',cache:'no-store'})
      .then(function(response){return response.json().then(function(result){if(!response.ok)throw new Error(result.error||'收藏失败，请重试。');return result})})
      .then(function(result){csrf=result.csrf;if(result.authenticated)return post();showPin();label()})
      .catch(function(err){fail(err.message||'收藏失败，请重试。')}).then(finish);
  });
  function submit(){if(busy||!dialog.open||!(/^[0-9]{6}$/).test(pin.value))return;setBusy(true);error.textContent='';var value=pin.value;pin.disabled=true;if(pinContinuation){var resume=pinContinuation;pinContinuation=null;Promise.resolve().then(function(){return resume(value)}).then(function(){if(dialog.open)dialog.close()}).catch(function(err){if(dialog.open)pinContinuation=resume;error.textContent=err.message||'保存失败，请重试。';pin.value='';mark()}).then(finish);return}post(value).catch(function(){fail('收藏失败，请重试。')}).then(finish)}
  window.promptForReadPin=function(resume){pinContinuation=resume;showPin('')};
  form.addEventListener('submit',function(event){event.preventDefault();submit()});
  pin.addEventListener('input',function(event){mark();if(!event.isComposing)submit()});
  pin.addEventListener('compositionend',function(){mark();submit()});pin.addEventListener('change',function(){mark();submit()});
  pin.addEventListener('focus',mark);pin.addEventListener('click',mark);pin.addEventListener('keyup',mark);pin.addEventListener('select',mark);
  dialog.addEventListener('close',function(){pin.value='';mark();error.textContent='';label()});
  mark();pin.parentElement.classList.add('pin-enhanced');
})();
</script>`;

export function renderEinkDetail(
  excerpt: Excerpt,
  listPath: string,
  imageBaseUrl: string,
  neighbors?: EinkNeighbors,
  category: ReadCategory = "all",
  page = 1,
  showNavigation = true,
  highlights: ResolvedHighlight[] = [],
  highlightsEnabled = false,
): string {
  const navNeighbors = neighbors ?? { prevCode: null, nextCode: null };
  const nav = einkNav(listPath, excerpt.code, navNeighbors, category, page, !showNavigation);
  return einkDocument(excerpt.title, [
    "<article>",
    `<h1 lang="${htmlText(excerpt.titleLang)}">${einkText(excerpt.title)}</h1>`,
    excerptDetailBody(excerpt, imageBaseUrl, showNavigation, category, page, highlightsEnabled && showNavigation),
    "</article>",
    nav,
  ].join("\n"), true, EINK_DETAIL_CHROME + (showNavigation ? EINK_FAVORITE_CHROME + (highlightsEnabled ? highlightChrome(excerpt.code, highlights) : "") : ""), "detail");
}

type HighlightRow = {
  id: string; excerpt_number: number; excerpt_page_id: string; field: "original" | "translation" | "terms";
  start: number; end: number; quote: string; prefix: string; suffix: string; body_hash: string; created_at: string;
};
type ResolvedHighlight = { id: string; field: string; start: number; end: number };

function bodyText(excerpt: Excerpt, field: string): string | null {
  const raw = field === "translation" ? (!excerpt.chinese ? excerpt.body : "") :
    field === "original" ? (excerpt.chinese ? excerpt.body : excerpt.originalBody || "") :
    field === "terms" ? excerpt.terms : "";
  if (!raw) return null;
  const parts: string[] = [];
  einkParagraphs(raw, excerpt.id, "", parts);
  return canonicalText(parts.join(""));
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

function highlightChrome(code: string, highlights: ResolvedHighlight[]): string {
  const json = JSON.stringify(highlights).replaceAll("<", "\\u003c");
  return `<dialog id="highlight-error" aria-label="划线失败" closedby="any" hidden><p id="highlight-error-message" role="alert"></p><div><button type="button" id="highlight-error-close">取消</button><button type="button" id="highlight-error-retry">划线</button></div></dialog>
<dialog id="explanation-dialog" aria-label="解释" closedby="any" hidden><div id="explanation-text" role="status"></div></dialog>
<dialog id="original-match-dialog" aria-label="原文匹配结果" closedby="any" hidden><div id="original-match-content"><section><h2>正文</h2><p id="original-match-current"></p></section><section><h2>原文</h2><p id="original-match-text" role="status"></p></section></div></dialog>
<script>(function(){
var rows=${json}, dialog=document.getElementById('favorite-dialog');
function canon(s){return s.replace(/\\s/g,'')}
function nodes(body){var a=[];function walk(n){for(var child=n.firstChild;child;child=child.nextSibling){if(child.nodeType===3)a.push(child);else walk(child)}}walk(body);return a}
function paint(row){if(document.getElementById('hl-'+row.id))return;var body=document.querySelector('.excerpt-body[data-field="'+row.field+'"]');if(!body)return;var list=nodes(body),pos=0,first=null;list.forEach(function(n){var value=n.nodeValue||'', begin=-1,end=-1;for(var i=0;i<value.length;i++){if(!/\\s/.test(value.charAt(i))){if(pos>=row.start&&pos<row.end){if(begin<0)begin=i;end=i+1}pos++}}if(begin>=0){var selected=n.splitText(begin);selected.splitText(end-begin);var mark=document.createElement('mark');mark.className='hl';mark.setAttribute('data-hl',row.id);selected.parentNode.insertBefore(mark,selected);mark.appendChild(selected);if(!first)first=mark}});if(first){var anchor=document.createElement('span');anchor.id='hl-'+row.id;first.parentNode.insertBefore(anchor,first)}}
rows.forEach(paint);
function jump(){var back=document.querySelector('.nav-row a[href^=\"/read?tab=highlights\"]');if(back&&location.hash.indexOf('#hl-')===0)back.hash=location.hash;if(!/^#hl-[0-9a-f-]+$/i.test(location.hash))return;var target=document.getElementById(location.hash.slice(1));if(!target)return;var body=target;while(body&&(' '+(body.className||'')+' ').indexOf(' excerpt-body ')<0)body=body.parentNode;if(body&&body.hidden){var other=document.querySelector('.excerpt-body:not([hidden])');if(other)other.hidden=true;body.hidden=false;if(window.syncBodyViewToggle)window.syncBodyViewToggle()}if(typeof target.scrollIntoView==='function'){try{target.scrollIntoView({block:'center'})}catch(e){target.scrollIntoView()}}}
window.addEventListener('load',jump);jump();
if(!window.fetch||!dialog||typeof URLSearchParams==='undefined')return;
var csrf='',busy=false,errorDialog=document.getElementById('highlight-error'),errorMessage=document.getElementById('highlight-error-message'),errorRetry=document.getElementById('highlight-error-retry'),errorClose=document.getElementById('highlight-error-close'),retryAction=null;
function closeError(){retryAction=null;if(!errorDialog)return;if(errorDialog.open&&errorDialog.close)errorDialog.close();else{if(errorDialog.removeAttribute)errorDialog.removeAttribute('open');errorDialog.open=false;}errorDialog.hidden=true;}
function showError(text,label,again){busy=false;if(!errorDialog||!errorMessage||!errorRetry)return;errorMessage.textContent=text;errorRetry.textContent=label;retryAction=again;errorDialog.hidden=false;if(typeof errorDialog.showModal==='function'&&!errorDialog.open)errorDialog.showModal();else if(errorDialog.setAttribute)errorDialog.setAttribute('open','');if(errorRetry.focus)errorRetry.focus();}
if(errorDialog&&errorRetry&&errorClose){errorRetry.addEventListener('click',function(){var again=retryAction;closeError();if(again)again();});errorClose.addEventListener('click',closeError);errorDialog.addEventListener('cancel',function(e){e.preventDefault();closeError();});errorDialog.addEventListener('close',function(){if(!errorDialog.hidden)closeError();});}
function send(fields,value,fallback){var data=new URLSearchParams();data.set('csrf',csrf);for(var key in fields)if(Object.prototype.hasOwnProperty.call(fields,key))data.set(key,fields[key]);if(value)data.set('pin',value);return fetch('/read/highlight/${code}',{method:'POST',credentials:'same-origin',headers:{'Accept':'application/json','Content-Type':'application/x-www-form-urlencoded'},body:data.toString(),cache:'no-store'}).then(function(r){return r.json().then(function(d){if(!r.ok){var e=new Error(d.error||fallback);e.status=r.status;throw e}return d})}).then(function(d){if(dialog.open||(dialog.hasAttribute&&dialog.hasAttribute('open'))){if(dialog.close)dialog.close();else dialog.removeAttribute('open')}return d})}
function authorized(run,fallback,failed,ready){return fetch('/read/highlight/${code}',{credentials:'same-origin',headers:{'Accept':'application/json'},cache:'no-store'}).then(function(r){return r.json().then(function(d){if(!r.ok)throw new Error(d.error||fallback);return d})}).then(function(d){csrf=d.csrf;if(ready)ready();if(d.authenticated)return run();if(window.promptForReadPin){busy=false;window.promptForReadPin(function(value){busy=true;return send({action:'verify'},value,'验证失败').then(function(){return run()}).catch(function(e){if(dialog.open){busy=false;throw e}if(failed){failed(e);return}throw e})});return}throw new Error('密码弹窗不可用')})}
function settle(){busy=false;}
function unpaint(id){if(!/^[0-9a-z-]+$/i.test(id))return;var nodes=document.querySelectorAll?document.querySelectorAll('mark.hl[data-hl="'+id+'"]'):[],marks=[],parents=[];for(var i=0;i<nodes.length;i++)marks.push(nodes[i]);for(var m=0;m<marks.length;m++){var mark=marks[m],parent=mark.parentNode;if(!parent)continue;while(mark.firstChild)parent.insertBefore(mark.firstChild,mark);parent.removeChild(mark);if(parents.indexOf(parent)<0)parents.push(parent)}var anchor=document.getElementById('hl-'+id);if(anchor&&anchor.parentNode){if(parents.indexOf(anchor.parentNode)<0)parents.push(anchor.parentNode);anchor.parentNode.removeChild(anchor)}for(var p=0;p<parents.length;p++)if(parents[p].normalize)parents[p].normalize();if(location.hash==='#hl-'+id&&window.history&&history.replaceState)history.replaceState(null,'',location.pathname+location.search)}
function save(fields){if(!fields||busy)return;busy=true;function failed(e){showError(e.message||'保存失败','划线',function(){save(fields)})}return authorized(function(){return send(fields,null,'保存失败').then(function(d){closeError();paint(d.highlight);settle()})},'保存失败',failed).catch(failed)}
function closeResult(panel){if(panel.open&&panel.close)panel.close();else if(panel.removeAttribute)panel.removeAttribute('open');panel.hidden=true}
function resultOpen(panel){return !panel.hidden&&(panel.open||(panel.hasAttribute&&panel.hasAttribute('open')))}
function bindResultDismiss(panel){
if(!panel)return;panel.addEventListener('close',function(){panel.hidden=true});
if(typeof HTMLDialogElement!=='undefined'&&'closedBy' in HTMLDialogElement.prototype&&typeof panel.showModal==='function')return;
var touch=null,touchActive=false,ignoreClickUntil=0,suppressClickUntil=0,mouseStart=null;
function selected(){var s=typeof window.getSelection==='function'&&window.getSelection();return !!(s&&s.rangeCount&&!s.isCollapsed)}
function outside(point,target){if(panel.hidden||!panel.getBoundingClientRect||!point)return false;if(target!==panel&&panel.contains&&panel.contains(target))return false;var r=panel.getBoundingClientRect();return point.clientX<r.left||point.clientX>r.right||point.clientY<r.top||point.clientY>r.bottom}
function stop(e){if(e.cancelable)e.preventDefault();if(e.stopImmediatePropagation)e.stopImmediatePropagation();else if(e.stopPropagation)e.stopPropagation()}
document.addEventListener('touchstart',function(e){touch=null;touchActive=false;if(panel.hidden||e.touches.length!==1)return;touchActive=true;var p=e.touches[0];if(outside(p,e.target))touch={x:p.clientX,y:p.clientY,time:Date.now(),selected:selected()}},true);
document.addEventListener('touchmove',function(e){if(!touch||e.touches.length!==1){touch=null;return}var p=e.touches[0];if(Math.abs(p.clientX-touch.x)>15||Math.abs(p.clientY-touch.y)>15)touch=null},true);
document.addEventListener('touchcancel',function(){touch=null;if(touchActive)ignoreClickUntil=Date.now()+800;touchActive=false},true);
document.addEventListener('touchend',function(e){var start=touch;touch=null;if(touchActive)ignoreClickUntil=Date.now()+800;touchActive=false;if(!start||e.touches.length||e.changedTouches.length!==1||Date.now()-start.time>700||start.selected||selected()||e.defaultPrevented)return;var p=e.changedTouches[0];if(Math.abs(p.clientX-start.x)>15||Math.abs(p.clientY-start.y)>15||!outside(p,e.target))return;suppressClickUntil=Date.now()+800;closeResult(panel);stop(e)},true);
function recordMouse(e){if(!panel.hidden)mouseStart={outside:outside(e,e.target),selected:selected(),x:e.clientX,y:e.clientY}}
document.addEventListener('pointerdown',function(e){if(e.pointerType!=='touch')recordMouse(e)},true);
document.addEventListener('mousedown',recordMouse,true);
document.addEventListener('click',function(e){if(Date.now()<suppressClickUntil){suppressClickUntil=0;stop(e);return}if(Date.now()<ignoreClickUntil||panel.hidden||e.defaultPrevented||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey||(typeof e.button==='number'&&e.button!==0))return;var start=mouseStart;mouseStart=null;if(!outside(e,e.target)||selected()||(start&&(!start.outside||start.selected||Math.abs(e.clientX-start.x)>15||Math.abs(e.clientY-start.y)>15)))return;closeResult(panel);stop(e)},true);
}
var explanationDialog=document.getElementById('explanation-dialog'),explanationText=document.getElementById('explanation-text');
bindResultDismiss(explanationDialog);
function showExplanation(text){explanationText.textContent=text;explanationDialog.hidden=false;if(typeof explanationDialog.showModal==='function'&&!explanationDialog.open)explanationDialog.showModal();else explanationDialog.setAttribute('open','')}
function renderExplanation(nodes){explanationText.textContent='';function append(parent,list){for(var i=0;i<list.length;i++){var n=list[i];if(n.type==='text'&&typeof n.text==='string'){parent.appendChild(document.createTextNode(n.text));continue}if(n.type!=='element'||! /^(p|h[1-6]|blockquote|ul|ol|li|em|strong|s|a|table|thead|tbody|tr|th|td|hr|br|pre|code)$/.test(n.tag)||!Array.isArray(n.children))continue;var el=document.createElement(n.tag);if(n.tag==='a'&&typeof n.href==='string'&&/^(https?:\\/\\/|mailto:|\\/(?!\\/)|#)/i.test(n.href))el.setAttribute('href',n.href);if(n.tag==='ol'&&Number.isSafeInteger(n.start)&&n.start>0)el.setAttribute('start',String(n.start));append(el,n.children);parent.appendChild(el)}}append(explanationText,nodes)}
function explain(fields,ready){if(!fields||busy||!explanationDialog||!explanationText){if(ready)ready();return}busy=true;var shown=false;function release(){if(ready){var fn=ready;ready=null;fn()}}function failed(e){release();settle();if(!shown||resultOpen(explanationDialog))showExplanation(e.message||'解释失败，请稍后再试。')}return authorized(function(){shown=true;showExplanation('正在解释…');var request={action:'explain',field:fields.field,ranges:JSON.stringify(fields.ranges)};return send(request,null,'解释失败').then(function(d){if(resultOpen(explanationDialog)){if(Array.isArray(d.markdown)){showExplanation('');renderExplanation(d.markdown)}else showExplanation(d.explanation)}settle()})},'解释失败',failed,release).catch(failed)}
var originalMatchDialog=document.getElementById('original-match-dialog'),originalMatchText=document.getElementById('original-match-text'),originalMatchCurrent=document.getElementById('original-match-current');
bindResultDismiss(originalMatchDialog);
function showOriginalMatch(original,current){originalMatchText.textContent=original;originalMatchCurrent.textContent=current||'';originalMatchDialog.hidden=false;if(typeof originalMatchDialog.showModal==='function'&&!originalMatchDialog.open)originalMatchDialog.showModal();else originalMatchDialog.setAttribute('open','')}
function matchOriginal(fields,ready){if(!fields||busy||!originalMatchDialog||!originalMatchText){if(ready)ready();return}busy=true;var shown=false,current=fields.ranges.map(function(range){return range.quote}).join('\\n');function release(){if(ready){var fn=ready;ready=null;fn()}}function failed(e){release();settle();if(!shown||resultOpen(originalMatchDialog))showOriginalMatch(e.message||'原文匹配失败，请稍后再试。',current)}return authorized(function(){shown=true;showOriginalMatch('正在匹配原文…',current);return send({action:'original',field:fields.field,ranges:JSON.stringify(fields.ranges)},null,'原文匹配失败').then(function(d){if(resultOpen(originalMatchDialog))showOriginalMatch(d.paragraph||'未找到匹配段落。',current);settle()})},'原文匹配失败',failed,release).catch(failed)}
function removeSaved(id){if(!id||busy)return;busy=true;return authorized(function(){return send({action:'delete',id:id},null,'取消划线失败').then(function(d){unpaint(id);settle()})},'取消划线失败',settle).catch(settle)}
window.removeHighlight=removeSaved;
window.performParagraphAction=function(p,body,mode,ready){
if(!p||!body||body.hidden){if(ready)ready();return}var all=nodes(body),text='',base=0,found=false;for(var i=0;i<all.length;i++){if(p.contains(all[i])){found=true;text+=all[i].nodeValue||''}else if(!found)base+=canon(all[i].nodeValue||'').length}var clean=canon(text);if(!clean){if(ready)ready();return}if(clean.length>1500){if(ready)ready();if(mode==='explain')showExplanation('解释最多 1500 字。');else if(mode==='original')showOriginalMatch('段落最多 1500 字。',text);else showError('划线最多 1500 字。','划线',null);return}var field=body.getAttribute('data-field')||'translation',range={start:base,end:base+clean.length,quote:text};if(mode==='explain')explain({field:field,ranges:[range]},ready);else if(mode==='original')matchOriginal({field:field,ranges:[range]},ready);else save({field:field,start:range.start,end:range.end,quote:text});
};
var action=document.getElementById('body-highlight'),explainAction=document.getElementById('body-explain');if(action)action.hidden=false;if(explainAction)explainAction.hidden=false;
})();</script>`;
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

async function renderHighlightList(db: D1Database | undefined, env: ConfiguredBindings, page: number): Promise<string> {
  if (!db) return renderEinkList([], READ_LIST_PATH, "highlights").replace("暂无条目", "划线数据库未配置");
  const limit = FEED_ITEM_LIMIT;
  const result = await db.prepare('SELECT * FROM highlights ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?').bind(limit + 1, (page - 1) * limit).all<HighlightRow>();
  const rows = result.results.slice(0, limit);
  const excerpts = await fetchHighlightExcerpts(env, [...new Set(rows.map(row => row.excerpt_number))]);
  const resolved = new Set<string>();
  for (const [id, excerpt] of excerpts) for (const row of await resolveHighlights(excerpt, rows.filter(row => row.excerpt_number === id))) resolved.add(row.id);
  const anchoredCodes = new Set<string>();
  const items = rows.map(row => {
    const excerpt = excerpts.get(row.excerpt_number);
    const id = htmlText(row.id);
    const quote = htmlText(row.quote);
    const link = excerpt && resolved.has(row.id) ? `<a class="item-link" href="${htmlText(`/r/${excerpt.code}${categorySearch("highlights", page)}#hl-${row.id}`)}">${quote}</a>` : quote;
    const meta = excerpt ? `${einkText(excerpt.title)}${excerpt.sourceTitle ? ` · ${einkText(excerpt.sourceTitle)}` : ""}${resolved.has(row.id) ? "" : " · 正文已变动，未能定位"}` : "文章不可用";
    const articleAnchor = excerpt && !anchoredCodes.has(excerpt.code) ? `<span id="${htmlText(excerpt.code)}"></span>` : "";
    if (excerpt) anchoredCodes.add(excerpt.code);
    return `<li id="hl-${id}">${articleAnchor}${link}<p class="meta">${meta}</p></li>`;
  }).join("\n");
  const pageHtml = renderEinkList([], READ_LIST_PATH, "highlights");
  const more = result.results.length > limit && page < 999 ? `<a class="btn" id="load-more" href="${htmlText(`${READ_LIST_PATH}${categorySearch("highlights", page + 1)}`)}">下一页</a>` : "";
  const previous = page > 1 ? `<a class="btn" href="${htmlText(`${READ_LIST_PATH}${categorySearch("highlights", page - 1)}`)}">上一页</a>` : "";
  return pageHtml.replace(`<p>${displayText("暂无条目")}</p>`, items ? `<ul>${items}</ul><div class="list-actions" id="list-actions"><a class="btn" id="back-to-top" href="#" hidden>返回顶部</a>${previous}${more}</div>` : `<p>${displayText("暂无条目")}</p>${previous}`);
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

function einkParagraphs(translation: string, pageId: string, imageBaseUrl: string, textParts?: string[]): string {
  // Use the same paragraph boundaries for display and Jev candidate selection.
  return einkParagraphTexts(translation, pageId)
    .map((paragraph) => {
      const replacements: Array<{ index: number; length: number; html: string }> = [];
      for (const match of paragraph.matchAll(IMAGE_TAG)) {
        const blockId = match[1];
        const fileId = match[2];
        if (!NOTION_PAGE_ID.test(pageId) || !NOTION_PAGE_ID.test(blockId) || !NOTION_PAGE_ID.test(fileId)) continue;
        // Caption text inside <image>...</image> is ignored; only the file reference is used.
        replacements.push({
          index: match.index ?? 0,
          length: match[0].length,
          html: `<img src="${htmlText(`${imageBaseUrl}/${pageId}/${blockId}`)}" alt="${einkText("正文图片")}" />`,
        });
      }
      for (const match of paragraph.matchAll(HTML_IMG)) {
        const href = externalUrl(match[1] || match[2]);
        if (!href) continue;
        replacements.push({
          index: match.index ?? 0,
          length: match[0].length,
          html: `<img src="${htmlText(href)}" alt="${einkText("正文图片")}" />`,
        });
      }
      replacements.sort((a, b) => a.index - b.index);

      let output = "";
      let offset = 0;
      for (const replacement of replacements) {
        if (replacement.index < offset) continue;
        textParts?.push(paragraph.slice(offset, replacement.index));
        output += htmlText(paragraph.slice(offset, replacement.index)).replaceAll("\n", "<br />\n");
        output += replacement.html;
        offset = replacement.index + replacement.length;
      }
      textParts?.push(paragraph.slice(offset));
      return `<p>${output}${htmlText(paragraph.slice(offset)).replaceAll("\n", "<br />\n")}</p>`;
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
        page_size: FEED_ITEM_LIMIT - pages.length,
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
  // The read-later category includes Instapaper entries outside the RSS view's filters.
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
    if (!response.ok) throw new Error(`Notion API returned ${response.status}`);
    const data = await response.json() as NotionQuery;
    if (data.request_status?.type === "incomplete") throw new Error("Notion query result is incomplete");
    pages.push(...data.results ?? []);
    cursor = data.has_more ? data.next_cursor : null;
    if (data.has_more && !cursor) throw new Error("Notion returned an incomplete page without a cursor");
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

function htmlResponse(body: string | null, method: string, vary?: string): Response {
  return new Response(method === "HEAD" ? null : body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300, must-revalidate",
      "X-Content-Type-Options": "nosniff",
      ...(vary ? { Vary: vary } : {}),
    },
  });
}

const worker = {
  async fetch(request: Request, env: WorkerBindings): Promise<Response> {
    const url = new URL(request.url);
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
        const startText = data.get("start") || "";
        const endText = data.get("end") || "";
        const quote = data.get("quote") || "";
        const explaining = data.get("action") === "explain";
        const matchingOriginal = data.get("action") === "original";
        if (!/^(original|translation|terms)$/.test(field)) throw highlightError("选区无效。", 400);
        let ranges: Array<{ start: number; end: number; quote: string }>;
        const rangesJson = explaining || matchingOriginal ? data.get("ranges") : null;
        if (rangesJson !== null) {
          try { ranges = JSON.parse(rangesJson); } catch { throw highlightError("选区无效。", 400); }
          if (!Array.isArray(ranges) || !ranges.length || ranges.length > 1500) throw highlightError("选区无效。", 400);
        } else {
          if (!/^(0|[1-9]\d{0,8})$/.test(startText) || !/^(0|[1-9]\d{0,8})$/.test(endText)) throw highlightError("选区无效。", 400);
          ranges = [{ start: Number(startText), end: Number(endText), quote }];
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
    const pageParam = url.searchParams.get("page");
    const page = pageParam && /^[1-9]\d{0,2}$/.test(pageParam) ? Number(pageParam) : 1;
    const coverId = coverIdFromPath(url.pathname);
    const isBookFeed = url.pathname === BOOK_FEED_PATH;
    const isExcerptFeed = url.pathname === READ_FEED_PATH;
    const isEinkList = url.pathname === READ_LIST_PATH;
    const detailShortId = pathCodeId(url.pathname, READ_DETAIL_PREFIX);
    const shortId = detailShortId ?? pathCodeId(url.pathname, SHORT_SHARE_PREFIX);
    const imageMatch = url.pathname.match(/^\/read\/p\/([^/]+)\/([^/]+)$/);
    const imageIds = imageMatch && NOTION_PAGE_ID.test(imageMatch[1] ?? "") && NOTION_PAGE_ID.test(imageMatch[2] ?? "") ? [imageMatch[1]!, imageMatch[2]!] : null;
    const usesExcerpts = isExcerptFeed || isEinkList || shortId !== null || Boolean(imageIds);
    if (!isBookFeed && !usesExcerpts && !coverId) {
      return new Response("Not found", { status: 404 });
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

      if (shortId !== null) {
        const showNavigation = detailShortId !== null;
        // Load the selected list in parallel so prev/next follow the same order as /read.
        const excerptPromise = fetchExcerptByShortId(configured, shortId);
        const highlightPromise = env.HIGHLIGHTS_DB && showNavigation ? Promise.resolve().then(() => env.HIGHLIGHTS_DB!.prepare('SELECT * FROM highlights WHERE excerpt_number=? ORDER BY created_at, id').bind(shortId).all<HighlightRow>()).then(r => r.results).catch(error => { console.error("Failed to load highlights", error); return [] as HighlightRow[]; }) : Promise.resolve([] as HighlightRow[]);
        const listPromise = env.HIGHLIGHTS_DB && showNavigation && category === "highlights"
          ? Promise.resolve().then(() => env.HIGHLIGHTS_DB!.prepare('SELECT excerpt_number FROM highlights ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?').bind(FEED_ITEM_LIMIT, (page - 1) * FEED_ITEM_LIMIT).all<{ excerpt_number: number }>()).then(async result => {
              const ids = [...new Set(result.results.map(row => row.excerpt_number))];
              const excerpts = await fetchHighlightExcerpts(configured, ids);
              return ids.flatMap(id => excerpts.has(id) ? [excerpts.get(id)!] : []);
            }).catch(error => { console.error("Failed to load highlight navigation", error); return [] as Excerpt[]; })
          : excerptsViewId && showNavigation && category !== "highlights"
          ? fetchExcerptPages(configured, excerptsViewId, category, page * FEED_ITEM_LIMIT).then((pages) =>
            pages.map(excerptFromPage).filter((item): item is Excerpt => item !== null)).catch((error) => {
              console.error("Failed to load article navigation", error);
              return [] as Excerpt[];
            })
          : Promise.resolve([] as Excerpt[]);
        const [excerpt, list, highlightRows] = await Promise.all([excerptPromise, listPromise, highlightPromise]);
        // Cache misses too, so probing unused codes does not reach Notion on every request.
        if (!excerpt) return new Response("Not found", { status: 404, headers: { "Cache-Control": "public, max-age=300" } });
        const neighbors = neighborsFor(list, excerpt.code) ?? { prevCode: null, nextCode: null };
        const detailResponse = htmlResponse(
          renderEinkDetail(
            excerpt,
            READ_LIST_PATH,
            `${url.origin}${READ_ASSET_PREFIX}`,
            neighbors,
            category,
            page,
            showNavigation,
            showNavigation ? await resolveHighlights(excerpt, highlightRows) : [],
            Boolean(env.HIGHLIGHTS_DB),
          ),
          request.method,
        );
        if (showNavigation) detailResponse.headers.set("Cache-Control", "no-store");
        return detailResponse;
      }

      if (isEinkList && category === "highlights") {
        const listResponse = htmlResponse(await renderHighlightList(env.HIGHLIGHTS_DB, configured, page), request.method);
        listResponse.headers.set("Cache-Control", "no-store");
        return listResponse;
      }
      if (isEinkList) {
        const limit = page * FEED_ITEM_LIMIT;
        const pages = await fetchExcerptPages(configured, excerptsViewId!, category, limit + 1);
        const excerpts = pages.slice(0, limit)
          .map(excerptFromPage)
          .filter((item): item is Excerpt => item !== null);
        const listResponse = htmlResponse(renderEinkList(excerpts, READ_LIST_PATH, category, page, pages.length > limit && page < 999), request.method);
        if (category === "favorites") listResponse.headers.set("Cache-Control", "no-store");
        return listResponse;
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
      console.error(coverId || imageIds ? "Failed to load image" : isEinkList || shortId !== null ? "Failed to build e-ink page" : "Failed to build book RSS", error);
      return new Response(
        coverId || imageIds ? "Image temporarily unavailable" : isEinkList || shortId !== null ? "Page temporarily unavailable" : "Feed temporarily unavailable",
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }
  },
};

export default worker;
