import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useEffect } from "./external-effect.ts";

export function shouldOfferRemoteSync(current: number, remote: number | null, maxScrollPx: number): boolean {
  return remote !== null && remote - current >= 0.02 && (remote - current) * maxScrollPx >= 40;
}

export function useReaderScroll(code?: string, enabled = true, hasAnchor = false, authorized = false) {
  const main = useRef<HTMLElement | null>(null);
  const [progress, setProgress] = useState(0);
  const [syncError, setSyncError] = useState(false);
  const [remoteProgress, setRemoteProgress] = useState<number | null>(null);
  const syncToRemoteRef = useRef<() => void>(() => {});
  const dismissRemoteRef = useRef<() => void>(() => {});
  const loadRef = useRef<() => void>(() => {});
  const authorizedRef = useRef(authorized);
  authorizedRef.current = authorized;
  useEffect(() => {
    if (authorized) loadRef.current();
  }, [authorized, code]);

  const mainRef = useCallback(
    (element: HTMLElement | null) => {
      main.current = element;
      if (!element || !enabled) return;

      const column = element;
      const key = code ? `eink-progress:${code}` : null;
      const maxScroll = () => Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      const ratio = () => (maxScroll() > 0 ? Math.min(1, Math.max(0, window.scrollY / maxScroll())) : 1);
      let disposed = false,
        ready = false,
        loading = false,
        moved = false;
      let restoredY: number | null = null;
      let furthestRemote: number | null = null;
      let fetchedRemote: number | null = null;
      let dismissedRemote: number | null = null;
      let offered: number | null = null;
      let pending = Promise.resolve();
      const progressUrl = code ? `/api/progress/${encodeURIComponent(code)}` : "";
      let timer: ReturnType<typeof setTimeout> | undefined;

      function readLocal(): number | null {
        if (!key) return null;
        try {
          const local = localStorage.getItem(key);
          if (local !== null && /^\d/.test(local)) {
            const value = Number(local);
            if (Number.isFinite(value) && value >= 0 && value <= 1) return value;
          }
        } catch {
          /* Storage can be disabled. */
        }
        return null;
      }
      function writeLocal(value?: number) {
        if (!key || maxScroll() <= 0) return;
        try {
          localStorage.setItem(key, String(value ?? ratio()));
        } catch {
          /* Storage can be disabled. */
        }
      }
      function position(): number | null {
        return maxScroll() > 0 ? ratio() : readLocal();
      }
      function showOffer(current: number) {
        if (!key || hasAnchor || fetchedRemote === null || (dismissedRemote !== null && fetchedRemote <= dismissedRemote)) {
          offered = null;
          setRemoteProgress(null);
          return;
        }
        offered = shouldOfferRemoteSync(current, fetchedRemote, maxScroll()) ? fetchedRemote : null;
        setRemoteProgress(offered);
      }
      function post(value: number) {
        if (!authorizedRef.current || !key || !ready || !(furthestRemote === null ? value > 0 : value > furthestRemote)) return;
        pending = pending
          .catch(() => {})
          .then(async () => {
            if (!(furthestRemote === null ? value > 0 : value > furthestRemote)) return;
            const response = await fetch(progressUrl, {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ progress: value }),
              keepalive: true,
            });
            if (response.status === 401) return;
            if (!response.ok) throw new Error("无法保存阅读进度");
            if (furthestRemote === null || value > furthestRemote) furthestRemote = value;
            if (!disposed) setSyncError(false);
          })
          .catch(() => {
            if (!disposed) setSyncError(true);
          });
      }
      function postIfAhead() {
        const value = position();
        if (value !== null) post(value);
      }
      function flush() {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        writeLocal();
        if (ready) postIfAhead();
      }
      function load() {
        if (!authorizedRef.current || !key || loading || disposed) return;
        loading = true;
        void fetch(progressUrl, { credentials: "same-origin", cache: "no-store" })
          .then(async response => {
            if (response.status === 401) return;
            if (!response.ok) throw new Error("无法读取阅读进度");
            const result = (await response.json()) as { progress: number | null };
            if (disposed) return;
            const remote = typeof result.progress === "number" && Number.isFinite(result.progress) && result.progress >= 0 && result.progress <= 1 ? result.progress : null;
            if (remote !== null && (fetchedRemote === null || remote > fetchedRemote)) {
              if (fetchedRemote !== null) dismissedRemote = null;
              fetchedRemote = remote;
            }
            if (remote !== null && (furthestRemote === null || remote > furthestRemote)) furthestRemote = remote;
            ready = true;
            if (!disposed) setSyncError(false);
            const current = position() ?? 0;
            showOffer(maxScroll() > 0 ? ratio() : current);
            if (remote === null ? current > 0 : current > remote) post(current);
          })
          .catch(() => {
            if (!disposed) setSyncError(true);
          })
          .finally(() => {
            loading = false;
          });
      }
      function restore() {
        if (!key || hasAnchor || moved) return;
        const local = readLocal();
        if (local === null || maxScroll() <= 0) return;
        const y = local * maxScroll();
        if (Math.abs(window.scrollY - y) < 2) {
          restoredY = null;
          return;
        }
        restoredY = y;
        window.scrollTo(0, y);
      }

      function update() {
        setProgress(ratio());
      }
      function onScroll() {
        if (restoredY !== null && Math.abs(window.scrollY - restoredY) < 2) {
          restoredY = null;
          update();
          return;
        }
        restoredY = null;
        moved = true;
        writeLocal();
        update();
        if (offered !== null && !shouldOfferRemoteSync(ratio(), offered, maxScroll())) {
          offered = null;
          setRemoteProgress(null);
        }
        if (!ready || timer !== undefined || maxScroll() <= 0) return;
        const value = ratio();
        if (!(furthestRemote === null ? value > 0 : value > furthestRemote)) return;
        timer = setTimeout(() => {
          timer = undefined;
          postIfAhead();
        }, 1500);
      }
      function onResize() {
        restore();
        update();
      }
      function onVisibility() {
        if (document.visibilityState === "hidden") flush();
        else if (document.visibilityState === "visible") load();
      }
      syncToRemoteRef.current = () => {
        if (offered === null) return;
        const y = offered * maxScroll();
        restoredY = y;
        moved = true;
        window.scrollTo(0, y);
        writeLocal(ratio());
        setProgress(ratio());
        offered = null;
        setRemoteProgress(null);
      };
      dismissRemoteRef.current = () => {
        dismissedRemote = fetchedRemote;
        offered = null;
        setRemoteProgress(null);
      };
      const resize = new ResizeObserver(onResize);
      window.addEventListener("scroll", onScroll, { passive: true });
      window.addEventListener("resize", onResize);
      const onPageHide = () => flush();
      window.addEventListener("pagehide", onPageHide);
      document.addEventListener("visibilitychange", onVisibility);
      resize.observe(column);
      restore();
      update();
      loadRef.current = load;
      if (key) load();
      return () => {
        loadRef.current = () => {};
        flush();
        disposed = true;
        syncToRemoteRef.current = () => {};
        dismissRemoteRef.current = () => {};
        if (main.current === column) main.current = null;
        resize.disconnect();
        window.removeEventListener("scroll", onScroll);
        window.removeEventListener("resize", onResize);
        window.removeEventListener("pagehide", onPageHide);
        document.removeEventListener("visibilitychange", onVisibility);
        if (timer !== undefined) clearTimeout(timer);
      };
    },
    [code, enabled, hasAnchor],
  );

  const tap = useRef<{ x: number; y: number; time: number; scroll: number } | null>(null);
  function gutterDirection(event: ReactPointerEvent) {
    if (event.target !== event.currentTarget || event.pointerType === "mouse" || !main.current) return 0;
    if (document.querySelector("dialog[open]") || window.getSelection()?.toString()) return 0;
    const bounds = main.current.getBoundingClientRect();
    return event.clientX < bounds.left ? -1 : event.clientX > bounds.right ? 1 : 0;
  }
  return {
    progress,
    syncError,
    remoteProgress,
    mainRef,
    syncToRemote: () => syncToRemoteRef.current(),
    dismissRemote: () => dismissRemoteRef.current(),
    gutter: {
      onPointerDown(event: ReactPointerEvent) {
        tap.current = event.isPrimary && gutterDirection(event) ? { x: event.clientX, y: event.clientY, time: performance.now(), scroll: window.scrollY } : null;
      },
      onPointerCancel() {
        tap.current = null;
      },
      onPointerUp(event: ReactPointerEvent) {
        const start = tap.current;
        tap.current = null;
        if (!start || Math.abs(start.x - event.clientX) > 15 || Math.abs(start.y - event.clientY) > 15 || performance.now() - start.time > 700 || Math.abs(window.scrollY - start.scroll) > 5) return;
        const direction = gutterDirection(event);
        if (direction) window.scrollBy(0, direction * Math.max(80, window.innerHeight));
      },
    },
  };
}
