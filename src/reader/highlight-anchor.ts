/** UTF-16 offsets into rendered text with whitespace removed, matching DOM Range offsets. */
export function canonicalText(text: string): string {
  return text.replace(/\s/g, "");
}

export type HighlightAnchor = {
  start: number;
  end: number;
  quote: string;
  prefix: string;
  suffix: string;
  bodyHash: string;
};

export async function hashText(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Do not place changed, ambiguous content on a guessed occurrence. */
export function resolveAnchor(text: string, hash: string, anchor: HighlightAnchor): { start: number; end: number } | null {
  const quote = canonicalText(anchor.quote);
  if (!quote) return null;
  if (hash === anchor.bodyHash && anchor.start >= 0 && anchor.end === anchor.start + quote.length && text.slice(anchor.start, anchor.end) === quote) {
    return { start: anchor.start, end: anchor.end };
  }
  // The stored 32-unit contexts cannot prove that a matching occurrence is
  // the same one after an edit: a distant duplicate can share both contexts.
  // Preserve the record as an orphan until the canonical body matches again.
  return null;
}
