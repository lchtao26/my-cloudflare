import type { ReaderParagraph, ResolvedHighlight } from "../reader-data.ts";
import type { ParagraphSelection } from "./body.tsx";

export function sliceQuote(quote: string, quoteStart: number, start: number, end: number) {
  let canonical = quoteStart;
  let from = -1;
  let to = quote.length;
  for (let index = 0; index < quote.length && canonical < end; index++) {
    if (/\s/.test(quote[index]!)) continue;
    if (canonical === start) from = index;
    canonical += 1;
    if (canonical === end) to = index + 1;
  }
  return from < 0 ? "" : quote.slice(from, to);
}

export function quoteBetween(paragraphs: ReaderParagraph[], start: number, end: number) {
  return paragraphs.flatMap(paragraph => {
    if (paragraph.end <= start || paragraph.start >= end) return [];
    const slice = sliceQuote(paragraph.quote, paragraph.start, Math.max(start, paragraph.start), Math.min(end, paragraph.end));
    return slice ? [slice] : [];
  }).join("");
}

export function selectionPreview(selected: ParagraphSelection, highlights: ResolvedHighlight[], paragraphs: ReaderParagraph[]) {
  const mark = selected.highlightId ? highlights.find(item => item.id === selected.highlightId) : undefined;
  if (!mark) return selected.paragraph.quote;
  return quoteBetween(paragraphs, mark.start, mark.end) || selected.paragraph.quote;
}
