import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type MouseEvent, type RefCallback } from "react";
import { renderMarkdown } from "./markdown-elements.ts";
import { canonicalText } from "./highlight-anchor.ts";
import { listNeighborCodes, type ReadCategory, type ReaderArticle, type ReaderList, type ReaderNeighbors } from "./data.ts";
import { ReadingBody, type ParagraphSelection } from "./body.tsx";
import { ParagraphPanel } from "./body-actions.tsx";
import { clickParagraphChrome, clickSurfaceChrome, closeChrome, selectChromeTab, type ReadingChrome, type ReadingTab } from "./chrome.ts";
import { quoteBetween, selectionPreview } from "./quote-slice.ts";
import { ReaderDialog } from "./dialog.tsx";
import type { TokenRange } from "./tokenize.ts";
import { LoadingStatus } from "./loading.tsx";
import { articleQuery, listKey, listQuery, performAction, ReaderError, readerSearch, readSessionQuery, reconcileArticleOnError, revalidateReader, updateArticleCache, type ReaderAction } from "./queries.ts";
import { useReaderScroll } from "./reading.ts";

export function ArticleRoute({ code, category, page, shared }: { code: string; category: ReadCategory; page: number; shared: boolean }) {
  const query = useQuery(articleQuery(code, shared, category, page));
  if (query.isPending)
    return (
      <main>
        <LoadingStatus />
      </main>
    );
  if (!query.data) {
    const error = query.error;
    const missing = error != null && "status" in error && error.status === 404;
    return (
      <main>
        <p role={missing ? undefined : "alert"}>{error?.message ?? "未找到文章。"}</p>
        {!missing && (
          <button type="button" className="other-link" onClick={() => void query.refetch()}>
            重试
          </button>
        )}
        <p>
          <Link to="/read" search={readerSearch(category, page)}>
            返回
          </Link>
        </p>
      </main>
    );
  }
  return <Article data={query.data} category={category} page={page} />;
}

function isModelAction(action: ReaderAction) {
  return action.type === "original" || action.type === "explain";
}

function isAbortError(error: unknown) {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function useArticleNeighbors(code: string, category: ReadCategory, page: number, enabled: boolean): { neighbors: ReaderNeighbors | undefined; navRef: RefCallback<HTMLElement> } {
  const queryClient = useQueryClient();
  const [near, setNear] = useState(false);
  const [nav, setNav] = useState<HTMLElement | null>(null);
  const snapshot = queryClient.getQueryData<ReaderList>([...listKey(category), page]);
  const cachedNeighbors = snapshot ? listNeighborCodes(snapshot, code) : undefined;
  const query = useQuery({
    ...listQuery(category, page),
    enabled: enabled && near && cachedNeighbors === undefined,
  });
  const list = query.data ?? snapshot;
  const fromList = list ? listNeighborCodes(list, code) : undefined;
  const finishedEmpty = near && query.isFetched && !query.isFetching && fromList === undefined;
  const neighbors = !enabled ? undefined : (cachedNeighbors ?? fromList ?? (finishedEmpty ? { prevCode: null, nextCode: null } : undefined));
  const waiting = enabled && neighbors === undefined;
  useEffect(() => {
    if (!nav || !waiting) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) setNear(true);
      },
      { root: nav.closest(".reader-scroll"), rootMargin: "200px 0px" },
    );
    observer.observe(nav);
    return () => observer.disconnect();
  }, [nav, waiting]);
  return { neighbors, navRef: setNav };
}

