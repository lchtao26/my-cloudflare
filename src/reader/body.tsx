import { Fragment, createElement, useCallback, useRef, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type TouchEvent } from "react";
import type { MarkdownNode } from "./explanation-markdown.ts";
import type { ReaderField, ReaderParagraph, ResolvedHighlight } from "./data.ts";

export type ParagraphSelection = {
  field: ReaderField;
  paragraph: ReaderParagraph;
  highlightId: string | null;
};

const HOLD_MS = 500;

type TapEvent = Pick<MouseEvent, "target" | "clientX" | "clientY"> & Partial<Pick<MouseEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">>;

function lines(text: string): ReactNode {
  return text.split("\n").map((line, index) => (
    <Fragment key={index}>
      {index > 0 && <br />}
      {line}
    </Fragment>
  ));
}

function markedText(text: string, offset: number, highlights: ResolvedHighlight[], anchors: Set<string>) {
  if (!highlights.length) return lines(text);
  const characters = [...text.matchAll(/\S/g)].map(match => match.index);
  const spans = highlights.flatMap(highlight => {
    const start = Math.max(0, highlight.start - offset);
    const end = Math.min(characters.length, highlight.end - offset);
    return start < end
      ? [
          {
            id: highlight.id,
            start: characters[start]!,
            end: characters[end - 1]! + 1,
          },
        ]
      : [];
  });
  if (!spans.length) return lines(text);
  const edges = [...new Set([0, text.length, ...spans.flatMap(span => [span.start, span.end])])].sort((a, b) => a - b);

  return edges.slice(0, -1).map((start, index) => {
    const end = edges[index + 1]!;
    const active = spans.filter(span => span.start <= start && end <= span.end);
    const newAnchors = active.filter(span => !anchors.has(span.id));
    for (const span of newAnchors) anchors.add(span.id);
    const content = active.reduceRight<ReactNode>(
      (child, span) => (
        <mark className="hl" data-hl={span.id}>
          {child}
        </mark>
      ),
      lines(text.slice(start, end)),
    );
    return (
      <Fragment key={start}>
        {newAnchors.map(span => (
          <span key={span.id} id={`hl-${span.id}`} />
        ))}
        {content}
      </Fragment>
    );
  });
}

