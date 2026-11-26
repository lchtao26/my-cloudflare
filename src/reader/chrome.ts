import type { ParagraphSelection } from "./body.tsx";

export type ReadingTab = "paragraph" | "article" | "share";

export type ReadingChrome = { open: false } | { open: true; tab: ReadingTab; selection: ParagraphSelection | null };

export function clickParagraphChrome(current: ReadingChrome, selection: ParagraphSelection): ReadingChrome {
  return current.open ? closeChrome() : { open: true, tab: "paragraph", selection };
}

export function clickSurfaceChrome(current: ReadingChrome): ReadingChrome {
  return current.open ? closeChrome() : { open: true, tab: "article", selection: null };
}

export function selectChromeTab(current: ReadingChrome, tab: ReadingTab): ReadingChrome {
  return current.open ? { ...current, tab } : current;
}

export function closeChrome(): ReadingChrome {
  return { open: false };
}
