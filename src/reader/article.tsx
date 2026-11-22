import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useHydrated, useLocation } from "@tanstack/react-router";
import { createElement, useCallback, useRef, useState, type MouseEvent, type ReactNode, type RefCallback } from "react";
import type { MarkdownNode } from "../explanation-markdown.ts";
import { canonicalText } from "../highlight-anchor.ts";
import type { ReadCategory, ReaderArticle } from "../reader-data.ts";
import { ReadingBody, type ParagraphSelection } from "./body.tsx";
import { BodyActionSheet } from "./body-actions.tsx";
import { quoteBetween, selectionPreview } from "./quote-slice.ts";
import { ReaderDialog } from "./dialog.tsx";
import type { TokenRange } from "./tokenize.ts";
import { LoadingStatus } from "./loading.tsx";
import { articleKey, articleQuery, listKey, performAction, ReaderError, readerSearch, type ReaderAction } from "./queries.ts";
import { useReaderScroll } from "./reading.ts";

export type InitialArticle =
  | { data: ReaderArticle; error?: never }
  | { data?: never; error: { message: string; status: number } };

function backToPreviousPage(event: MouseEvent<HTMLAnchorElement>) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey ||
    (event.currentTarget.target && event.currentTarget.target !== "_self") || event.currentTarget.hasAttribute("download") ||
    window.history.length <= 1) return;
  try {
    window.history.back();
    event.preventDefault();
  } catch {}
}

export function ArticleRoute({ code, category, page, shared, initial }: {
  code: string; category: ReadCategory; page: number; shared: boolean; initial?: InitialArticle;
}) {
  const hydrated = useHydrated();
  const query = useQuery({
    ...articleQuery(code, shared, category, page),
    initialData: initial?.data,
    enabled: !initial?.error,
    refetchOnMount: !initial || hydrated,
  });
  const error = query.error ?? initial?.error;
  if (query.isPending && (!error || query.isFetching)) return <main><LoadingStatus /></main>;
  if (!query.data) {
    const missing = error != null && "status" in error && error.status === 404;
    return <main>
      <p role={missing ? undefined : "alert"}>{error?.message ?? "未找到文章。"}</p>
      {!missing && <button type="button" className="other-link" onClick={() => void query.refetch()}>重试</button>}
      <p><Link to="/read" search={readerSearch()} onClick={backToPreviousPage}>返回</Link></p>
    </main>;
  }
  return <Article data={query.data} category={category} page={page} hydrated={hydrated} />;
}

function markdown(nodes: MarkdownNode[]): ReactNode[] {
  return nodes.map((node, index) => node.type === "text" ? node.text
    : createElement(node.tag, { key: index, href: node.href, start: node.start }, markdown(node.children)));
}

function isModelAction(action: ReaderAction) {
  return action.type === "original" || action.type === "explain";
}

