import { Fragment, createElement, useRef, type MouseEvent, type ReactNode } from "react";
import type { MarkdownNode } from "./explanation-markdown.ts";
import type { ReaderField, ReaderParagraph, ResolvedHighlight } from "./data.ts";

export type ParagraphSelection = {
  field: ReaderField;
  paragraph: ReaderParagraph;
  highlightId: string | null;
};

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
  const lastTap = useRef<{ paragraph: number; time: number } | null>(null);
  const press = useRef<{ paragraph: number; x: number; y: number; scroll: number; time: number } | null>(null);
  const lastTouch = useRef(-Infinity);
  const anchors = new Set<string>();
  const marks = highlights.filter(mark => mark.field === field);

  function targetParagraph(event: TapEvent) {
    if (!(event.target instanceof Element) || event.target.closest("a,button,img")) return null;
    const value = event.target.closest("[data-paragraph]")?.getAttribute("data-paragraph");
    return value == null ? null : Number(value);
  }

  function clearTaps() {
    press.current = null;
    lastTap.current = null;
  }

  function startTap(event: TapEvent) {
    const paragraph = targetParagraph(event);
    if (!select || paragraph === null || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || window.getSelection()?.toString()) {
      clearTaps();
      return;
    }
    press.current = {
      paragraph,
      x: event.clientX,
      y: event.clientY,
      scroll: window.scrollY,
      time: performance.now(),
    };
  }

  function moveTap(event: { clientX: number; clientY: number }) {
    const start = press.current;
    if (start && (Math.abs(start.x - event.clientX) > 10 || Math.abs(start.y - event.clientY) > 10 || Math.abs(start.scroll - window.scrollY) > 5)) clearTaps();
  }

  function finishTap(event: TapEvent) {
    const start = press.current;
    press.current = null;
    const paragraph = targetParagraph(event);
    const now = performance.now();
    if (!select || !start || paragraph === null || start.paragraph !== paragraph || now - start.time > 500 || Math.abs(start.x - event.clientX) > 10 || Math.abs(start.y - event.clientY) > 10 || Math.abs(start.scroll - window.scrollY) > 5) {
      clearTaps();
      return;
    }
    const highlightId = window.getSelection()?.toString() ? null : ((event.target as Element).closest("mark[data-hl]")?.getAttribute("data-hl") ?? null);
    if (highlightId || (lastTap.current?.paragraph === paragraph && now - lastTap.current.time <= 500)) {
      lastTap.current = null;
      window.getSelection()?.removeAllRanges();
      select({ field, paragraph: paragraphs[paragraph]!, highlightId });
    } else {
      lastTap.current = { paragraph, time: now };
    }
  }

  return (
    <div
      id={id}
      className="excerpt-body"
      data-field={field}
      data-paragraph-actions={select ? "" : undefined}
      lang={lang}
      hidden={hidden}
      onPointerDown={event => {
        if (!event.isPrimary || event.button !== 0) {
          clearTaps();
          return;
        }
        startTap(event);
      }}
      onPointerMove={moveTap}
      onPointerCancel={clearTaps}
      // Older Android WebViews send Touch/Mouse events without Pointer Events.
      onTouchStart={event => {
        if (window.PointerEvent) return;
        lastTouch.current = performance.now();
        if (event.touches.length !== 1) return clearTaps();
        const touch = event.touches[0]!;
        startTap({ target: event.target, clientX: touch.clientX, clientY: touch.clientY });
      }}
      onTouchMove={event => {
        if (window.PointerEvent) return;
        if (event.touches.length !== 1) return clearTaps();
        moveTap(event.touches[0]!);
      }}
      onTouchCancel={clearTaps}
      onTouchEnd={event => {
        if (window.PointerEvent) return;
        lastTouch.current = performance.now();
        if (event.touches.length || event.changedTouches.length !== 1) return clearTaps();
      }}
      onMouseDown={event => {
        // A touch can synthesize mouse events; count each physical tap only once.
        if (window.PointerEvent || performance.now() - lastTouch.current < 1000) return;
        if (event.button !== 0) return clearTaps();
        startTap(event);
      }}
      onMouseMove={event => {
        if (!window.PointerEvent) moveTap(event);
      }}
      // Open after pointerup/touchend: their synthesized click must not land on the new backdrop.
      onClick={finishTap}
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
