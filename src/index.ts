import { generateRssFeed, type RssFeed } from "feedsmith";
import { formatText } from "./format-text.ts";

const NOTION_VERSION = "2026-03-11";
const FEED_TITLE = "书籍推荐";
const FEED_DESCRIPTION = "来自 Notion「书籍推荐」的书目 RSS";
const NOTION_PAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BOOK_FEED_PATH = "/book/rss";
const BOOK_ASSET_PREFIX = "/book/p";
const READ_LIST_PATH = "/read";
const READ_DETAIL_PREFIX = "/read/d";
const READ_FEED_PATH = "/read/rss";
const READ_ASSET_PREFIX = "/read/p";
const SHORT_SHARE_PREFIX = "/s";
// Notion ID property whose auto-increment number becomes the detail and share code.
const SHORT_ID_PROPERTY = "ID";
// Codes are a keyed 32-bit Feistel permutation of the ID, written as 6 base62 characters.
// IDs stay below 2^20, so a random code decodes to a valid ID only about 1 time in 4096.
// Changing the keys or alphabet breaks every detail and share link already sent out.
const SHORT_ID_LIMIT = 2 ** 20;
const SHARE_CODE_KEYS = [0x3c6e, 0xa54f, 0x510e, 0x9b05];
const SHARE_CODE_ALPHABET = "hqAiRYEFKT2xePmzuOfgrw4dBbNscH78S9kI30LQjpaGUJXonCMZ6ly15DtWvV";
const SHARE_CODE = /^[0-9A-Za-z]{6}$/;
const FEED_ITEM_LIMIT = 30;

const READ_CATEGORIES = [
  { id: "all", label: "全部" },
  { id: "favorites", label: "收藏" },
  { id: "news", label: "新闻" },
  { id: "weekly", label: "周刊" },
  { id: "bunshun", label: "文春" },
  { id: "novel", label: "小说" },
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
  title?: RichText[];
  rich_text?: RichText[];
  url?: string | null;
  files?: NotionFile[];
  select?: { name?: string } | null;
  date?: { start?: string } | null;
  unique_id?: { number?: number | null } | null;
};

type WorkerBindings = {
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

/** Chinese posts and comics use the original title/body; other entries use translations. */
function usesOriginalContent(properties: NotionPage["properties"]): boolean {
  return selectProperty(properties, "原文语言") === "中文"
    || selectProperty(properties, "内容形态") === "漫画";
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
  };
}

function excerptDetailUrl(feedUrl: string, code: string): string {
  return `${new URL(feedUrl).origin}${READ_DETAIL_PREFIX}/${code}`;
}

// Self-closing tags and captioned <image>...</image> wrappers both count.
const IMAGE_TAG = /<image\s+source="notion-file-block:\/\/([0-9a-f-]{36})\/([0-9a-f-]{36})(?:\?[^"<>]*)?"\s*(?:\/>|>([\s\S]*?)<\/image>)/gi;
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

  const label = einkText("阅读原文：");
  const lang = htmlText(excerpt.originalTitle ? excerpt.originalLang : excerpt.titleLang);
  const title = einkText(excerpt.originalTitle || excerpt.title);
  return excerpt.originalUrl
    ? `${label}<a class="metadata-link" lang="${lang}" href="${htmlText(excerpt.originalUrl)}">${title}</a>`
    : `${label}<span lang="${lang}">${title}</span>`;
}

function einkPublication(excerpt: Excerpt, showActions: boolean): string {
  const date = einkText(`发布日期：${excerpt.publishedDate || "—"}`);
  return [
    `<span>${date}</span>`,
    ...(showActions ? [`<span id="data-source"><br />${einkText("数据来源：")}<a class="metadata-link" lang="en" href="${htmlText(excerpt.link)}">Notion</a><br />分享链接：<button type="button" class="share-copy" id="share-copy" data-path="${htmlText(`${SHORT_SHARE_PREFIX}/${excerpt.code}`)}">点击复制</button><span id="share-status" role="status"></span></span>`] : []),
  ].join("");
}

