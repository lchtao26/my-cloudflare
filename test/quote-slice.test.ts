import assert from "node:assert/strict";
import test from "node:test";
import type { ReaderParagraph, ResolvedHighlight } from "../src/reader-data.ts";
import type { ParagraphSelection } from "../src/reader/body.tsx";
import { selectionPreview } from "../src/reader/quote-slice.ts";

const paragraph: ReaderParagraph = {
  parts: [{ text: "openai 完成了第一轮融资" }],
  quote: "openai 完成了第一轮融资",
  start: 0,
  end: 14,
};
const next: ReaderParagraph = {
  parts: [{ text: "下一段" }],
  quote: "下一段",
  start: 14,
  end: 17,
};

function selected(highlightId: string | null): ParagraphSelection {
  return { field: "translation", paragraph, highlightId };
}

function mark(start: number, end: number): ResolvedHighlight {
  return { id: "mark", field: "translation", start, end };
}

test("a token highlight previews only its own quote", () => {
  assert.equal(selectionPreview(selected("mark"), [mark(0, 6)], [paragraph, next]), "openai");
});

test("a contiguous token run previews the slice, including the space inside it", () => {
  assert.equal(selectionPreview(selected("mark"), [mark(0, 8)], [paragraph]), "openai 完成");
});

test("a whole-paragraph highlight still previews that paragraph", () => {
  assert.equal(selectionPreview(selected("mark"), [mark(0, 14)], [paragraph, next]), paragraph.quote);
});

test("opening a paragraph without a highlight previews the paragraph", () => {
  assert.equal(selectionPreview(selected(null), [mark(0, 6)], [paragraph]), paragraph.quote);
});
