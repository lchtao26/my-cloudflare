import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

export function useReaderScroll(code?: string, enabled = true, hasAnchor = false) {
  const main = useRef<HTMLElement | null>(null);
  const [progress, setProgress] = useState(0);
  const [syncError, setSyncError] = useState(false);

  const mainRef = useCallback((element: HTMLElement | null) => {
    main.current = element;
    if (!element || !enabled) return;

    const column = element;
    const key = code ? `eink-progress:${code}` : null;
    const maxScroll = () => Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const ratio = () => maxScroll() > 0 ? Math.min(1, Math.max(0, window.scrollY / maxScroll())) : 1;
    let ready = false, disposed = false, moved = false, loading = false, dirty = false;
    let restoredY: number | null = null;
    let pending = Promise.resolve();
    const progressUrl = code ? `/api/progress/${encodeURIComponent(code)}` : "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    function save(force = false) {
      if (key && (dirty || force)) {
        try { localStorage.setItem(key, String(ratio())); } catch { /* Storage can be disabled. */ }
        if (!ready) { load(); return; }
        const value = ratio();
        dirty = false;
        pending = pending.catch(() => {}).then(async () => {
          const response = await fetch(progressUrl, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ progress: value }), keepalive: true });
          if (!response.ok) throw new Error("无法保存阅读进度");
          if (!disposed) setSyncError(false);
        }).catch(() => { dirty = true; if (!disposed) setSyncError(true); });
      }
    }
    function load() {
      if (!key || loading || disposed) return;
      loading = true;
      void fetch(progressUrl, { credentials: "same-origin", cache: "no-store" }).then(async response => {
        if (!response.ok) throw new Error("无法读取阅读进度");
        const result = await response.json() as { progress: number | null };
        if (disposed) return;
        let value = result.progress;
        if (value === null) {
          try { const local = localStorage.getItem(key); if (local !== null && /^\d/.test(local)) value = Number(local); } catch { /* Storage can be disabled. */ }
        }
        if (!moved && !hasAnchor && value !== null && value >= 0 && value <= 1) {
          restoredY = value * maxScroll();
          window.scrollTo(0, restoredY);
        }
        ready = true;
        setSyncError(false);
        if (moved || (result.progress === null && value !== null)) save(true);
      }).catch(() => { if (!disposed) setSyncError(true); }).finally(() => { loading = false; });
    }
    if (key) load();
    function update() {
      setProgress(ratio());
    }
    function onScroll() {
      if (restoredY !== null && Math.abs(window.scrollY - restoredY) < 2) { restoredY = null; update(); return; }
      restoredY = null;
      dirty = true;
      if (!ready && key) moved = true;
      update();
      if (key && timer === undefined) {
        timer = setTimeout(() => { timer = undefined; save(); }, 1500);
      }
    }
    const resize = new ResizeObserver(update);
    resize.observe(column);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", update);
    const onPageHide = () => save();
    window.addEventListener("pagehide", onPageHide);
    update();
    return () => {
      if (key && ready) save();
      disposed = true;
      if (main.current === column) main.current = null;
      resize.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", update);
      window.removeEventListener("pagehide", onPageHide);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [code, enabled, hasAnchor]);

  const tap = useRef<{ x: number; y: number; time: number; scroll: number } | null>(null);
  function gutterDirection(event: ReactPointerEvent) {
    if (event.target !== event.currentTarget || event.pointerType === "mouse" || !main.current) return 0;
    if (document.querySelector("dialog[open]") || window.getSelection()?.toString()) return 0;
    const bounds = main.current.getBoundingClientRect();
    return event.clientX < bounds.left ? -1 : event.clientX > bounds.right ? 1 : 0;
  }
  return {
    progress, syncError, mainRef,
    gutter: {
      onPointerDown(event: ReactPointerEvent) {
        tap.current = event.isPrimary && gutterDirection(event)
          ? { x: event.clientX, y: event.clientY, time: performance.now(), scroll: window.scrollY }
          : null;
      },
      onPointerCancel() { tap.current = null; },
      onPointerUp(event: ReactPointerEvent) {
        const start = tap.current;
        tap.current = null;
        if (!start || Math.abs(start.x - event.clientX) > 15 || Math.abs(start.y - event.clientY) > 15
          || performance.now() - start.time > 700 || Math.abs(window.scrollY - start.scroll) > 5) return;
        const direction = gutterDirection(event);
        if (direction) window.scrollBy(0, direction * Math.max(80, window.innerHeight));
      },
    },
  };
}