function excerptDetailBody(excerpt: Excerpt, imageBaseUrl: string, showActions: boolean): string {
  const source = [
    excerpt.sourceTitle ? `<cite>${einkText(excerpt.sourceTitle)}</cite>` : "",
    excerpt.author ? einkText(`作者：${excerpt.author}`) : "",
  ].filter(Boolean).join(" · ");
  const details = [
    einkOriginalTitle(excerpt),
    excerpt.publisher ? einkText(`出版方：${excerpt.publisher}`) : "",
    excerpt.chapter ? einkText(`章节：${excerpt.chapter}`) : "",
    einkPublication(excerpt, showActions),
  ].filter(Boolean);
  const body = excerpt.body ? einkParagraphs(excerpt.body, excerpt.id, imageBaseUrl) : "";
  const terms = showActions && excerpt.terms ? einkParagraphs(excerpt.terms, excerpt.id, imageBaseUrl) : "";
  return [
    ...(source ? [`<p>${source}</p>`] : []),
    ...(body ? [`<div class="excerpt-body" lang="${htmlText(excerpt.lang)}">\n${body}\n</div>`] : []),
    "<hr />",
    `<p>${details.join("<br />\n")}</p>`,
    ...(terms ? ["<hr />", `<p>${einkText("名词解释")}</p>`, terms] : []),
  ].join("\n");
}

// E-ink: pure black/white, serif, wide leading, capped line length, no motion/hover-only UI.
const EINK_STYLE = [
  "*,*::before,*::after{box-sizing:border-box;animation:none!important;transition:none!important;}",
  "html{-webkit-text-size-adjust:100%;}",
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
  "li{border-top:2px solid #000;padding:1.5rem 0;}",
  "li:last-child{border-bottom:2px solid #000;}",
  // Fragment return from detail: no UA focus ring (scroll centering is JS).
  "li:focus{outline:none;}",
  "li:target{position:relative;padding-left:0.9rem;}",
  // Center the marker on the title's first line; retain the old offset for older readers.
  "li:target::before{content:\"\";position:absolute;left:0;top:1.85rem;top:calc(1.5rem + 0.525em);width:0;height:0;border-top:0.35em solid transparent;border-bottom:0.35em solid transparent;border-left:0.55em solid #000;}",
  "a{color:#000;text-decoration:none;}",
  "a:hover{text-decoration:underline;text-underline-offset:0.35em;}",
  "a:focus-visible{outline:3px solid #000;outline-offset:3px;}",
  ".item-link{display:block;min-height:3rem;font-weight:700;}",
  ".categories{display:flex;flex-wrap:wrap;gap:0.25rem;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin:0 0 1rem;}",
  ".categories h1,.categories a{min-width:0;display:flex;align-items:center;justify-content:center;min-height:3rem;padding:0.5rem 0.15rem;border:2px solid #000;font-weight:700;text-align:center;}",
  ".categories h1{flex:0 0 calc(50% - 0.125rem);grid-column:span 2;margin:0;font-size:inherit;line-height:inherit;}",
  ".categories a{flex:0 0 calc(25% - 0.1875rem);}",
  ".categories a:nth-of-type(-n+2){order:-1;}",
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
  "a.metadata-link,.share-copy{text-decoration:underline;text-decoration-thickness:1px;text-decoration-skip-ink:none;text-underline-offset:0.28em;}",
  ".share-copy{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer;}",
  ".share-copy:focus-visible{outline:3px solid #000;outline-offset:3px;}",
  ".btn{display:block;border:2px solid #000;padding:0.85rem 1rem;margin:0.75rem 0;text-align:center;text-decoration:none;font-weight:700;min-height:3rem;}",
  ".btn:focus-visible{outline:3px solid #000;outline-offset:3px;}",
  ".list-actions{display:flex;gap:0.5rem;}",
  ".list-actions .btn{flex:1;min-width:0;}",
  "img{max-width:100%;height:auto;display:block;margin:1rem 0;}",
  // Mobile article images may extend beyond the reading column to the screen edges.
  "@media (max-width:440px){@supports (container-type:inline-size) and (width:100cqw){html{container-type:inline-size;}.excerpt-body img{width:100cqw;max-width:none;margin-left:calc(50% - 50cqw);}}}",
  "hr{border:0;border-top:2px solid #000;margin:1.5rem 0;}",
  "cite{font-style:normal;font-weight:700;}",
  // Thin bottom progress track; width updates from scroll position (no animation).
  ".progress{position:fixed;left:0;right:0;bottom:0;height:4px;background:#fff;border-top:1px solid #000;z-index:1;}",
  ".progress-bar{display:block;height:100%;width:0;background:#000;}",
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
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
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
  "})();",
  "</script>",
].join("\n");