export function ReadingBody({ id, field, lang, paragraphs, highlights, hidden, select }: { id?: string; field: ReaderField; lang?: string; paragraphs: ReaderParagraph[]; highlights: ResolvedHighlight[]; hidden?: boolean; select?: (selection: ParagraphSelection) => void }) {
  const stopHold = useRef<() => void>(() => {});
  const armed = useRef(false);
  const swallowClick = useRef(false);
  const lastTouch = useRef(-Infinity);
  const anchors = new Set<string>();
  const marks = highlights.filter(mark => mark.field === field);

  function targetParagraph(event: TapEvent) {
    if (!(event.target instanceof Element) || event.target.closest("a,button,img")) return null;
    const value = event.target.closest("[data-paragraph]")?.getAttribute("data-paragraph");
    return value == null ? null : Number(value);
  }

  function beginHold(event: TapEvent, kind: "pointer" | "touch" | "mouse") {
    stopHold.current();
    swallowClick.current = false;
    const paragraph = targetParagraph(event);
    if (!select || paragraph === null || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || window.getSelection()?.toString()) return;
    const highlightId = event.target instanceof Element ? (event.target.closest("mark[data-hl]")?.getAttribute("data-hl") ?? null) : null;
    const origin = { x: event.clientX, y: event.clientY, scroll: window.scrollY };
    let held = false;
    let timer: number | null = window.setTimeout(() => {
      timer = null;
      held = true;
    }, HOLD_MS);
    const moved = (x: number, y: number) => Math.abs(origin.x - x) > 10 || Math.abs(origin.y - y) > 10 || Math.abs(origin.scroll - window.scrollY) > 5;
    const detach = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      armed.current = false;
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onRelease, true);
      document.removeEventListener("pointercancel", onCancel, true);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onRelease, true);
      document.removeEventListener("touchcancel", onCancel, true);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onRelease, true);
      stopHold.current = () => {};
    };
    const onPointerMove = (move: PointerEvent) => {
      if (!moved(move.clientX, move.clientY)) return;
      swallowClick.current = true;
      detach();
    };
    const onTouchMove = (move: globalThis.TouchEvent) => {
      const touch = move.touches[0];
      if (!touch || !moved(touch.clientX, touch.clientY)) return;
      swallowClick.current = true;
      detach();
    };
    const onMouseMove = (move: globalThis.MouseEvent) => {
      if (!moved(move.clientX, move.clientY)) return;
      swallowClick.current = true;
      detach();
    };
    const onCancel = () => {
      swallowClick.current = true;
      detach();
    };
    // Open from the release click, after that click is stopped, so it cannot dismiss the new dialog.
    const onRelease = () => {
      const finished = held;
      detach();
      if (!finished || !select) return;
      swallowClick.current = true;
      let opened = false;
      let fallback = 0;
      const open = () => {
        if (opened) return;
        opened = true;
        window.clearTimeout(fallback);
        document.removeEventListener("click", absorb, true);
        window.getSelection()?.removeAllRanges();
        select({ field, paragraph: paragraphs[paragraph]!, highlightId });
      };
      const absorb = (click: Event) => {
        click.preventDefault();
        click.stopPropagation();
        open();
      };
      document.addEventListener("click", absorb, true);
      fallback = window.setTimeout(open, 400);
    };
    armed.current = true;
    stopHold.current = detach;
    if (kind === "pointer") {
      document.addEventListener("pointermove", onPointerMove);
      document.addEventListener("pointerup", onRelease, true);
      document.addEventListener("pointercancel", onCancel, true);
    } else if (kind === "touch") {
      document.addEventListener("touchmove", onTouchMove);
      document.addEventListener("touchend", onRelease, true);
      document.addEventListener("touchcancel", onCancel, true);
    } else {
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onRelease, true);
    }
  }

  function onClick(event: MouseEvent<HTMLDivElement>) {
    if (!swallowClick.current) return;
    swallowClick.current = false;
    event.preventDefault();
    event.stopPropagation();
  }

  function onContextMenu(event: MouseEvent<HTMLDivElement>) {
    if (!armed.current) return;
    event.preventDefault();
  }

  const bindBody = useCallback((node: HTMLDivElement | null) => {
    if (!node) stopHold.current();
  }, []);

  return (
    <div
      id={id}
      className="excerpt-body"
      data-field={field}
      data-paragraph-actions={select ? "" : undefined}
      lang={lang}
      hidden={hidden}
      ref={bindBody}
      onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
        if (!event.isPrimary || event.button !== 0) {
          stopHold.current();
          return;
        }
        beginHold(event, "pointer");
      }}
      // Older Android WebViews send Touch/Mouse events without Pointer Events.
      onTouchStart={(event: TouchEvent<HTMLDivElement>) => {
        if (window.PointerEvent) return;
        lastTouch.current = performance.now();
        if (event.touches.length !== 1) return stopHold.current();
        const touch = event.touches[0]!;
        beginHold({ target: event.target, clientX: touch.clientX, clientY: touch.clientY }, "touch");
      }}
      onTouchEnd={() => {
        if (window.PointerEvent) return;
        lastTouch.current = performance.now();
      }}
      onMouseDown={(event: MouseEvent<HTMLDivElement>) => {
        if (window.PointerEvent || performance.now() - lastTouch.current < 1000) return;
        if (event.button !== 0) return stopHold.current();
        beginHold(event, "mouse");
      }}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      {paragraphs.map((paragraph, index) => {
        let offset = paragraph.start;
        const relevant = marks.filter(mark => mark.start < paragraph.end && mark.end > paragraph.start);
        function render(nodes: MarkdownNode[]): ReactNode[] {
          return nodes.map((node, index) => {
            if (node.type === "text") {
              const content = markedText(node.text, offset, relevant, anchors);
              offset += node.text.replace(/\s/g, "").length;
              return <Fragment key={index}>{content}</Fragment>;
            }
            return createElement(node.tag, { key: index, href: node.href, src: node.src, alt: node.alt, start: node.start }, node.tag === "img" || node.tag === "br" || node.tag === "hr" ? undefined : render(node.children));
          });
        }
        return (
          <div key={index} data-paragraph={index}>
            {paragraph.parts.map((part, partIndex) => {
              if ("image" in part) return <img key={partIndex} src={part.image} alt="正文图片" />;
              if (part.markdown) return <Fragment key={partIndex}>{render(part.markdown)}</Fragment>;
              const content = markedText(part.text, offset, relevant, anchors);
              offset += part.text.replace(/\s/g, "").length;
              return <Fragment key={partIndex}>{content}</Fragment>;
            })}
          </div>
        );
      })}
    </div>
  );
}
