import { useInfiniteQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";
import { READ_CATEGORIES, readCategory } from "../reader/data.ts";
import type { ReaderList } from "../reader/data.ts";
import { articleQuery, listKey, listQuery, readerSearch, revalidateReader, validateReaderSearch } from "../reader/queries.ts";
import { LoadingStatus } from "../reader/loading.tsx";
import { usePullToRefresh } from "../reader/pull-to-refresh.ts";
import { useReaderScroll } from "../reader/reading.ts";

export const Route = createFileRoute("/read")({
  ssr: false,
  validateSearch: validateReaderSearch,
  component: ReadingList,
});

function ReadingList() {
  const { tab, page = 1 } = Route.useSearch();
  const category = readCategory(tab);
  return <CategoryList key={category} category={category} page={page} />;
}

function CategoryList({ category, page }: { category: ReturnType<typeof readCategory>; page: number }) {
  const queryClient = useQueryClient();
  const query = useInfiniteQuery<ReaderList, Error, InfiniteData<ReaderList, number>, readonly unknown[], number>({
    queryKey: ["reader", "infinite", category, page],
    initialPageParam: page,
    queryFn: ({ pageParam }) => queryClient.fetchQuery(listQuery(category, pageParam)),
    getNextPageParam: (lastPage, _pages, lastPageParam) => (lastPage.hasMore ? lastPageParam + 1 : undefined),
    staleTime: category === "highlights" || category === "favorites" ? 0 : 60_000,
  });
  const pages = query.data?.pages;
  const lastPage = pages?.at(-1);
  const data = lastPage?.kind === "highlights" ? { ...lastPage, items: pages!.flatMap(result => (result.kind === "highlights" ? result.items : [])) } : lastPage;
  const currentPage = query.data?.pageParams.at(-1) ?? page;
  const reload = useCallback(async () => {
    revalidateReader(category);
    await queryClient.invalidateQueries({ queryKey: listKey(category), refetchType: "none" });
    await query.refetch();
  }, [category, queryClient, query.refetch]);
  const { surfaceRef, indicatorHeight, label, refreshing, refresh } = usePullToRefresh(reload);
  const { gutter, mainRef } = useReaderScroll(undefined, Boolean(data));
  const list = useRef<HTMLElement | null>(null);
  const sentinel = useRef<HTMLDivElement | null>(null);
  const prefetched = useRef(new Set<string>());
  const setMain = useCallback(
    (element: HTMLElement | null) => {
      list.current = element;
      return mainRef(element);
    },
    [mainRef],
  );
  useEffect(() => {
    prefetched.current = new Set();
  }, [category, page]);
  useEffect(() => {
    const root = list.current;
    if (!root || !data || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const code = (entry.target as HTMLElement).dataset.code;
        if (!code || prefetched.current.has(code)) continue;
        prefetched.current.add(code);
        observer.unobserve(entry.target);
        const itemPage = Number((entry.target as HTMLElement).dataset.page) || currentPage;
        void queryClient.prefetchQuery(articleQuery(code, false, category, itemPage, "low")).catch(() => {});
      }
    });
    for (const link of root.querySelectorAll<HTMLElement>("a.item-link[data-code]")) observer.observe(link);
    return () => observer.disconnect();
  }, [category, query.data, currentPage, queryClient]);
  useEffect(() => {
    const target = sentinel.current;
    if (!target || !query.hasNextPage || query.isFetching || query.isFetchNextPageError || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) void query.fetchNextPage({ cancelRefetch: false });
      },
      { rootMargin: "200px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [query.hasNextPage, query.isFetching, query.isFetchNextPageError, query.fetchNextPage]);
  const search = readerSearch(category, currentPage);

  return (
    <div className="reader-surface" ref={surfaceRef} {...gutter}>
      <main className="read-list" ref={setMain}>
        <h1 className="visually-hidden">阅读节选</h1>
        <div className="pull-refresh" role="status" style={{ height: indicatorHeight }}>
          {indicatorHeight >= 22 ? label : ""}
        </div>
        <nav className="categories" aria-label="阅读分类">
          {READ_CATEGORIES.map(item => (
            <Link key={item.id} to="/read" search={readerSearch(item.id)} activeOptions={{ exact: true }} aria-current={item.id === category ? "page" : undefined}>
              {item.label}
            </Link>
          ))}
        </nav>
        {query.isPending && <LoadingStatus />}
        {query.isError && !data && (
          <p role="alert">
            {query.error.message}{" "}
            <button type="button" className="other-link" disabled={refreshing} onClick={() => void refresh()}>
              重试
            </button>
          </p>
        )}
        {data && !data.items.length && <p>{data.kind === "highlights" && !data.available ? "划线数据库未配置" : "暂无条目"}</p>}
        {data?.kind === "articles" && data.items.length > 0 && (
          <ul>
            {data.items.map(item => (
              <li key={item.code} lang={item.titleLang}>
                <Link className="item-link" to="/r/$code" params={{ code: item.code }} search={search} data-code={item.code}>
                  {item.title}
                  {(item.source || item.author) && (
                    <p className="meta" lang="zh-CN">
                      {item.source && <span className="source">{item.source}</span>}
                      {item.source && item.author && " · "}
                      {item.author}
                    </p>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
        {data?.kind === "highlights" && data.items.length > 0 && (
          <ul>
            {data.items.map(item => {
              const itemPageIndex = pages?.findIndex(result => result.kind === "highlights" && result.items.some(entry => entry.id === item.id)) ?? -1;
              const itemSearch = readerSearch(category, query.data?.pageParams[itemPageIndex] ?? page);
              const article = item.article;
              const meta = <p className="meta">{article ? [article.title, article.source, item.located ? "" : "正文已变动，未能定位"].filter(Boolean).join(" · ") : "文章不可用"}</p>;
              return (
                <li key={item.id}>
                  {article && item.located ? (
                    <Link className="item-link" to="/r/$code" params={{ code: article.code }} search={itemSearch} hash={`hl-${item.id}`} hashScrollIntoView={{ block: "center", behavior: "instant" }} data-code={article.code} data-page={query.data?.pageParams[itemPageIndex]}>
                      {item.quote}
                      {meta}
                    </Link>
                  ) : (
                    <>
                      {item.quote}
                      {meta}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {data && query.hasNextPage && (
          <div className="list-actions" ref={sentinel} aria-live="polite" aria-busy={query.isFetchingNextPage}>
            {query.isFetchingNextPage ? (
              "加载中"
            ) : query.isFetchNextPageError ? (
              <button className="btn" type="button" onClick={() => void query.fetchNextPage()}>
                加载失败，重试
              </button>
            ) : typeof IntersectionObserver === "undefined" ? (
              <button className="btn" type="button" onClick={() => void query.fetchNextPage()}>
                加载更多
              </button>
            ) : null}
          </div>
        )}
      </main>
    </div>
  );
}
