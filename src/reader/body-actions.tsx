import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type TouchEvent } from "react";
import type { ParagraphSelection } from "./body.tsx";
import { tokenRanges, tokenize, type TokenRange } from "./tokenize.ts";

const HOLD_MS = 500;
const RELEASE_GUARD_MS = 400;

export function ParagraphPanel({ selected, preview, showOriginalButton, pending, act }: { selected: ParagraphSelection; preview: string; showOriginalButton: boolean; pending: boolean; act: (type: "highlight" | "delete" | "explain" | "original", ranges?: TokenRange[]) => void }) {
  const [tokenMode, setTokenMode] = useState(false);
  const [chosen, setChosen] = useState<Set<number>>(() => new Set());
  const releaseGuard = useRef(0);
  const timer = useRef<number | null>(null);
  const press = useRef<{ x: number; y: number; scroll: number } | null>(null);
  const stopLift = useRef<(() => void) | null>(null);
  const lastTouch = useRef(-Infinity);
  const releaseOnUnmount = useRef((node: HTMLSpanElement | null) => {
    if (node) return;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    press.current = null;
    stopLift.current?.();
  }).current;
  const tokens = useMemo(() => tokenize(selected.paragraph.quote, selected.paragraph.start), [selected.paragraph.quote, selected.paragraph.start]);
  const marking = selected.highlightId !== null;

  function scrollOffset() {
    return document.getElementById("body-preview-scroll")?.scrollTop ?? 0;
  }

  function clearPress() {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    press.current = null;
  }

  function enterTokenMode() {
    timer.current = null;
    press.current = null;
    window.getSelection()?.removeAllRanges();
    releaseGuard.current = Infinity;
    const finishLift = () => {
      releaseGuard.current = performance.now() + RELEASE_GUARD_MS;
      stopLift.current?.();
    };
    const listen = (type: string) => document.addEventListener(type, finishLift, true);
    stopLift.current = () => {
      for (const type of ["pointerup", "pointercancel", "touchend", "mouseup"]) document.removeEventListener(type, finishLift, true);
      stopLift.current = null;
    };
    listen("pointerup");
    listen("pointercancel");
    listen("touchend");
    listen("mouseup");
    setChosen(new Set());
    setTokenMode(true);
  }

  function arm(x: number, y: number) {
    if (tokenMode || marking) return;
    clearPress();
    press.current = { x, y, scroll: scrollOffset() };
    timer.current = window.setTimeout(enterTokenMode, HOLD_MS);
  }

  function moved(x: number, y: number) {
    const start = press.current;
    if (start && (Math.abs(start.x - x) > 10 || Math.abs(start.y - y) > 10 || Math.abs(start.scroll - scrollOffset()) > 5)) clearPress();
  }

  function pointerDown(event: ReactPointerEvent<HTMLParagraphElement>) {
    if (!event.isPrimary || event.button !== 0) return;
    arm(event.clientX, event.clientY);
  }

  function touchStart(event: TouchEvent<HTMLParagraphElement>) {
    if (window.PointerEvent) return;
    lastTouch.current = performance.now();
    if (event.touches.length !== 1) return clearPress();
    const touch = event.touches[0]!;
    arm(touch.clientX, touch.clientY);
  }

  let tokenIndex = 0;
  const empty = chosen.size === 0;
  return (
    <div id="body-actions" data-mode={marking ? "mark" : tokenMode ? "token" : "body"}>
      <span ref={releaseOnUnmount} hidden />
      <div id="body-preview-scroll" onScroll={() => moved(press.current?.x ?? 0, press.current?.y ?? 0)}>
        <p
          id="body-preview"
          role={tokenMode ? "group" : undefined}
          aria-label={tokenMode ? "选择文字" : undefined}
          onContextMenu={event => event.preventDefault()}
          onPointerDown={pointerDown}
          onPointerMove={event => moved(event.clientX, event.clientY)}
          onPointerUp={clearPress}
          onPointerCancel={clearPress}
          onTouchStart={touchStart}
          onTouchMove={event => {
            if (window.PointerEvent) return;
            if (event.touches.length !== 1) return clearPress();
            const touch = event.touches[0]!;
            moved(touch.clientX, touch.clientY);
          }}
          onTouchEnd={() => {
            if (window.PointerEvent) return;
            lastTouch.current = performance.now();
            clearPress();
          }}
          onTouchCancel={clearPress}
          onMouseDown={event => {
            if (window.PointerEvent || performance.now() - lastTouch.current < 1000) return;
            if (event.button !== 0) return clearPress();
            arm(event.clientX, event.clientY);
          }}
          onMouseMove={event => {
            if (!window.PointerEvent) moved(event.clientX, event.clientY);
          }}
          onMouseUp={() => {
            if (!window.PointerEvent) clearPress();
          }}
        >
          {tokenMode
            ? tokens.map((token, index) => {
                if (token.kind === "space") return token.text.includes("\n") ? <span key={index} className="token-break" /> : null;
                if (token.kind === "mark")
                  return (
                    <span key={index} className="token-mark">
                      {token.text}
                    </span>
                  );
                const ordinal = tokenIndex++;
                return (
                  <button
                    key={index}
                    type="button"
                    className={token.text.length > 24 ? "token token-long" : "token"}
                    aria-pressed={chosen.has(ordinal)}
                    onClick={() => {
                      if (performance.now() < releaseGuard.current) return;
                      setChosen(current => {
                        const next = new Set(current);
                        if (next.has(ordinal)) next.delete(ordinal);
                        else next.add(ordinal);
                        return next;
                      });
                    }}
                  >
                    {token.text}
                  </button>
                );
              })
            : preview}
        </p>
      </div>
      <div id="body-actions-buttons" className="reading-actions-row" role="toolbar" aria-label="段落">
        {marking ? (
          <>
            <button
              id="body-explain"
              type="button"
              aria-disabled={pending || undefined}
              onClick={() => {
                if (pending) return;
                act("explain");
              }}
            >
              解释
            </button>
            <button
              id="body-unhighlight"
              type="button"
              aria-disabled={pending || undefined}
              onClick={() => {
                if (pending) return;
                act("delete");
              }}
            >
              取消划线
            </button>
          </>
        ) : tokenMode ? (
          <>
            <button
              id="body-back"
              type="button"
              onClick={() => {
                setTokenMode(false);
                setChosen(new Set());
              }}
            >
              返回
            </button>
            <button
              id="body-explain"
              type="button"
              aria-disabled={pending || empty || undefined}
              onClick={() => {
                if (pending || empty) return;
                act("explain", tokenRanges(selected.paragraph.quote, tokens, chosen));
              }}
            >
              解释
            </button>
            <button
              id="body-highlight"
              type="button"
              aria-disabled={pending || empty || undefined}
              onClick={() => {
                if (pending || empty) return;
                act("highlight", tokenRanges(selected.paragraph.quote, tokens, chosen));
              }}
            >
              划线
            </button>
          </>
        ) : (
          <>
            {showOriginalButton && (
              <button
                id="body-toggle"
                type="button"
                aria-disabled={pending || undefined}
                onClick={() => {
                  if (pending) return;
                  act("original");
                }}
              >
                显示原文
              </button>
            )}
            <button
              id="body-explain"
              type="button"
              aria-disabled={pending || undefined}
              onClick={() => {
                if (pending) return;
                act("explain");
              }}
            >
              解释
            </button>
            <button
              id="body-highlight"
              type="button"
              aria-disabled={pending || undefined}
              onClick={() => {
                if (pending) return;
                act("highlight");
              }}
            >
              划线
            </button>
          </>
        )}
      </div>
    </div>
  );
}
