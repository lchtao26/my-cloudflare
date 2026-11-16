import { Fragment, useRef, type MouseEvent, type ReactNode } from "react";
import type { ReaderField, ReaderParagraph, ResolvedHighlight } from "../reader-data.ts";

export type ParagraphSelection = {
  field: ReaderField;
  paragraph: ReaderParagraph;
  highlightId: string | null;
};

function lines(text: string): ReactNode {
  return text.split("\n").map((line, index) => <Fragment key={index}>{index > 0 && <br />}{line}</Fragment>);
}

function markedText(text: string, offset: number, highlights: ResolvedHighlight[], anchors: Set<string>) {
  if (!highlights.length) return lines(text);
  const characters = [...text.matchAll(/\S/g)].map(match => match.index);
  const spans = highlights.flatMap(highlight => {
    const start = Math.max(0, highlight.start - offset);
    const end = Math.min(characters.length, highlight.end - offset);
    return start < end ? [{
      id: highlight.id, start: characters[start]!, end: characters[end - 1]! + 1,
    }] : [];
  });
  if (!spans.length) return lines(text);
  const edges = [...new Set([0, text.length, ...spans.flatMap(span => [span.start, span.end])])].sort((a, b) => a - b);

  return edges.slice(0, -1).map((start, index) => {
    const end = edges[index + 1]!;
    const active = spans.filter(span => span.start <= start && end <= span.end);
    const newAnchors = active.filter(span => !anchors.has(span.id));
    for (const span of newAnchors) anchors.add(span.id);
    const content = active.reduceRight<ReactNode>(
      (child, span) => <mark className="hl" data-hl={span.id}>{child}</mark>, lines(text.slice(start, end)),
    );
    return <Fragment key={start}>
      {newAnchors.map(span => <span key={span.id} id={`hl-${span.id}`} />)}
      {content}
    </Fragment>;
  });
}

export function ReadingBody({ id, field, lang, paragraphs, highlights, hidden, select }: {
  id?: string;
  field: ReaderField;
  lang?: string;
  paragraphs: ReaderParagraph[];
  highlights: ResolvedHighlight[];
  hidden?: boolean;
  select?: (selection: ParagraphSelection) => void;
}) {
  const lastTap = useRef<{ paragraph: number; time: number } | null>(null);
  const press = useRef<{ paragraph: number; x: number; y: number; scroll: number; time: number; mouse: boolean } | null>(null);
  const anchors = new Set<string>();
  const marks = highlights.filter(mark => mark.field === field);

  function targetParagraph(event: MouseEvent) {
    if (!(event.target instanceof Element) || event.target.closest("a,button,img")) return null;
    const value = event.target.closest("p[data-paragraph]")?.getAttribute("data-paragraph");
    return value == null ? null : Number(value);
  }

  function clearTaps() {
    press.current = null;
    lastTap.current = null;
  }

  function finishTap(event: MouseEvent) {
    const start = press.current;
    press.current = null;
    const paragraph = targetParagraph(event);
    const now = performance.now();
    if (!select || !start || paragraph === null || start.paragraph !== paragraph || now - start.time > 500
      || Math.abs(start.x - event.clientX) > 10 || Math.abs(start.y - event.clientY) > 10
      || Math.abs(start.scroll - window.scrollY) > 5) {
      clearTaps();
      return;
    }
    const highlightId = window.getSelection()?.toString()
      ? null : (event.target as Element).closest("mark[data-hl]")?.getAttribute("data-hl") ?? null;
    if (highlightId || (lastTap.current?.paragraph === paragraph && now - lastTap.current.time <= 500)) {
      lastTap.current = null;
      window.getSelection()?.removeAllRanges();
      select({ field, paragraph: paragraphs[paragraph]!, highlightId });
    } else {
      lastTap.current = { paragraph, time: now };
    }
  }

  return (
    <div id={id} className="excerpt-body" data-field={field} lang={lang} hidden={hidden}
      onPointerDown={event => {
        const paragraph = targetParagraph(event);
        if (!select || !event.isPrimary || event.button !== 0 || paragraph === null
          || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || window.getSelection()?.toString()) {
          clearTaps();
          return;
        }
        press.current = {
          paragraph, x: event.clientX, y: event.clientY, scroll: window.scrollY,
          time: performance.now(), mouse: event.pointerType === "mouse",
        };
      }}
      onPointerCancel={clearTaps}
      onPointerUp={event => {
        if (event.pointerType !== "mouse") finishTap(event);
      }}
      onClick={event => {
        if (press.current?.mouse) finishTap(event);
      }}>
      {paragraphs.map((paragraph, index) => {
        let offset = paragraph.start;
        const relevant = marks.filter(mark => mark.start < paragraph.end && mark.end > paragraph.start);
        return <p key={index} data-paragraph={index}>{paragraph.parts.map((part, partIndex) => {
          if ("image" in part) return <img key={partIndex} src={part.image} alt="正文图片" />;
          const content = markedText(part.text, offset, relevant, anchors);
          offset += part.text.replace(/\s/g, "").length;
          return <Fragment key={partIndex}>{content}</Fragment>;
        })}</p>;
      })}
    </div>
  );
}