function isAbortError(error: unknown) {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function Article({ data, category, page, hydrated }: { data: ReaderArticle; category: ReadCategory; page: number; hydrated: boolean }) {
  const { item, actions } = data;
  const queryClient = useQueryClient();
  const hash = useLocation({ select: location => location.hash });
  const { progress, syncError, remoteProgress, syncToRemote, dismissRemote, gutter, mainRef } = useReaderScroll(actions ? item.code : undefined, true, Boolean(hash));
  const highlights = actions?.highlights ?? [];
  const anchoredMark = highlights.find(mark => hash === `hl-${mark.id}`);
  const hasOriginal = data.original.length > 0;
  const [showOriginal, setShowOriginal] = useState(hydrated && anchoredMark?.field === "original" && hasOriginal);
  const [selected, setSelected] = useState<ParagraphSelection | null>(null);
  const [pinPrompt, setPinPrompt] = useState<ReaderAction | null>(null);
  const [resultPanel, setResultPanel] = useState<ReaderAction | null>(null);
  const [failure, setFailure] = useState<{ message: string; retry?: ReaderAction } | null>(null);
  const [addedLater, setAddedLater] = useState(false);
  const syncedAnchor = useRef<string | null>(null);
  const scrolledAnchor = useRef<string | null>(null);
  const modelAbort = useRef<AbortController | null>(null);

  if (anchoredMark && syncedAnchor.current !== anchoredMark.id) {
    syncedAnchor.current = anchoredMark.id;
    if (anchoredMark.field !== "terms") {
      const next = anchoredMark.field === "original" && hasOriginal;
      if (showOriginal !== next) setShowOriginal(next);
    }
  }

  const setMain = useCallback<RefCallback<HTMLElement>>(element => {
    const cleanup = mainRef(element);
    if (!element || !anchoredMark || scrolledAnchor.current === hash) return cleanup;
    scrolledAnchor.current = hash;
    const frame = requestAnimationFrame(() => document.getElementById(hash)?.scrollIntoView({ block: "center" }));
    return () => {
      cancelAnimationFrame(frame);
      cleanup?.();
    };
  }, [anchoredMark, hash, mainRef]);

  const mutation = useMutation({
    mutationFn: ({ action, pin, signal }: { action: ReaderAction; pin?: string; signal?: AbortSignal }) =>
      performAction(item.code, action, pin, signal),
    onSuccess: async (result, { action }) => {
      if (action.type === "favorite") {
        queryClient.setQueriesData<ReaderArticle>({ queryKey: articleKey(item.code) }, current =>
          current?.actions ? { ...current, actions: { ...current.actions, favorite: Boolean(result.favorite) } } : current);
        await queryClient.invalidateQueries({ queryKey: listKey("favorites") });
      }
      if (action.type === "delete") {
        queryClient.setQueriesData<ReaderArticle>({ queryKey: articleKey(item.code) }, current => {
          if (!current?.actions) return current;
          return { ...current, actions: { ...current.actions, highlights: current.actions.highlights.filter(mark => mark.id !== result.id) } };
        });
        await queryClient.invalidateQueries({ queryKey: listKey("highlights") });
      }
      if (result.highlights?.length) {
        const savedIds = new Set(result.highlights.map(mark => mark.id));
        queryClient.setQueriesData<ReaderArticle>({ queryKey: articleKey(item.code) }, current => {
          if (!current?.actions) return current;
          const updated = current.actions.highlights.filter(mark => !savedIds.has(mark.id));
          updated.push(...result.highlights!);
          return { ...current, actions: { ...current.actions, highlights: updated } };
        });
        await queryClient.invalidateQueries({ queryKey: listKey("highlights") });
      }
    },
  });

  function run(action: ReaderAction, pin?: string) {
    if (mutation.isPending) return;
    setFailure(null);
    const controller = isModelAction(action) ? new AbortController() : null;
    modelAbort.current = controller;
    if (!pin && isModelAction(action)) setResultPanel(action);
    mutation.mutate({ action, pin, signal: controller?.signal }, {
      onError(error) {
        if (action.data.save === "1") {
          void queryClient.invalidateQueries({ queryKey: articleKey(item.code) });
          void queryClient.invalidateQueries({ queryKey: listKey("highlights") });
        }
        if (isAbortError(error)) return;
        if (error instanceof ReaderError && error.requiresPin) {
          setResultPanel(null);
          setPinPrompt(action);
        } else {
          setPinPrompt(null);
          if (isModelAction(action)) {
            if (pin) setResultPanel(action);
          } else {
            setFailure({ message: error.message, retry: action });
          }
        }
      },
      onSuccess() {
        setPinPrompt(null);
        if (action.type === "add-later") setAddedLater(true);
        if (action.type === "delete" && hash === `hl-${action.data.id}`) {
          history.replaceState(history.state, "", location.pathname + location.search);
        }
        if (pin && isModelAction(action)) setResultPanel(action);
      },
    });
  }

  function paragraphAction(type: "highlight" | "delete" | "explain" | "original", ranges?: TokenRange[]) {
    if (!selected) return;
    if (ranges) {
      const length = ranges.reduce((total, range) => total + range.end - range.start, 0);
      if (!ranges.length || length > 1500) {
        if (length > 1500) setFailure({ message: "最多选择 1500 字。" });
        return;
      }
      setSelected(null);
      const field = selected.field;
      if (type === "highlight") run({ type, data: { field, ranges: JSON.stringify(ranges) } });
      else if (type === "explain") run({
        type, data: { action: "explain", field, ranges: JSON.stringify(ranges), save: "1", context: "paragraph" },
        quote: ranges.map(range => range.quote).join("\n"),
      });
      return;
    }
    setSelected(null);
    if (type === "delete") {
      if (selected.highlightId) run({ type, data: { action: "delete", id: selected.highlightId } });
      return;
    }
    if (type === "explain" && selected.highlightId) {
      const mark = highlights.find(item => item.id === selected.highlightId);
      if (!mark || mark.end <= mark.start) return;
      if (mark.end - mark.start > 1500) {
        setFailure({ message: "最多选择 1500 字。" });
        return;
      }
      const source = selected.field === "original" ? data.original : selected.field === "terms" ? data.terms : data.body;
      const quote = quoteBetween(source, mark.start, mark.end);
      if (canonicalText(quote).length !== mark.end - mark.start) {
        setFailure({ message: "正文已更新，请刷新后重试。" });
        return;
      }
      run({
        type,
        data: { action: "explain", field: selected.field, ranges: JSON.stringify([{ start: mark.start, end: mark.end, quote }]) },
        quote,
      });
      return;
    }
    const { start, end, quote } = selected.paragraph;
    if (end === start) return;
    if (end - start > 1500) {
      setFailure({ message: "段落最多 1500 字。" });
      return;
    }
    const field = selected.field;
    const params: Record<string, string> = type === "highlight"
      ? { field, start: String(start), end: String(end), quote }
      : { action: type, field, ranges: JSON.stringify([{ start, end, quote }]), ...(type === "explain" ? { context: "around" } : {}) };
    run({ type, data: params, quote });
  }

  function dismissResult() {
    const action = mutation.isPending ? mutation.variables?.action : undefined;
    if (action && resultPanel?.type === action.type && isModelAction(action)) modelAbort.current?.abort();
    setResultPanel(null);
  }

  const modelError = mutation.error && !isAbortError(mutation.error) ? mutation.error.message : undefined;
  const search = readerSearch(category, page);
  const originalTitle = data.originalTitle || item.title;
  const origTitleLang = data.originalTitle ? data.originalLang : item.titleLang;
  return (
    <div className="reader-surface" {...gutter}>
      <title>{item.title}</title>
      <main ref={setMain}>
        {syncError && <p role="status">阅读进度暂未同步，请检查网络后继续阅读。</p>}
        <article>
          <h1 lang={item.titleLang}>{item.title}</h1>
          <p className="article-byline">
            <span className="author-row"><span>{data.date || "—"}</span>{item.author && <span>{item.author}</span>}</span>
            {(actions || hasOriginal) && <span className="byline-actions">
            {actions && <Link className="other-link" to="/read" search={readerSearch()} onClick={backToPreviousPage}>返回</Link>}
            {hasOriginal && <button className="other-link" type="button" aria-controls="original-body"
              aria-expanded={showOriginal} onClick={() => setShowOriginal(value => {
                const next = !value;
                try { localStorage.setItem(`read-view:${item.code}`, next ? "original" : "translation"); }
                catch { /* Local storage can be disabled. */ }
                return next;
              })}>{showOriginal ? "显示翻译" : "显示原文"}</button>}
            </span>}
          </p>
          <ReadingBody id={hasOriginal ? "translated-body" : undefined} field={data.field} lang={data.lang}
            paragraphs={data.body} highlights={highlights} hidden={showOriginal}
            select={actions?.highlightsEnabled ? setSelected : undefined} />
          {hasOriginal && <ReadingBody id="original-body" field="original" lang={data.originalLang}
            paragraphs={data.original} highlights={highlights} hidden={!showOriginal}
            select={actions?.highlightsEnabled ? setSelected : undefined} />}
          {actions && <p className="other">
            <button type="button" className="other-link" disabled={mutation.isPending || addedLater}
              aria-label={addedLater ? "已加入待读" : "待读"}
              onClick={() => run({ type: "add-later", data: {} })}>
              <span role="status">{addedLater ? "已加入待读" : "待读"}</span>
            </button>{" "}
            <button type="button" className="other-link" disabled={mutation.isPending}
              aria-label={actions.favorite ? "取消收藏" : "收藏"}
              onClick={() => run({ type: "favorite", data: { favorite: actions.favorite ? "0" : "1" } })}>
              <span role="status">{actions.favorite ? "取消收藏" : "收藏"}</span>
            </button>{" "}
            <a className="other-link" href={actions.notionUrl}>管理</a>{" "}
            <ShareButton code={item.code} />
          </p>}
          <hr />
          <p className="detail-metadata">
            {(data.originalUrl || data.originalTitle && data.originalTitle !== item.title) && <>
              原文：{data.originalUrl ? <a className="metadata-link" href={data.originalUrl} lang={origTitleLang}>
                {originalTitle}</a> : <span lang={origTitleLang}>{originalTitle}</span>}<br />
            </>}
            {data.publisher && <>来源：{data.publisher}<br /></>}
            {data.chapter && <>章节：{data.chapter}<br /></>}
            日期：{data.date || "—"}
          </p>
          {data.terms.length > 0 && <><hr /><p>名词解释</p>
            <ReadingBody field="terms" paragraphs={data.terms} highlights={highlights}
              select={actions?.highlightsEnabled ? setSelected : undefined} /></>}
        </article>
        {actions && <nav className="nav-row" aria-label="文章导航">
          {actions.prevCode
            ? <Link to="/r/$code" params={{ code: actions.prevCode }} search={search}>上一篇</Link>
            : <span className="is-disabled">上一篇</span>}
          <Link to="/read" search={readerSearch()} onClick={backToPreviousPage}>返回</Link>
          {actions.nextCode
            ? <Link to="/r/$code" params={{ code: actions.nextCode }} search={search}>下一篇</Link>
            : <span className="is-disabled">下一篇</span>}
        </nav>}
      </main>
      {remoteProgress !== null && (
        <div className="progress-sync" role="region" aria-label="阅读进度同步">
          <span>远端已读至 {Math.round(remoteProgress * 100)}%</span>
          <div className="progress-sync-actions">
            <button type="button" onClick={syncToRemote}>同步</button>
            <button type="button" onClick={dismissRemote}>忽略</button>
          </div>
        </div>
      )}
      <div className="progress" aria-hidden="true"><span className="progress-bar" style={{ width: `${progress * 100}%` }} /></div>
      {selected && <BodyActionSheet key={`${selected.field}:${selected.paragraph.start}:${selected.highlightId ?? ""}`} selected={selected}
        preview={selectionPreview(selected, highlights, selected.field === "original" ? data.original : selected.field === "terms" ? data.terms : data.body)}
        showOriginalButton={hasOriginal && selected.field === "translation"} pending={mutation.isPending}
        dismiss={() => setSelected(null)} act={paragraphAction} />}
      {pinPrompt && <ReaderDialog id="favorite-dialog" label="收藏验证" dismiss={() => setPinPrompt(null)}>
        <PinForm pending={mutation.isPending} error={mutation.isError && mutation.error instanceof ReaderError && mutation.error.requiresPin
          ? (mutation.error.message === "请输入 6 位密码。" ? "" : mutation.error.message) : undefined}
          submit={pin => run(pinPrompt, pin)} cancel={() => setPinPrompt(null)} />
      </ReaderDialog>}
      {failure && <ReaderDialog id="highlight-error" label="操作失败" dismiss={() => setFailure(null)}>
        <p role="alert">{failure.message}</p>
        <div><button type="button" onClick={() => setFailure(null)}>关闭</button>
          {failure.retry && <button type="button" onClick={() => run(failure.retry!)}>重试</button>}
        </div>
      </ReaderDialog>}
      {resultPanel && (resultPanel.type === "original" ? (
        <ReaderDialog id="original-match-dialog" label="原文匹配" dismiss={dismissResult}>
          <div id="original-match-content">
            <section><h2>译文</h2><p id="original-match-current">{resultPanel.quote}</p></section>
            <section><h2>原文</h2><p id="original-match-text" role="status">
              {mutation.isPending ? "正在匹配原文…" : modelError ?? mutation.data?.paragraph ?? "未找到匹配段落。"}
            </p></section>
          </div>
        </ReaderDialog>
      ) : (
        <ReaderDialog id="explanation-dialog" label="段落解释" dismiss={dismissResult}>
          <div id="explanation-text" aria-live="polite">{mutation.isPending ? "正在解释…"
            : modelError ?? (mutation.data?.markdown ? markdown(mutation.data.markdown) : mutation.data?.explanation)}</div>
        </ReaderDialog>
      ))}
    </div>
  );
}

function PinForm({ pending, error, submit, cancel }: {
  pending: boolean; error?: string; submit: (pin: string) => void; cancel: () => void;
}) {
  // Remount when the error text changes so the field clears and autoFocus runs again.
  return <PinFields key={error ?? "ready"} pending={pending} error={error} submit={submit} cancel={cancel} />;
}

function PinFields({ pending, error, submit, cancel }: {
  pending: boolean; error?: string; submit: (pin: string) => void; cancel: () => void;
}) {
  const [pin, setPin] = useState("");
  return <>
    <form onSubmit={event => {
      event.preventDefault();
      if (!pending && /^[0-9]{6}$/.test(pin)) submit(pin);
    }}>
      <p><label htmlFor="pin">请输入 6 位密码</label></p>
      <div className="pin-wrap pin-enhanced">
        <input id="pin" name="pin" type="password" autoFocus inputMode="numeric" autoComplete="current-password"
          maxLength={6} value={pin} disabled={pending} onChange={event => {
            const value = event.currentTarget.value.replace(/\D/g, "");
            setPin(value);
            if (value.length === 6) submit(value);
          }} />
        <div className="pin-slots" aria-hidden="true">
          {Array.from({ length: 6 }, (_, index) => <span key={index}
            className={index < pin.length ? "filled" : index === pin.length ? "active" : undefined} />)}
        </div>
      </div>
      <p id="favorite-error" role="alert">{error}</p>
      {pending && <p role="status">正在验证…</p>}
    </form>
    <button type="button" className="favorite-close" onClick={cancel}>取消</button>
  </>;
}

function ShareButton({ code }: { code: string }) {
  const [status, setStatus] = useState("分享");
  async function share() {
    const value = new URL(`/s/${code}`, location.origin).href;
    try {
      await navigator.clipboard.writeText(value);
      setStatus("已复制");
    } catch {
      const input = document.createElement("textarea");
      input.value = value;
      input.style.position = "fixed";
      input.style.left = "-10000px";
      document.body.appendChild(input);
      input.select();
      try { setStatus(document.execCommand("copy") ? "已复制" : "复制失败"); }
      catch { setStatus("复制失败"); }
      finally { input.remove(); }
    }
  }
  return <button type="button" className="other-link" aria-label={status} onClick={() => void share()}><span role="status">{status}</span></button>;
}
