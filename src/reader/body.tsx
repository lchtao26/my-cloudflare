import { Fragment, createElement, type MouseEvent, type ReactNode } from "react";
import type { MarkdownNode } from "./explanation-markdown.ts";
import { VOID_MARKDOWN_TAGS } from "./markdown-elements.ts";
import type { ReaderField, ReaderParagraph, ResolvedHighlight } from "./data.ts";

export type ParagraphSelection = {
  field: ReaderField;
  paragraph: ReaderParagraph;
  highlightId: string | null;
};

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
  const anchors = new Set<string>();
  const marks = highlights.filter(mark => mark.field === field);

  function targetParagraph(event: MouseEvent<HTMLDivElement>) {
    if (!(event.target instanceof Element) || event.target.closest("a,button,img")) return null;
    const value = event.target.closest("[data-paragraph]")?.getAttribute("data-paragraph");
    return value == null ? null : Number(value);
  }

  function onClick(event: MouseEvent<HTMLDivElement>) {
    if (!select || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || window.getSelection()?.toString()) return;
    const paragraph = targetParagraph(event);
    if (paragraph === null) return;
    const highlightId = event.target instanceof Element ? (event.target.closest("mark[data-hl]")?.getAttribute("data-hl") ?? null) : null;
    event.stopPropagation();
    select({ field, paragraph: paragraphs[paragraph]!, highlightId });
  }

  return (
    <div id={id} className="excerpt-body" data-field={field} data-paragraph-actions={select ? "" : undefined} lang={lang} hidden={hidden} onClick={onClick}>
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
            return createElement(node.tag, { key: index, href: node.href, src: node.src, alt: node.alt, start: node.start }, VOID_MARKDOWN_TAGS.has(node.tag) ? undefined : render(node.children));
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
