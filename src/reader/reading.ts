import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

export function useReaderScroll(code?: string, enabled = true, hasAnchor = false) {
  const main = useRef<HTMLElement | null>(null);
  const [progress, setProgress] = useState(0);

  const mainRef = useCallback((element: HTMLElement | null) => {
    main.current = element;
    if (!element || !enabled) return;

    const column = element;
    const key = code ? `eink-progress:${code}` : null;
    const maxScroll = () => Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const ratio = () => maxScroll() > 0 ? Math.min(1, Math.max(0, window.scrollY / maxScroll())) : 1;
    if (key && !hasAnchor) {
      try {
        const value = localStorage.getItem(key);
        if (value !== null && /^\d/.test(value) && Number(value) >= 0 && Number(value) <= 1) {
          window.scrollTo(0, Number(value) * maxScroll());
        }
      } catch { /* Storage can be disabled. */ }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    function save() {
      if (key) {
        try { localStorage.setItem(key, String(ratio())); } catch { /* Storage can be disabled. */ }
      }
    }
    function update() {
      setProgress(ratio());
    }
    function onScroll() {
      update();
      if (key && timer === undefined) {
        timer = setTimeout(() => { timer = undefined; save(); }, 400);
      }
    }
    const resize = new ResizeObserver(update);
    resize.observe(column);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", update);
    window.addEventListener("pagehide", save);
    update();
    return () => {
      if (main.current === column) main.current = null;
      resize.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", update);
      window.removeEventListener("pagehide", save);
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
    progress, mainRef,
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