export function renderEinkList(excerpts: Excerpt[], listPath: string, category: ReadCategory = "all", page = 1, hasMore = false): string {
  const items = excerpts.map((excerpt) => {
    const href = htmlText(`${listPath}/d/${excerpt.code}${categorySearch(category, page)}`);
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
    `<nav class="categories" aria-label="阅读分类"><h1>${displayText("阅读节选")}</h1>${READ_CATEGORIES.map((item) =>
      `<a href="${htmlText(`${listPath}${categorySearch(item.id)}`)}"${item.id === category ? ' aria-current="page"' : ""}>${item.label}</a>`
    ).join("")}</nav>`,
    items ? `<ul>\n${items}\n</ul>` : `<p>${displayText("暂无条目")}</p>`,
    ...((items || hasMore) ? [
      `<div class="list-actions"><a class="btn" href="#">返回顶部</a>${hasMore ? `<a class="btn" href="${htmlText(`${listPath}${categorySearch(category, page + 1)}${excerpts.length ? `#${excerpts[excerpts.length - 1]!.code}` : ""}`)}">加载更多</a>` : ""}</div>`,
    ] : []),
  ].join("\n"), false, EINK_LIST_NAV + "\n" + EINK_LIST_PAGING);
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
    ? `<a href="${htmlText(`${listPath}/d/${neighbors.prevCode}${categorySearch(category, page)}`)}">${einkText("上一篇")}</a>`
    : `<span class="is-disabled">${einkText("上一篇")}</span>`;
  const next = neighbors.nextCode
    ? `<a href="${htmlText(`${listPath}/d/${neighbors.nextCode}${categorySearch(category, page)}`)}">${einkText("下一篇")}</a>`
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
  "function direction(x,target){",
  "if(!main||(target!==document.body&&target!==document.documentElement))return 0;",
  "var bounds=main.getBoundingClientRect();",
  "return x<bounds.left?-1:x>bounds.right?1:0;",
  "}",
  "function pageKey(){var m=location.pathname.match(/^\\/read\\/d\\/([0-9A-Za-z]{6})$/);return m?'eink-progress:'+m[1]:null;}",
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
  "var shareStatus=document.getElementById('share-status');",
  "if(shareCopy)shareCopy.addEventListener('click',function(){",
  "var link=location.origin+shareCopy.getAttribute('data-path');",
  "function fallback(){",
  "var input=document.createElement('textarea');input.value=link;input.style.position='fixed';input.style.left='-9999px';document.body.appendChild(input);input.select();",
  "var copied=false;try{copied=document.execCommand('copy');}catch(err){}document.body.removeChild(input);",
  "if(shareStatus)shareStatus.textContent=copied?' 已复制':' 复制失败';",
  "}",
  "if(window.navigator&&window.navigator.clipboard&&window.navigator.clipboard.writeText){",
  "window.navigator.clipboard.writeText(link).then(function(){if(shareStatus)shareStatus.textContent=' 已复制';},fallback);",
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

export function renderEinkDetail(
  excerpt: Excerpt,
  listPath: string,
  imageBaseUrl: string,
  neighbors?: EinkNeighbors,
  category: ReadCategory = "all",
  page = 1,
  showNavigation = true,
): string {
  const navNeighbors = neighbors ?? { prevCode: null, nextCode: null };
  const nav = einkNav(listPath, excerpt.code, navNeighbors, category, page, !showNavigation);
  return einkDocument(excerpt.title, [
    "<article>",
    `<h1 lang="${htmlText(excerpt.titleLang)}">${einkText(excerpt.title)}</h1>`,
    excerptDetailBody(excerpt, imageBaseUrl, showNavigation),
    "</article>",
    nav,
  ].join("\n"), true, EINK_DETAIL_CHROME, "detail");
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

function einkParagraphs(translation: string, pageId: string, imageBaseUrl: string): string {
  // Existing translations contain literal <br /> separators. Interpret only
  // attribute-free line breaks, Notion file images, and http(s) <img> tags;
  // all other markup remains escaped text.
  // Captions are not displayed, so exclude them before processing quotes and paragraphs.
  const withoutCaptions = translation.replace(IMAGE_TAG, (match, blockId: string, fileId: string) => {
    if (!NOTION_PAGE_ID.test(pageId) || !NOTION_PAGE_ID.test(blockId) || !NOTION_PAGE_ID.test(fileId)) return match;
    return match.replace(/>[\s\S]*<\/image>$/i, "></image>");
  });
  // Format the whole passage so quotations can span paragraphs and images.
  return formatText(withoutCaptions.replace(/\r\n?/g, "\n").replace(/<br\s*\/?\s*>/gi, "\n").trim())
    .split(/\n(?:[^\S\n]*\n)+/)
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
        output += htmlText(paragraph.slice(offset, replacement.index)).replaceAll("\n", "<br />\n");
        output += replacement.html;
        offset = replacement.index + replacement.length;
      }
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
  const viewFilter = viewQueryFilter(view);
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
        // No saved sort means the table's own order. Don't replace it with last_edited_time.
        ...(view.sorts?.length ? { sorts: view.sorts } : {}),
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
  const body = usesOriginalContent(page.properties)
    ? textProperty(page.properties, "正文")
    : textProperty(page.properties, "正文翻译");
  const referenced = Array.from(body.matchAll(IMAGE_TAG)).some((match) =>
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
    const needsView = isExcerptFeed || isEinkList;
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
        const listPromise = excerptsViewId && showNavigation
          ? fetchExcerptPages(configured, excerptsViewId, category, page * FEED_ITEM_LIMIT).then((pages) =>
            pages.map(excerptFromPage).filter((item): item is Excerpt => item !== null)).catch((error) => {
              console.error("Failed to load article navigation", error);
              return [] as Excerpt[];
            })
          : Promise.resolve([] as Excerpt[]);
        const [excerpt, list] = await Promise.all([excerptPromise, listPromise]);
        // Cache misses too, so probing unused codes does not reach Notion on every request.
        if (!excerpt) return new Response("Not found", { status: 404, headers: { "Cache-Control": "public, max-age=300" } });
        const neighbors = neighborsFor(list, excerpt.code) ?? { prevCode: null, nextCode: null };
        return htmlResponse(
          renderEinkDetail(
            excerpt,
            READ_LIST_PATH,
            `${url.origin}${READ_ASSET_PREFIX}`,
            neighbors,
            category,
            page,
            showNavigation,
          ),
          request.method,
        );
      }

      if (isEinkList) {
        const limit = page * FEED_ITEM_LIMIT;
        const pages = await fetchExcerptPages(configured, excerptsViewId!, category, limit + 1);
        const excerpts = pages.slice(0, limit)
          .map(excerptFromPage)
          .filter((item): item is Excerpt => item !== null);
        return htmlResponse(renderEinkList(excerpts, READ_LIST_PATH, category, page, pages.length > limit && page < 999), request.method);
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
