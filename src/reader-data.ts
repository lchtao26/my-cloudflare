export const READ_CATEGORIES = [
  { id: "all", label: "全部" },
  { id: "weekly", label: "周刊" },
  { id: "bunshun", label: "文春" },
  { id: "novel", label: "小说" },
  { id: "news", label: "IT" },
  { id: "favorites", label: "收藏" },
  { id: "highlights", label: "划线" },
  { id: "later", label: "稍后阅读" },
] as const;
export type ReadCategory = typeof READ_CATEGORIES[number]["id"];

export function readCategory(value: unknown): ReadCategory {
  return READ_CATEGORIES.find((category) => category.id === (value === "likes" ? "favorites" : value))?.id ?? "all";
}

export type ReaderItem = {
  code: string;
  title: string;
  titleLang: string;
  source: string;
  author: string;
};

export type ReaderHighlight = {
  id: string;
  quote: string;
  article: ReaderItem | null;
  located: boolean;
};

export type ReaderList =
  | { kind: "articles"; items: ReaderItem[]; hasMore: boolean }
  | { kind: "highlights"; items: ReaderHighlight[]; hasMore: boolean; available: boolean };

export type ReaderField = "original" | "translation" | "terms";
export type ReaderPart = { text: string } | { image: string };
export type ReaderParagraph = { parts: ReaderPart[]; quote: string; start: number; end: number };
export type ResolvedHighlight = { id: string; field: string; start: number; end: number };

export type ReaderArticle = {
  item: ReaderItem;
  lang: string;
  originalLang: string;
  originalTitle: string;
  originalUrl: string | null;
  publisher: string;
  chapter: string;
  date: string;
  body: ReaderParagraph[];
  field: ReaderField;
  original: ReaderParagraph[];
  terms: ReaderParagraph[];
  actions: null | {
    favorite: boolean;
    notionUrl: string;
    highlightsEnabled: boolean;
    highlights: ResolvedHighlight[];
    prevCode: string | null;
    nextCode: string | null;
  };
};

export function readPage(value: unknown): number {
  const page = typeof value === "number" || typeof value === "string" ? String(value) : "";
  return /^[1-9]\d{0,2}$/.test(page) ? Number(page) : 1;
}
