import assert from "node:assert/strict";
import test from "node:test";
import type { ParagraphSelection } from "../src/reader/body.tsx";
import { clickParagraphChrome, clickSurfaceChrome, closeChrome, selectChromeTab, type ReadingChrome } from "../src/reader/chrome.ts";

const selection: ParagraphSelection = {
  field: "translation",
  paragraph: { parts: [{ text: "正文段落" }], quote: "正文段落", start: 0, end: 4 },
  highlightId: null,
};

test("clicking a paragraph opens its selection in the paragraph tab", () => {
  assert.deepEqual(clickParagraphChrome({ open: false }, selection), { open: true, tab: "paragraph", selection });
});

test("clicking a paragraph dismisses any open chrome and clears its selection", () => {
  for (const tab of ["paragraph", "article", "share"] as const) {
    assert.deepEqual(clickParagraphChrome({ open: true, tab, selection }, { ...selection, highlightId: "mark" }), { open: false });
    assert.deepEqual(clickParagraphChrome({ open: true, tab, selection: null }, selection), { open: false });
  }
});

test("clicking the reading surface opens the article tab without a paragraph", () => {
  assert.deepEqual(clickSurfaceChrome({ open: false }), { open: true, tab: "article", selection: null });
});

test("clicking the reading surface dismisses any open chrome", () => {
  for (const tab of ["paragraph", "article", "share"] as const) {
    assert.deepEqual(clickSurfaceChrome({ open: true, tab, selection }), { open: false });
    assert.deepEqual(clickSurfaceChrome({ open: true, tab, selection: null }), { open: false });
  }
});

test("switching tabs preserves the paragraph selection until chrome closes", () => {
  let chrome = clickParagraphChrome({ open: false }, { ...selection, highlightId: "mark" });
  const selected = chrome.open ? chrome.selection : null;
  for (const tab of ["article", "share", "paragraph"] as const) {
    chrome = selectChromeTab(chrome, tab);
    assert.deepEqual(chrome, { open: true, tab, selection: selected });
    assert.equal(chrome.open && chrome.selection, selected);
  }
});

test("switching tabs with no paragraph preserves the empty selection", () => {
  assert.deepEqual(selectChromeTab(clickSurfaceChrome({ open: false }), "paragraph"), { open: true, tab: "paragraph", selection: null });
});

test("switching tabs leaves closed chrome unchanged", () => {
  const chrome: ReadingChrome = { open: false };
  for (const tab of ["paragraph", "article", "share"] as const) assert.equal(selectChromeTab(chrome, tab), chrome);
});

test("closing chrome drops its paragraph selection before opening again", () => {
  const closed = closeChrome();
  assert.deepEqual(closed, { open: false });
  assert.deepEqual(clickSurfaceChrome(closed), { open: true, tab: "article", selection: null });
});
