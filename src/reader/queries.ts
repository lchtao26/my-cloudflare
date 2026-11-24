import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { readCategory, readPage, type ReadCategory, type ReaderArticle, type ReaderList, type ResolvedHighlight } from "./data.ts";
import type { MarkdownNode } from "./explanation-markdown.ts";

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
  readonly status: number;
  readonly requiresPin: boolean;

  constructor(message: string, status: number, requiresPin = false) {
    super(message);
    this.status = status;
    this.requiresPin = requiresPin;
  }
}

const REVALIDATE_MS = 300_000;
const REVALIDATE_STORAGE_PREFIX = "reader-revalidate:";
type RevalidateEntry = { until: number; version: number };
const revalidateEntries = new Map<string, RevalidateEntry>();
let revalidateCounter = 0;

function nextVersion(): number {
  const now = Date.now();
  revalidateCounter = now > revalidateCounter ? now : revalidateCounter + 1;
  return revalidateCounter;
}

function getSessionStorage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function readRevalidateEntry(key: string): RevalidateEntry | undefined {
  const now = Date.now();
  const inMemory = revalidateEntries.get(key);
  if (inMemory) {
    if (inMemory.until > now) return inMemory;
    revalidateEntries.delete(key);
  }
  const storage = getSessionStorage();
  if (!storage) return undefined;
  try {
    const raw = storage.getItem(REVALIDATE_STORAGE_PREFIX + key);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<RevalidateEntry>;
    if (typeof parsed.until === "number" && typeof parsed.version === "number" && parsed.until > now) {
      const entry = { until: parsed.until, version: parsed.version };
      revalidateEntries.set(key, entry);
      return entry;
    }
    storage.removeItem(REVALIDATE_STORAGE_PREFIX + key);
  } catch {
    /* Storage can be disabled. */
  }
  return undefined;
}

export function revalidateReader(key: string) {
  const entry = { until: Date.now() + REVALIDATE_MS, version: nextVersion() };
  revalidateEntries.set(key, entry);
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    storage.setItem(REVALIDATE_STORAGE_PREFIX + key, JSON.stringify(entry));
  } catch {
    /* Storage can be disabled. */
  }
}

export async function updateArticleCache(queryClient: QueryClient, code: string, listCategory: ReadCategory, updater: (current: ReaderArticle) => ReaderArticle) {
  revalidateReader(code);
  revalidateReader(listCategory);
  await queryClient.cancelQueries({ queryKey: articleKey(code) });
  queryClient.setQueriesData<ReaderArticle>({ queryKey: articleKey(code) }, current => (current ? updater(current) : current));
  void queryClient.invalidateQueries({ queryKey: articleKey(code) });
  void queryClient.invalidateQueries({ queryKey: listKey(listCategory), refetchType: "none" }).then(() => queryClient.invalidateQueries({ queryKey: ["reader", "infinite", listCategory] }));
}

export function reconcileArticleOnError(queryClient: QueryClient, code: string, action: ReaderAction, error: unknown) {
  const clientRejected = error instanceof ReaderError && (error.requiresPin || (error.status >= 400 && error.status < 500));
  if (clientRejected || !(action.data.save === "1" || action.type === "highlight" || action.type === "delete")) return;
  revalidateReader(code);
  revalidateReader("highlights");
  void queryClient
    .cancelQueries({ queryKey: articleKey(code) })
    .then(() => Promise.all([queryClient.invalidateQueries({ queryKey: articleKey(code) }), queryClient.invalidateQueries({ queryKey: listKey("highlights"), refetchType: "none" }).then(() => queryClient.invalidateQueries({ queryKey: ["reader", "infinite", "highlights"] }))]));
}

