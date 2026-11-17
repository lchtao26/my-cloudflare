import { queryOptions } from "@tanstack/react-query";
import { readCategory, readPage, type ReadCategory, type ReaderArticle, type ReaderList, type ResolvedHighlight } from "../reader-data.ts";
import type { MarkdownNode } from "../explanation-markdown.ts";

export function readerSearch(category: ReadCategory = "all", page = 1) {
  return {
    tab: category === "all" ? undefined : category === "favorites" ? "likes" : category,
    page: page === 1 ? undefined : page,
  };
}

export function validateReaderSearch(search: Record<string, unknown>) {
  return readerSearch(readCategory(search.tab ?? search.category), readPage(search.page));
}

function searchParams(category: ReadCategory, page: number) {
  const search = readerSearch(category, page);
  const params = new URLSearchParams();
  if (search.tab) params.set("tab", search.tab);
  if (search.page) params.set("page", String(search.page));
  return params.size ? `?${params}` : "";
}

export class ReaderError extends Error {
  constructor(message: string, readonly status: number, readonly requiresPin = false) {
    super(message);
  }
}

async function requestJson<T>(path: string, init?: RequestInit, fallback = "暂时无法读取，请稍后重试。"): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    const data = await response.json<{ error?: string; requiresPin?: boolean }>().catch(() => null);
    throw new ReaderError(data?.error || fallback, response.status, data?.requiresPin);
  }
  return response.json();
}

export const listKey = (category: ReadCategory) => ["reader", "list", category] as const;
export const articleKey = (code: string) => ["reader", "article", code] as const;

export function articlePath(code: string, shared: boolean, category: ReadCategory, page: number) {
  return `/api/${shared ? "s" : "r"}/${encodeURIComponent(code)}${shared ? "" : searchParams(category, page)}`;
}

export function listQuery(category: ReadCategory, page: number, cache?: RequestCache) {
  return queryOptions({
    queryKey: [...listKey(category), page],
    queryFn: ({ signal }) => requestJson<ReaderList>(`/api/read${searchParams(category, page)}`, { signal, cache }),
    staleTime: category === "highlights" || category === "favorites" ? 0 : 60_000,
  });
}

export function articleQuery(code: string, shared: boolean, category: ReadCategory, page: number) {
  return queryOptions({
    queryKey: [...articleKey(code), shared, category, page],
    queryFn: ({ signal }) => requestJson<ReaderArticle>(articlePath(code, shared, category, page), { signal }),
    staleTime: shared ? 60_000 : 0,
  });
}

type ReaderActionResult = {
  favorite?: boolean;
  paragraph?: string;
  explanation?: string;
  markdown?: MarkdownNode[];
  highlight?: ResolvedHighlight;
  id?: string;
};

export type ReaderAction = {
  type: "favorite" | "add-later" | "highlight" | "delete" | "explain" | "original";
  data: Record<string, string>;
  quote?: string;
};

export async function performAction(code: string, action: ReaderAction, pin?: string) {
  const endpoint = action.type === "favorite" || action.type === "add-later" ? action.type : "highlight";
  const path = `/read/${endpoint}/${encodeURIComponent(code)}`;
  const options = { cache: "no-store" } as const;
  const { csrf, authenticated } = await requestJson<{ csrf: string; authenticated: boolean }>(path, options, "无法验证身份。");
  if (!authenticated && !pin) throw new ReaderError("请输入 6 位密码。", 401, true);
  if (!authenticated && endpoint === "highlight") {
    // Establish the session before an AI or D1 action so service errors
    // leave the user authenticated for the next attempt.
    await requestJson(path, { ...options, method: "POST", body: new URLSearchParams({ csrf, action: "verify", pin: pin! }) }, "验证失败，请重试。");
  }
  return requestJson<ReaderActionResult>(path, {
    ...options,
    method: "POST",
    body: new URLSearchParams({ ...action.data, csrf, ...(pin && endpoint !== "highlight" ? { pin } : {}) }),
  }, "操作失败，请稍后重试。");
}