function Article({ data, category, page }: { data: ReaderArticle; category: ReadCategory; page: number }) {
  const { item, actions } = data;
  const { neighbors, navRef } = useArticleNeighbors(item.code, category, page, Boolean(actions));
  const queryClient = useQueryClient();
  const session = useQuery({ ...readSessionQuery(), enabled: Boolean(actions) });
  const signedIn = session.data === true;
  const pathname = useLocation({ select: location => location.pathname });
  const searchStr = useLocation({ select: location => location.searchStr });
  const hash = useLocation({ select: location => location.hash });
  const { progress, syncError, remoteProgress, syncToRemote, dismissRemote, gutter, mainRef } = useReaderScroll(actions ? item.code : undefined, true, Boolean(hash), signedIn);
  const highlights = actions?.highlights ?? [];
  const anchoredMark = highlights.find(mark => hash === `hl-${mark.id}`);
  const hasOriginal = data.original.length > 0;
  const [showOriginal, setShowOriginal] = useState(anchoredMark?.field === "original" && hasOriginal);
  const [chrome, setChrome] = useState<ReadingChrome>({ open: false });
  const [pinPrompt, setPinPrompt] = useState<ReaderAction | null>(null);
  const [resultPanel, setResultPanel] = useState<ReaderAction | null>(null);
  const [failure, setFailure] = useState<{ message: string; retry?: ReaderAction } | null>(null);
  const [addedLater, setAddedLater] = useState(false);
  const readingTab = chrome.open ? chrome.tab : null;
  const activePress = useRef<{ x: number; y: number; scroll: number } | null>(null);
  const bindReadingPanel = useCallback(
    (panel: HTMLDivElement | null) => {
      if (!panel) return;
      const frame = requestAnimationFrame(() => {
        if (panel.id === `reading-panel-${readingTab}`) panel.removeAttribute("hidden");
        else panel.setAttribute("hidden", "until-found");
      });
      return () => cancelAnimationFrame(frame);
    },
    [readingTab],
  );
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

  const setMain = useCallback<RefCallback<HTMLElement>>(
    element => {
      const cleanup = mainRef(element);
      if (!element || !anchoredMark || scrolledAnchor.current === hash) return cleanup;
      let timer = 0;
      const frame = requestAnimationFrame(() => {
        // The router's hash scroll runs in an effect and aligns to the top unless the link overrides it.
        timer = window.setTimeout(() => {
          const node = document.getElementById(hash);
          if (!node) return;
          node.scrollIntoView({ block: "center", behavior: "instant" });
          scrolledAnchor.current = hash;
        }, 0);
      });
      return () => {
        cancelAnimationFrame(frame);
        window.clearTimeout(timer);
        cleanup?.();
      };
    },
    [anchoredMark, hash, mainRef],
  );

  const mutation = useMutation({
    mutationFn: ({ action, pin, signal }: { action: ReaderAction; pin?: string; signal?: AbortSignal }) => performAction(item.code, action, pin, signal),
    onSuccess: async (result, { action }) => {
      if (action.type === "add-later") {
        revalidateReader("later");
        void queryClient.invalidateQueries({ queryKey: listKey("later"), refetchType: "none" }).then(() => queryClient.invalidateQueries({ queryKey: ["reader", "infinite", "later"] }));
      }
      if (action.type === "favorite") {
        await updateArticleCache(queryClient, item.code, "favorites", current => (current.actions ? { ...current, actions: { ...current.actions, favorite: Boolean(result.favorite) } } : current));
      }
      if (action.type === "delete") {
        await updateArticleCache(queryClient, item.code, "highlights", current => {
          if (!current.actions) return current;
          return { ...current, actions: { ...current.actions, highlights: current.actions.highlights.filter(mark => mark.id !== result.id) } };
        });
      }
      if (result.highlights?.length) {
        const savedIds = new Set(result.highlights.map(mark => mark.id));
        await updateArticleCache(queryClient, item.code, "highlights", current => {
          if (!current.actions) return current;
          const updated = current.actions.highlights.filter(mark => !savedIds.has(mark.id));
          updated.push(...result.highlights!);
          return { ...current, actions: { ...current.actions, highlights: updated } };
        });
      }
    },
    onError: (error, { action }) => {
      reconcileArticleOnError(queryClient, item.code, action, error);
    },
  });

  function run(action: ReaderAction, pin?: string) {
    if (mutation.isPending) return;
    setFailure(null);
    const controller = isModelAction(action) ? new AbortController() : null;
    modelAbort.current = controller;
    if (!pin && isModelAction(action)) setResultPanel(action);
    mutation.mutate(
      { action, pin, signal: controller?.signal },
      {
        onError(error) {
          if (isAbortError(error)) return;
          if (error instanceof ReaderError && error.requiresPin) {
            setResultPanel(null);
            setPinPrompt(action);
          } else {
            setPinPrompt(null);
            if (isModelAction(action)) {
              if (pin) setResultPanel(action);
            } else {
              setFailure({ message: error.message || "操作失败，请稍后重试。", retry: action });
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
      },
    );
  }

  function paragraphAction(type: "highlight" | "delete" | "explain" | "original", ranges?: TokenRange[]) {
    const selected = chrome.open ? chrome.selection : null;
    if (!selected) return;
    if (ranges) {
      const length = ranges.reduce((total, range) => total + range.end - range.start, 0);
      if (!ranges.length || length > 1500) {
        if (length > 1500) setFailure({ message: "最多选择 1500 字。" });
        return;
      }
      setChrome(closeChrome());
      const field = selected.field;
      if (type === "highlight") run({ type, data: { field, ranges: JSON.stringify(ranges) } });
      else if (type === "explain")
        run({
          type,
          data: { action: "explain", field, ranges: JSON.stringify(ranges), save: "1", context: "paragraph" },
          quote: ranges.map(range => range.quote).join("\n"),
        });
      return;
    }
    setChrome(closeChrome());
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
    const params: Record<string, string> = type === "highlight" ? { field, start: String(start), end: String(end), quote } : { action: type, field, ranges: JSON.stringify([{ start, end, quote }]), ...(type === "explain" ? { context: "around" } : {}) };
    run({ type, data: params, quote });
  }

  function dismissResult() {
    const action = mutation.isPending ? mutation.variables?.action : undefined;
    if (action && resultPanel?.type === action.type && isModelAction(action)) modelAbort.current?.abort();
    setResultPanel(null);
  }

  const readingActionsRef = useCallback((top: HTMLDivElement | null) => {
    if (!top) return;
    const surface = top.parentElement;
    if (!surface) return;
    // Footer mounts as a sibling after this header; wait a frame so tabs exist.
    let teardown = () => {};
    const frame = requestAnimationFrame(() => {
      const scroller = () => surface.querySelector<HTMLElement>(":scope > .reader-scroll");
      const scrollY = () => scroller()?.scrollTop ?? window.scrollY;
      const actionBar = () => surface.querySelector(":scope > .reading-actions");
      const chromeContains = (node: Node) => top.contains(node) || Boolean(actionBar()?.contains(node));
      const tabs = () => [...surface.querySelectorAll<HTMLButtonElement>(".reading-tabs button")];
      const rows = () => [...surface.querySelectorAll(".reading-top.reading-actions-row, .reading-actions .reading-actions-row")];
      const rowItems = (row: Element) => [...row.querySelectorAll<HTMLElement>("button, a")];
      const nativeFocusGroup = "focusGroup" in HTMLElement.prototype;
      const mark = (controls: HTMLElement[], selected: HTMLElement | undefined) => {
        controls.forEach(control => {
          control.tabIndex = control === selected ? 0 : -1;
        });
      };
      const syncControls = () => {
        surface.querySelector(".reading-tabs")?.setAttribute("focusgroup", "tablist nomemory");
        const tabList = tabs();
        for (const tab of tabList) tab.toggleAttribute("focusgroupstart", tab.getAttribute("aria-selected") === "true");
        if (!nativeFocusGroup)
          mark(
            tabList,
            tabList.find(tab => tab.getAttribute("aria-selected") === "true"),
          );
        for (const row of rows()) {
          row.setAttribute("focusgroup", "toolbar wrap");
          if (nativeFocusGroup || row.closest("[hidden]")) continue;
          const controls = rowItems(row);
          const active = controls.find(control => control === document.activeElement) ?? controls.find(control => control.tabIndex === 0) ?? controls[0];
          mark(controls, active);
        }
      };
      syncControls();
      const controlsObserver = new MutationObserver(syncControls);
      controlsObserver.observe(surface, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "aria-selected"] });
      const onBeforeMatch = (event: Event) => {
        const panel = event.target;
        if (!(panel instanceof HTMLElement)) return;
        const id = panel.getAttribute("aria-labelledby");
        if (id === "reading-tab-article" || id === "reading-tab-share") setChrome(current => selectChromeTab(current, id.slice("reading-tab-".length) as ReadingTab));
      };
      surface.addEventListener("beforematch", onBeforeMatch);
      let pressedInChrome = false;
      const onDocClick = (event: globalThis.MouseEvent) => {
        if (pressedInChrome) {
          pressedInChrome = false;
          return;
        }
        const path = event.composedPath();
        const bar = actionBar();
        if (!(event.target instanceof Node) || path.includes(top) || (bar && path.includes(bar)) || chromeContains(event.target)) return;
        setChrome(closeChrome());
      };
      const rememberPress = (x: number, y: number, target: EventTarget | null) => {
        pressedInChrome = target instanceof Node && chromeContains(target);
        if (pressedInChrome) {
          activePress.current = null;
          return;
        }
        activePress.current = { x, y, scroll: scrollY() };
      };
      const dismissScrolledPress = (x: number, y: number) => {
        const press = activePress.current;
        if (!press) return;
        if (Math.abs(x - press.x) <= 10 && Math.abs(y - press.y) <= 10 && Math.abs(scrollY() - press.scroll) <= 5) return;
        activePress.current = null;
        setChrome(closeChrome());
      };
      const onPointerDown = (event: globalThis.PointerEvent) => {
        if (!event.isPrimary || event.button !== 0) return;
        rememberPress(event.clientX, event.clientY, event.target);
      };
      const onPointerMove = (event: globalThis.PointerEvent) => {
        if (!event.isPrimary) return;
        dismissScrolledPress(event.clientX, event.clientY);
      };
      const onTouchStart = (event: globalThis.TouchEvent) => {
        if (window.PointerEvent) return;
        const touch = event.touches[0];
        if (event.touches.length === 1 && touch) rememberPress(touch.clientX, touch.clientY, event.target);
      };
      const onTouchMove = (event: globalThis.TouchEvent) => {
        if (window.PointerEvent) return;
        const touch = event.touches[0];
        if (touch) dismissScrolledPress(touch.clientX, touch.clientY);
      };
      const onScroll = () => {
        const press = activePress.current;
        if (press) dismissScrolledPress(press.x, press.y);
      };
      document.addEventListener("click", onDocClick);
      document.addEventListener("pointerdown", onPointerDown, true);
      document.addEventListener("pointermove", onPointerMove);
      document.addEventListener("touchstart", onTouchStart, true);
      document.addEventListener("touchmove", onTouchMove);
      const scrollRoot = scroller();
      scrollRoot?.addEventListener("scroll", onScroll, { passive: true });
      let removeKeys = () => {};
      if (!nativeFocusGroup) {
        const onFocusIn = (event: FocusEvent) => {
          const tabList = tabs();
          if (event.target instanceof HTMLButtonElement && tabList.includes(event.target)) {
            mark(tabList, event.target);
            return;
          }
          const row = event.target instanceof Element ? event.target.closest(".reading-actions-row") : null;
          if (!row || row.closest("[hidden]")) return;
          const controls = rowItems(row);
          if (!(event.target instanceof HTMLElement) || !controls.includes(event.target)) return;
          mark(controls, event.target);
        };
        const onFocusOut = (event: FocusEvent) => {
          const tabList = tabs();
          if (!(event.target instanceof HTMLButtonElement) || !tabList.includes(event.target)) return;
          if (event.relatedTarget instanceof HTMLButtonElement && tabList.includes(event.relatedTarget)) return;
          mark(
            tabList,
            tabList.find(tab => tab.getAttribute("aria-selected") === "true"),
          );
        };
        const onKeyDown = (event: KeyboardEvent) => {
          const move = (controls: HTMLElement[]) => {
            const index = controls.indexOf(document.activeElement as HTMLElement);
            if (index < 0) return false;
            const rtl = getComputedStyle(surface).direction === "rtl";
            const next = event.key === "Home" ? 0 : event.key === "End" ? controls.length - 1 : event.key === "ArrowRight" ? (index + (rtl ? -1 : 1) + controls.length) % controls.length : event.key === "ArrowLeft" ? (index + (rtl ? 1 : -1) + controls.length) % controls.length : -1;
            if (next < 0) return false;
            event.preventDefault();
            controls[next]?.focus();
            return true;
          };
          if (move(tabs())) return;
          const row = document.activeElement instanceof Element ? document.activeElement.closest(".reading-actions-row") : null;
          if (!row || row.closest("[hidden]")) return;
          move(rowItems(row));
        };
        surface.addEventListener("focusin", onFocusIn);
        surface.addEventListener("focusout", onFocusOut);
        surface.addEventListener("keydown", onKeyDown);
        removeKeys = () => {
          surface.removeEventListener("focusin", onFocusIn);
          surface.removeEventListener("focusout", onFocusOut);
          surface.removeEventListener("keydown", onKeyDown);
        };
      }
      teardown = () => {
        document.removeEventListener("click", onDocClick);
        document.removeEventListener("pointerdown", onPointerDown, true);
        document.removeEventListener("pointermove", onPointerMove);
        document.removeEventListener("touchstart", onTouchStart, true);
        document.removeEventListener("touchmove", onTouchMove);
        scrollRoot?.removeEventListener("scroll", onScroll);
        surface.removeEventListener("beforematch", onBeforeMatch);
        controlsObserver.disconnect();
        removeKeys();
      };
    });
    return () => {
      cancelAnimationFrame(frame);
      teardown();
    };
  }, []);

  function chooseReadingTab(tab: ReadingTab) {
    setChrome(current => selectChromeTab(current, tab));
  }

  function selectParagraph(selection: ParagraphSelection) {
    setChrome(current => clickParagraphChrome(current, selection));
  }

  function showReadingActions(event: MouseEvent<HTMLDivElement>) {
    if (event.defaultPrevented) return;
    const target = event.target;
    if (!(target instanceof Element) || target.closest("a, button") || window.getSelection()?.toString()) return;
    event.stopPropagation();
    setChrome(clickSurfaceChrome);
  }

  const modelError = mutation.error && !isAbortError(mutation.error) ? mutation.error.message || "操作失败，请稍后重试。" : undefined;
  const search = readerSearch(category, page);
  const originalTitle = data.originalTitle || item.title;
  const origTitleLang = data.originalTitle ? data.originalLang : item.titleLang;
  const atPageBottom = progress > 0 && progress >= 1 - Number.EPSILON;
  function scrollReading(to: "top" | "bottom") {
    const column = document.querySelector<HTMLElement>(".reader-scroll");
    if (!column) return;
    column.scrollTo(0, to === "top" ? 0 : column.scrollHeight);
  }
  return (
    <div className="reader-surface" {...gutter}>
      <title>{item.title}</title>
      {actions && chrome.open && (
        <div className="reading-top reading-actions-row" role="toolbar" aria-label="页面" ref={readingActionsRef}>
          <Link to="/read" search={search}>
            返回
          </Link>
          <button type="button" onClick={() => scrollReading(atPageBottom ? "top" : "bottom")}>
            {atPageBottom ? "滑到顶部" : "滑到底部"}
          </button>
        </div>
      )}
      <main className="reader-scroll" ref={setMain}>
        {syncError && <p role="status">阅读进度暂未同步，请检查网络后继续阅读。</p>}
        <div onClick={actions ? showReadingActions : undefined}>
          <article>
            <h1 lang={item.titleLang}>{item.title}</h1>
            <p className="article-byline">
              <span className="author-row">
                <span>{data.date || "—"}</span>
                {item.author && <span>{item.author}</span>}
              </span>
              {hasOriginal && (
                <span className="byline-actions">
                  <button
                    className="other-link"
                    type="button"
                    aria-controls="original-body"
                    aria-expanded={showOriginal}
                    onClick={() =>
                      setShowOriginal(value => {
                        const next = !value;
                        try {
                          localStorage.setItem(`read-view:${item.code}`, next ? "original" : "translation");
                        } catch {
                          /* Local storage can be disabled. */
                        }
                        return next;
                      })
                    }
                  >
                    {showOriginal ? "显示翻译" : "显示原文"}
                  </button>
                </span>
              )}
            </p>
            <ReadingBody id={hasOriginal ? "translated-body" : undefined} field={data.field} lang={data.lang} paragraphs={data.body} highlights={highlights} hidden={showOriginal} select={actions?.highlightsEnabled && signedIn ? selectParagraph : undefined} />
            {hasOriginal && <ReadingBody id="original-body" field="original" lang={data.originalLang} paragraphs={data.original} highlights={highlights} hidden={!showOriginal} select={actions?.highlightsEnabled && signedIn ? selectParagraph : undefined} />}
            <hr />
            <p className="detail-metadata">
              {(data.originalUrl || (data.originalTitle && data.originalTitle !== item.title)) && (
                <>
                  原文：
                  {data.originalUrl ? (
                    <a className="metadata-link" href={data.originalUrl} lang={origTitleLang}>
                      {originalTitle}
                    </a>
                  ) : (
                    <span lang={origTitleLang}>{originalTitle}</span>
                  )}
                  <br />
                </>
              )}
              {data.publisher && (
                <>
                  来源：{data.publisher}
                  <br />
                </>
              )}
              {data.chapter && (
                <>
                  章节：{data.chapter}
                  <br />
                </>
              )}
              日期：{data.date || "—"}
            </p>
            {data.terms.length > 0 && (
              <>
                <hr />
                <p>名词解释</p>
                <ReadingBody field="terms" paragraphs={data.terms} highlights={highlights} select={actions?.highlightsEnabled && signedIn ? selectParagraph : undefined} />
              </>
            )}
          </article>
          {actions && (
            <nav className="nav-row" aria-label="文章导航" ref={navRef}>
              {neighbors?.prevCode ? (
                <Link to="/r/$code" params={{ code: neighbors.prevCode }} search={search}>
                  上一篇
                </Link>
              ) : (
                <span className="is-disabled">上一篇</span>
              )}
              <Link to="/read" search={search}>
                返回
              </Link>
              {neighbors?.nextCode ? (
                <Link to="/r/$code" params={{ code: neighbors.nextCode }} search={search}>
                  下一篇
                </Link>
              ) : (
                <span className="is-disabled">下一篇</span>
              )}
            </nav>
          )}
        </div>
      </main>
      {actions &&
        chrome.open &&
        (signedIn ? (
          <div className="reading-actions">
            <div className="reading-tabs" role="tablist" aria-label="阅读操作">
              {(actions.highlightsEnabled
                ? ([
                    ["paragraph", "段落"],
                    ["article", "文章"],
                    ["share", "分享"],
                  ] as const)
                : ([
                    ["article", "文章"],
                    ["share", "分享"],
                  ] as const)
              ).map(([id, label]) => (
                <button key={id} type="button" id={`reading-tab-${id}`} role="tab" aria-selected={chrome.tab === id} onClick={() => chooseReadingTab(id)}>
                  {label}
                </button>
              ))}
            </div>
            <div className="reading-panels">
              {actions.highlightsEnabled && (
                <div role="tabpanel" id="reading-panel-paragraph" aria-labelledby="reading-tab-paragraph" hidden={chrome.tab !== "paragraph"} tabIndex={!chrome.selection && chrome.tab === "paragraph" ? 0 : undefined}>
                  {chrome.selection ? (
                    <ParagraphPanel
                      key={`${chrome.selection.field}:${chrome.selection.paragraph.start}:${chrome.selection.highlightId ?? ""}`}
                      selected={chrome.selection}
                      preview={selectionPreview(chrome.selection, highlights, chrome.selection.field === "original" ? data.original : chrome.selection.field === "terms" ? data.terms : data.body)}
                      showOriginalButton={hasOriginal && chrome.selection.field === "translation"}
                      pending={mutation.isPending}
                      act={paragraphAction}
                    />
                  ) : (
                    <p className="reading-paragraph-empty">单击正文段落后可在此操作。</p>
                  )}
                </div>
              )}
              <div role="tabpanel" id="reading-panel-article" aria-labelledby="reading-tab-article" hidden={readingTab !== "article"} ref={bindReadingPanel}>
                <div className="reading-actions-row" role="toolbar" aria-label="文章">
                  <button type="button" disabled={mutation.isPending || addedLater} onClick={() => run({ type: "add-later", data: {} })}>
                    {addedLater ? "已加入待读" : "待读"}
                  </button>
                  <button type="button" disabled={mutation.isPending} onClick={() => run({ type: "favorite", data: { favorite: actions.favorite ? "0" : "1" } })}>
                    {actions.favorite ? "取消收藏" : "收藏"}
                  </button>
                  <a href={actions.notionUrl}>管理</a>
                </div>
              </div>
              <div role="tabpanel" id="reading-panel-share" aria-labelledby="reading-tab-share" hidden={readingTab !== "share"} ref={bindReadingPanel}>
                <ShareLink code={item.code} />
              </div>
            </div>
          </div>
        ) : session.isSuccess ? (
          <div className="reading-actions" role="region" aria-label="登录">
            <div className="reading-actions-row">
              <span>请登录</span>
              <a href={`/auth?next=${encodeURIComponent(pathname + searchStr + hash)}`}>登录</a>
            </div>
          </div>
        ) : null)}
      {remoteProgress !== null && (
        <div className="progress-sync" role="region" aria-label="阅读进度同步">
          <span>远端已读至 {Math.round(remoteProgress * 100)}%</span>
          <div className="progress-sync-actions">
            <button type="button" onClick={syncToRemote}>
              同步
            </button>
            <button type="button" onClick={dismissRemote}>
              忽略
            </button>
          </div>
        </div>
      )}
      <div className="progress" aria-hidden="true">
        <span className="progress-bar" style={{ width: `${progress * 100}%` }} />
      </div>
      {pinPrompt && (
        <ReaderDialog id="favorite-dialog" label="收藏验证" dismiss={() => setPinPrompt(null)}>
          <PinForm pending={mutation.isPending} error={mutation.isError && mutation.error instanceof ReaderError && mutation.error.requiresPin ? (mutation.error.message === "请输入 6 位密码。" ? "" : mutation.error.message) : undefined} submit={pin => run(pinPrompt, pin)} cancel={() => setPinPrompt(null)} />
        </ReaderDialog>
      )}
      {failure && (
        <ReaderDialog id="highlight-error" label="操作失败" dismiss={() => setFailure(null)}>
          <p role="alert">{failure.message}</p>
          <div>
            <button type="button" onClick={() => setFailure(null)}>
              关闭
            </button>
            {failure.retry && (
              <button type="button" onClick={() => run(failure.retry!)}>
                重试
              </button>
            )}
          </div>
        </ReaderDialog>
      )}
      {resultPanel &&
        (resultPanel.type === "original" ? (
          <ReaderDialog id="original-match-dialog" label="原文匹配" dismiss={dismissResult}>
            <div id="original-match-content">
              <section>
                <h2>译文</h2>
                <p id="original-match-current">{resultPanel.quote}</p>
              </section>
              <section>
                <h2>原文</h2>
                <p id="original-match-text" role={modelError ? "alert" : "status"}>
                  {mutation.isPending ? "正在匹配原文…" : (modelError ?? mutation.data?.paragraph ?? "未找到匹配段落。")}
                </p>
              </section>
            </div>
            {!mutation.isPending && modelError && (
              <div className="dialog-actions">
                <button type="button" onClick={dismissResult}>
                  关闭
                </button>
                <button type="button" onClick={() => run(resultPanel)}>
                  重试
                </button>
              </div>
            )}
          </ReaderDialog>
        ) : (
          <ReaderDialog id="explanation-dialog" label="段落解释" dismiss={dismissResult}>
            <div id="explanation-text" aria-live="polite" role={modelError ? "alert" : undefined}>
              {mutation.isPending ? "正在解释…" : (modelError ?? (mutation.data?.markdown ? renderMarkdown(mutation.data.markdown) : mutation.data?.explanation))}
            </div>
            {!mutation.isPending && modelError && (
              <div className="dialog-actions">
                <button type="button" onClick={dismissResult}>
                  关闭
                </button>
                <button type="button" onClick={() => run(resultPanel)}>
                  重试
                </button>
              </div>
            )}
          </ReaderDialog>
        ))}
    </div>
  );
}

function PinForm({ pending, error, submit, cancel }: { pending: boolean; error?: string; submit: (pin: string) => void; cancel: () => void }) {
  // Remount when the error text changes so the field clears and autoFocus runs again.
  return <PinFields key={error ?? "ready"} pending={pending} error={error} submit={submit} cancel={cancel} />;
}

function PinFields({ pending, error, submit, cancel }: { pending: boolean; error?: string; submit: (pin: string) => void; cancel: () => void }) {
  const [pin, setPin] = useState("");
  return (
    <>
      <form
        onSubmit={event => {
          event.preventDefault();
          if (!pending && /^[0-9]{6}$/.test(pin)) submit(pin);
        }}
      >
        <p>
          <label htmlFor="pin">请输入 6 位密码</label>
        </p>
        <div className="pin-wrap pin-enhanced">
          <input
            id="pin"
            name="pin"
            type="password"
            autoFocus
            inputMode="numeric"
            autoComplete="current-password"
            maxLength={6}
            value={pin}
            disabled={pending}
            onChange={event => {
              const value = event.currentTarget.value.replace(/\D/g, "");
              setPin(value);
              if (value.length === 6) submit(value);
            }}
          />
          <div className="pin-slots" aria-hidden="true">
            {Array.from({ length: 6 }, (_, index) => (
              <span key={index} className={index < pin.length ? "filled" : index === pin.length ? "active" : undefined} />
            ))}
          </div>
        </div>
        <p id="favorite-error" role="alert">
          {error}
        </p>
        {pending && <p role="status">正在验证…</p>}
      </form>
      <button type="button" className="favorite-close" onClick={cancel}>
        取消
      </button>
    </>
  );
}

function ShareLink({ code }: { code: string }) {
  const [status, setStatus] = useState("");
  const clearStatus = useRef<number | null>(null);
  const previousStatus = useRef("");
  const url = new URL(`/s/${code}`, location.origin).href;
  async function copy() {
    let copied = false;
    try {
      await navigator.clipboard.writeText(url);
      copied = true;
    } catch {
      const field = document.createElement("textarea");
      field.value = url;
      field.readOnly = true;
      field.style.cssText = "position:fixed;inset-block-start:0;opacity:0";
      document.body.appendChild(field);
      field.select();
      try {
        copied = document.execCommand("copy");
      } catch {
        copied = false;
      } finally {
        field.remove();
      }
    }
    const message = copied ? "已复制" : "复制失败";
    // VoiceOver skips a repeated live-region string, so a repeat differs by an unpronounced space.
    const announced = previousStatus.current === message ? `${message}\u00A0` : message;
    previousStatus.current = announced;
    if (clearStatus.current !== null) window.clearTimeout(clearStatus.current);
    setStatus(announced);
    clearStatus.current = window.setTimeout(() => setStatus(""), 2000);
  }
  return (
    <div className="reading-share">
      <input readOnly value={url} aria-label="分享链接" onFocus={event => event.currentTarget.select()} />
      <button type="button" onClick={() => void copy()}>
        {status.replace("\u00A0", "") || "复制"}
      </button>
      <span className="visually-hidden" role="status">
        {status}
      </span>
    </div>
  );
}