function withCacheBust(path: string, version: number | undefined): string {
  if (version === undefined) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}_=${version}`;
}

function cacheRequest(path: string, key: string, force = false): { path: string; cache?: RequestCache } {
  const entry = readRevalidateEntry(key);
  if (!force && !entry) return { path };
  const version = entry?.version ?? nextVersion();
  return {
    path: withCacheBust(path, version),
    cache: "no-store",
  };
}

function isAbort(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

async function requestJson<T>(path: string, init?: RequestInit, fallback = "暂时无法读取，请稍后重试。"): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers,
    });
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new ReaderError(fallback, 0);
  }
  if (!response.ok) {
    const data = await response.json<{ error?: string; requiresPin?: boolean }>().catch(() => null);
    throw new ReaderError(data?.error || fallback, response.status, data?.requiresPin);
  }
  try {
    return await response.json();
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new ReaderError(fallback, response.status);
  }
}

export const listKey = (category: ReadCategory) => ["reader", "list", category] as const;
const articleKey = (code: string) => ["reader", "article", code] as const;

function articlePath(code: string, shared: boolean, category: ReadCategory, page: number) {
  return `/api/${shared ? "s" : "r"}/${encodeURIComponent(code)}${shared ? "" : searchParams(category, page)}`;
}

export function listQuery(category: ReadCategory, page: number, cache?: RequestCache) {
  return queryOptions({
    queryKey: [...listKey(category), page],
    queryFn: ({ signal }) => {
      const request = cacheRequest(`/api/read${searchParams(category, page)}`, category, cache === "reload");
      return requestJson<ReaderList>(request.path, { signal, cache: request.cache ?? cache });
    },
    staleTime: category === "highlights" || category === "favorites" ? 0 : 60_000,
  });
}

export function readSessionQuery() {
  return queryOptions({
    queryKey: ["reader", "session"] as const,
    queryFn: async ({ signal }) => {
      const response = await fetch("/api/session", { credentials: "same-origin", cache: "no-store", signal });
      if (!response.ok) throw new Error("无法确认登录状态");
      const data = (await response.json()) as { authenticated?: boolean };
      return data.authenticated === true;
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function articleQuery(code: string, shared: boolean, category: ReadCategory, page: number, priority?: "low" | "high" | "auto") {
  return queryOptions({
    queryKey: [...articleKey(code), shared, category, page],
    queryFn: ({ signal }) => {
      const base = articlePath(code, shared, category, page);
      const request = shared ? { path: base } : cacheRequest(base, code);
      return requestJson<ReaderArticle>(request.path, { signal, cache: request.cache, priority });
    },
    staleTime: shared ? 60_000 : 0,
  });
}

type ReaderActionResult = {
  favorite?: boolean;
  paragraph?: string;
  explanation?: string;
  markdown?: MarkdownNode[];
  highlight?: ResolvedHighlight;
  highlights?: ResolvedHighlight[];
  id?: string;
};

export type ReaderAction = {
  type: "favorite" | "add-later" | "highlight" | "delete" | "explain" | "original";
  data: Record<string, string>;
  quote?: string;
};

export async function performAction(code: string, action: ReaderAction, pin?: string, signal?: AbortSignal) {
  const endpoint = action.type === "favorite" || action.type === "add-later" ? action.type : "highlight";
  const path = `/read/${endpoint}/${encodeURIComponent(code)}`;
  const options = { cache: "no-store" as const, signal };
  const { csrf, authenticated } = await requestJson<{ csrf: string; authenticated: boolean }>(path, options, "无法验证身份。");
  if (!authenticated && !pin) throw new ReaderError("请输入 6 位密码。", 401, true);
  if (!authenticated && endpoint === "highlight") {
    // Establish the session before an AI or D1 action so service errors
    // leave the user authenticated for the next attempt.
    await requestJson(path, { ...options, method: "POST", body: new URLSearchParams({ csrf, action: "verify", pin: pin! }) }, "验证失败，请重试。");
  }
  return requestJson<ReaderActionResult>(
    path,
    {
      ...options,
      method: "POST",
      body: new URLSearchParams({ ...action.data, csrf, ...(pin && endpoint !== "highlight" ? { pin } : {}) }),
    },
    "操作失败，请稍后重试。",
  );
}
