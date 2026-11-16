import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

const REFRESH_DISTANCE = 80;

export function usePullToRefresh(surface: RefObject<HTMLElement | null>, reload: () => Promise<void>) {
  const [position, setPosition] = useState<number | "refreshing">(0);
  const inFlight = useRef(false);
  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPosition("refreshing");
    try {
      await reload();
    } finally {
      inFlight.current = false;
      setPosition(0);
    }
  }, [reload]);

  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    let pull: { id: number; x: number; y: number; distance: number; dragging: boolean } | null = null;

    function cancel() {
      if (pull?.dragging && !inFlight.current) setPosition(0);
      pull = null;
    }

    function start(event: TouchEvent) {
      cancel();
      if (inFlight.current || window.scrollY > 0 || event.touches.length !== 1
        || (window.visualViewport?.scale ?? 1) > 1
        || (event.target instanceof Element && event.target.closest("nav,button,input"))) return;
      const touch = event.touches[0]!;
      pull = { id: touch.identifier, x: touch.clientX, y: touch.clientY, distance: 0, dragging: false };
    }

    function move(event: TouchEvent) {
      if (!pull) return;
      const touch = event.touches[0];
      if (inFlight.current || event.touches.length !== 1 || touch?.identifier !== pull.id || window.scrollY > 0) {
        cancel();
        return;
      }
      const dx = Math.abs(touch.clientX - pull.x);
      const dy = touch.clientY - pull.y;
      if (!pull.dragging) {
        if (Math.max(dx, Math.abs(dy)) < 4) return;
        if (dy <= dx) {
          cancel();
          return;
        }
        pull.dragging = true;
      }
      if (event.cancelable) event.preventDefault();
      pull.distance = Math.max(0, dy);
      setPosition(pull.distance);
    }

    function end(event: TouchEvent) {
      const finished = pull;
      pull = null;
      if (!finished?.dragging) return;
      if (event.cancelable) event.preventDefault();
      if (event.touches.length === 0 && finished.distance >= REFRESH_DISTANCE) void refresh();
      else setPosition(0);
    }

    element.addEventListener("touchstart", start, { passive: true });
    element.addEventListener("touchmove", move, { passive: false });
    element.addEventListener("touchend", end, { passive: false });
    element.addEventListener("touchcancel", cancel);
    return () => {
      element.removeEventListener("touchstart", start);
      element.removeEventListener("touchmove", move);
      element.removeEventListener("touchend", end);
      element.removeEventListener("touchcancel", cancel);
    };
  }, [surface, refresh]);

  const refreshing = position === "refreshing";
  return {
    indicatorHeight: refreshing ? 44 : Math.min(64, position * 0.55),
    label: refreshing ? "正在刷新…" : position >= REFRESH_DISTANCE ? "松手刷新" : position > 0 ? "下拉刷新" : "",
    refreshing,
    refresh,
  };
}
