import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useLocation } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, type MouseEvent } from "react";
import { READ_CATEGORIES, readCategory } from "../reader-data.ts";
import { listQuery, readerSearch, validateReaderSearch } from "../reader/queries.ts";
import { usePullToRefresh } from "../reader/pull-to-refresh.ts";
import { useReaderScroll } from "../reader/reading.ts";

export const Route = createFileRoute("/read")({
  ssr: false,
  validateSearch: validateReaderSearch,
  component: ReadingList,
});

function rememberArticle(event: MouseEvent<HTMLAnchorElement>, anchor: string) {
  if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  history.replaceState(history.state, "", `${location.pathname}${location.search}#${anchor}`);
}

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
  const hash = useLocation({ select: location => location.hash });
  const surface = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLElement>(null);
  const appliedAnchor = useRef<string | null>(null);
  const reload = useCallback(async () => {
    try {
      await queryClient.fetchQuery({ ...listQuery(category, page, "reload"), staleTime: 0, networkMode: "always" });
    } catch { /* React Query exposes the error alongside the existing list. */ }
  }, [category, page, queryClient]);
  const { indicatorHeight, label, refreshing, refresh } = usePullToRefresh(surface, reload);
  const { gutter, canReturnToTop } = useReaderScroll(main, undefined, Boolean(data));
  const search = readerSearch(category, page);
  useEffect(() => {
    if (!data || query.isPlaceholderData) return;
    // A refresh replaces the data for the same location. Apply its anchor only once.
    const anchor = `${page}:${hash}`;
    if (appliedAnchor.current === anchor) return;
    appliedAnchor.current = anchor;
    if (hash) document.getElementById(hash)?.scrollIntoView({ block: "center" });
  }, [data, hash, page, query.isPlaceholderData]);
  const articleAnchors = new Set<string>();
  const lastItem = data?.kind === "articles" ? data.items.at(-1)?.code : undefined;

  return (
    <div className="reader-surface" ref={surface} {...gutter}>
      <main className="read-list" ref={main}>
        <h1 className="visually-hidden">阅读节选</h1>
        <div className="pull-refresh" role="status" style={{ height: indicatorHeight }}>
          {indicatorHeight >= 22 ? label : ""}
        </div>
        <nav className="categories" aria-label="阅读分类">
          {READ_CATEGORIES.map(item => (
            <Link key={item.id} to="/read" search={readerSearch(item.id)}
              activeOptions={{ exact: true }}
              aria-current={item.id === category ? "page" : undefined}>
              {item.label}
            </Link>
          ))}
        </nav>
        {query.isPending && <p role="status">正在加载…</p>}
        {query.isError && <p role="alert">{query.error.message} <button type="button" className="other-link" disabled={refreshing} onClick={() => void refresh()}>重试</button></p>}
        {data && !data.items.length && (
          <p>{data.kind === "highlights" && !data.available ? "划线数据库未配置" : "暂无条目"}</p>
        )}
        {data?.kind === "articles" && data.items.length > 0 && (
          <ul>
            {data.items.map(item => (
              <li key={item.code} id={item.code} lang={item.titleLang} tabIndex={-1}>
                <Link className="item-link" to="/r/$code" params={{ code: item.code }} search={search} reloadDocument
                  onClick={event => rememberArticle(event, item.code)}>{item.title}</Link>
                {(item.source || item.author) && <p className="meta" lang="zh-CN">
                  {[item.source, item.author ? `作者：${item.author}` : ""].filter(Boolean).join(" · ")}
                </p>}
              </li>
            ))}
          </ul>
        )}
        {data?.kind === "highlights" && data.items.length > 0 && (
          <ul>
            {data.items.map(item => {
              const anchor = `hl-${item.id}`;
              const article = item.article;
              const first = article && !articleAnchors.has(article.code);
              if (article) articleAnchors.add(article.code);
              return <li key={item.id} id={anchor}>
                {first && <span id={article.code} />}
                {article && item.located
                  ? <Link className="item-link" to="/r/$code" params={{ code: article.code }} search={search} reloadDocument
                      hash={anchor} onClick={event => rememberArticle(event, anchor)}>{item.quote}</Link>
                  : item.quote}
                <p className="meta">{article
                  ? [article.title, article.source, item.located ? "" : "正文已变动，未能定位"].filter(Boolean).join(" · ")
                  : "文章不可用"}</p>
              </li>;
            })}
          </ul>
        )}
        {data && (
          <div className="list-actions" id="list-actions" aria-busy={query.isPlaceholderData}>
            {canReturnToTop && <button className="btn" type="button" onClick={() => window.scrollTo(0, 0)}>返回顶部</button>}
            <button className="btn" type="button" disabled={refreshing || query.isPlaceholderData} onClick={() => void refresh()}>
              {refreshing ? "正在刷新…" : "刷新列表"}
            </button>
            {category === "highlights" && page > 1 && <Link className="btn" to="/read" search={readerSearch(category, page - 1)}>上一页</Link>}
            {data.hasMore && (query.isPlaceholderData
              ? <button className="btn" type="button" disabled>加载中…</button>
              : <Link className="btn" id="load-more" to="/read" search={readerSearch(category, page + 1)}
                  hash={lastItem} resetScroll={category === "highlights"}>{category === "highlights" ? "下一页" : "加载更多"}</Link>)}
          </div>
        )}
      </main>
    </div>
  );
}
