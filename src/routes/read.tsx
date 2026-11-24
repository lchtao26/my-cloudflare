import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";
import { READ_CATEGORIES, readCategory } from "../reader/data.ts";
import { articleQuery, listQuery, readerSearch, revalidateReader, validateReaderSearch } from "../reader/queries.ts";
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
  const query = useQuery({
    ...listQuery(category, page),
    placeholderData: category === "highlights" ? undefined : keepPreviousData,
  });
  const data = query.data;
  const reload = useCallback(async () => {
    revalidateReader(category);
    try {
      await queryClient.fetchQuery({ ...listQuery(category, page, "reload"), staleTime: 0, networkMode: "always" });
    } catch {
      /* React Query exposes the error alongside the existing list. */
    }
  }, [category, page, queryClient]);
  const { surfaceRef, indicatorHeight, label, refreshing, refresh } = usePullToRefresh(reload);
  const { gutter, mainRef } = useReaderScroll(undefined, Boolean(data));
  const list = useRef<HTMLElement | null>(null);
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
        void queryClient.prefetchQuery(articleQuery(code, false, category, page, "low")).catch(() => {});
      }
    });
    for (const link of root.querySelectorAll<HTMLElement>("a.item-link[data-code]")) observer.observe(link);
    return () => observer.disconnect();
  }, [category, data, page, queryClient]);
  const search = readerSearch(category, page);

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
        {query.isError && (
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
              const article = item.article;
              const meta = <p className="meta">{article ? [article.title, article.source, item.located ? "" : "正文已变动，未能定位"].filter(Boolean).join(" · ") : "文章不可用"}</p>;
              return (
                <li key={item.id}>
                  {article && item.located ? (
                    <Link className="item-link" to="/r/$code" params={{ code: article.code }} search={search} hash={`hl-${item.id}`} hashScrollIntoView={{ block: "center", behavior: "instant" }} data-code={article.code}>
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
        {data && (
          <div className="list-actions" id="list-actions" aria-busy={query.isPlaceholderData}>
            {category === "highlights" && page > 1 && (
              <Link className="btn" to="/read" search={readerSearch(category, page - 1)}>
                上一页
              </Link>
            )}
            {data.hasMore &&
              (query.isPlaceholderData ? (
                <button className="btn" type="button" disabled>
                  加载中
                </button>
              ) : (
                <Link className="btn" id="load-more" to="/read" search={readerSearch(category, page + 1)} resetScroll={category === "highlights"}>
                  {category === "highlights" ? "下一页" : "加载更多"}
                </Link>
              ))}
          </div>
        )}
      </main>
    </div>
  );
}
