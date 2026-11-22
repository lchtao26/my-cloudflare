import { canonicalText } from "./highlight-anchor.ts";

export type Token =
  | { kind: "space"; text: string }
  | { kind: "mark"; text: string; index: number; start: number; end: number }
  | { kind: "token"; text: string; index: number; start: number; end: number };

export type TokenRange = { start: number; end: number; quote: string };

type Unit = { text: string; kind: "space" | "mark" | "token" };
type Piece = { text: string; kind: "space" | "word" | "emoji" | "mark" };

const CONNECTORS = new Set(["-", "‐", "_", ".", "@", "/", "'", "’", "·", "&", "+"]);
const CURRENCIES = new Set(["$", "¥", "￥", "€", "£"]);
const PERCENTS = new Set(["%", "％", "‰"]);
const UNIT_CHARS = new Set("年月日号时点分秒岁个次倍");

let wordSegmenter: Intl.Segmenter | undefined;

const emojiPattern = createEmojiPattern();

function createEmojiPattern(): RegExp | null {
  try {
    return new RegExp("\\p{Extended_Pictographic}|\\p{Regional_Indicator}", "u");
  } catch {
    return null;
  }
}

function segmenter(): Intl.Segmenter | null {
  if (typeof Intl.Segmenter !== "function") return null;
  wordSegmenter ??= new Intl.Segmenter(undefined, { granularity: "word" });
  return wordSegmenter;
}

function isEmojiText(text: string): boolean {
  if (emojiPattern) return emojiPattern.test(text);
  return /[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(text);
}

function classify(text: string, wordLike: boolean): Piece["kind"] {
  if (canonicalText(text) === "") return "space";
  if (wordLike) return "word";
  if (isEmojiText(text)) return "emoji";
  return "mark";
}

function isConnectorText(text: string): boolean {
  if (text.length === 0) return false;
  for (const char of text) if (!CONNECTORS.has(char)) return false;
  return true;
}

function isLatinOrDigitWord(text: string): boolean {
  return /[A-Za-z0-9\u00c0-\u024f]/.test(text) && /^[A-Za-z0-9\u00c0-\u024f.'’,]+$/.test(text);
}

function isLatinLetterWord(text: string): boolean {
  return /^[A-Za-z\u00c0-\u024f]+$/.test(text);
}

function isNumericWord(text: string): boolean {
  return /^\d[\d,.]*$/.test(text);
}

function isConnectorPiece(piece: Piece | undefined): piece is Piece {
  return piece !== undefined && piece.kind === "mark" && isConnectorText(piece.text);
}

function isTrailingPiece(piece: Piece | undefined): piece is Piece {
  return piece !== undefined && piece.kind === "mark" && /^[+#]+$/.test(piece.text);
}

function isPercentPiece(piece: Piece | undefined): piece is Piece {
  return piece !== undefined && PERCENTS.has(piece.text);
}

function isUnitPiece(piece: Piece | undefined): piece is Piece {
  return piece?.kind === "word" && piece.text.length === 1 && UNIT_CHARS.has(piece.text);
}

function isNumericPiece(piece: Piece | undefined): piece is Piece {
  return piece?.kind === "word" && isNumericWord(piece.text);
}

function mergePieces(pieces: Piece[], withUnits: boolean): Unit[] {
  const out: Unit[] = [];
  let i = 0;
  while (i < pieces.length) {
    const piece = pieces[i];
    if (piece === undefined) break;
    if (piece.kind === "space") {
      out.push({ text: piece.text, kind: "space" });
      i++;
      continue;
    }
    if (piece.kind === "emoji") {
      out.push({ text: piece.text, kind: "token" });
      i++;
      continue;
    }
    const number = pieces[i + 1];
    if (CURRENCIES.has(piece.text) && isNumericPiece(number)) {
      let text = piece.text + number.text;
      i += 2;
      const percent = pieces[i];
      if (isPercentPiece(percent)) {
        text += percent.text;
        i++;
      }
      out.push({ text, kind: "token" });
      continue;
    }
    if (piece.kind === "word" && isLatinOrDigitWord(piece.text)) {
      let text = piece.text;
      i++;
      while (true) {
        const connector = pieces[i];
        const next = pieces[i + 1];
        if (!isConnectorPiece(connector) || !next || next.kind !== "word" || !isLatinOrDigitWord(next.text)) break;
        text += connector.text + next.text;
        i += 2;
      }
      if (isLatinLetterWord(text)) {
        let trailing = pieces[i];
        while (isTrailingPiece(trailing)) {
          text += trailing.text;
          i++;
          trailing = pieces[i];
        }
      }
      const percent = pieces[i];
      if (isNumericWord(text) && isPercentPiece(percent)) {
        text += percent.text;
        i++;
      }
      const unit = pieces[i];
      if (withUnits && /^\d+$/.test(text) && isUnitPiece(unit)) {
        text += unit.text;
        i++;
      }
      out.push({ text, kind: "token" });
      continue;
    }
    if (piece.kind === "word") {
      out.push({ text: piece.text, kind: "token" });
      i++;
      continue;
    }
    out.push({ text: piece.text, kind: "mark" });
    i++;
  }
  return out;
}

function segmentPieces(quote: string, current: Intl.Segmenter): Piece[] {
  const pieces: Piece[] = [];
  for (const part of current.segment(quote)) pieces.push({ text: part.segment, kind: classify(part.segment, part.isWordLike === true) });
  return pieces;
}

function isRegionalIndicator(text: string): boolean {
  const code = text.codePointAt(0);
  return code !== undefined && code >= 0x1f1e6 && code <= 0x1f1ff;
}

function isAttacher(text: string): boolean {
  if (text === "\u200d" || text === "\ufe0f") return true;
  const code = text.codePointAt(0);
  return code !== undefined && ((code >= 0x1f3fb && code <= 0x1f3ff) || (code >= 0x0300 && code <= 0x036f));
}

function isExtHan(code: number): boolean {
  return (code >= 0x20000 && code <= 0x2a6df)
    || (code >= 0x2a700 && code <= 0x2b73f)
    || (code >= 0x2b740 && code <= 0x2b81f)
    || (code >= 0x2b820 && code <= 0x2ceaf)
    || (code >= 0x2ceb0 && code <= 0x2ebef)
    || (code >= 0x30000 && code <= 0x3134f)
    || (code >= 0x31350 && code <= 0x323af);
}

function graphemeClusters(quote: string): string[] {
  const points = Array.from(quote);
  const clusters: string[] = [];
  let i = 0;
  while (i < points.length) {
    const first = points[i];
    if (first === undefined) break;
    let cluster = first;
    i++;
    const second = points[i];
    if (second !== undefined && isRegionalIndicator(first) && isRegionalIndicator(second)) {
      cluster += second;
      i++;
    }
    while (i < points.length) {
      const extra = points[i];
      if (extra === undefined || !isAttacher(extra)) break;
      cluster += extra;
      i++;
      if (extra === "\u200d") {
        const joined = points[i];
        if (joined === undefined) break;
        cluster += joined;
        i++;
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

function isLatinDigitCluster(cluster: string): boolean {
  const chars = Array.from(cluster);
  const first = chars[0];
  if (first === undefined || !/[A-Za-z0-9\u00c0-\u024f]/.test(first)) return false;
  for (const char of chars.slice(1)) if (!isAttacher(char)) return false;
  return true;
}

function isHanKanaCluster(cluster: string): boolean {
  const code = cluster.codePointAt(0);
  if (code === undefined) return false;
  return (code >= 0x3040 && code <= 0x30ff) || (code >= 0x3400 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff) || isExtHan(code);
}

function fallbackPieces(quote: string): Piece[] {
  const pieces: Piece[] = [];
  const clusters = graphemeClusters(quote);
  let i = 0;
  while (i < clusters.length) {
    const cluster = clusters[i];
    if (cluster === undefined) break;
    if (canonicalText(cluster) === "") {
      pieces.push({ text: cluster, kind: "space" });
      i++;
      continue;
    }
    if (isLatinDigitCluster(cluster)) {
      let text = "";
      while (i < clusters.length) {
        const next = clusters[i];
        if (next === undefined || !isLatinDigitCluster(next)) break;
        text += next;
        i++;
      }
      pieces.push({ text, kind: "word" });
      continue;
    }
    if (isHanKanaCluster(cluster)) {
      pieces.push({ text: cluster, kind: "word" });
      i++;
      continue;
    }
    const code = cluster.codePointAt(0) ?? 0;
    pieces.push({ text: cluster, kind: code > 0xffff ? "emoji" : "mark" });
    i++;
  }
  return pieces;
}

function units(quote: string): Unit[] {
  const current = segmenter();
  return mergePieces(current ? segmentPieces(quote, current) : fallbackPieces(quote), current !== null);
}

/** `index` is a UTF-16 offset into `quote`. `start`/`end` are canonical offsets from `offset`. */
export function tokenize(quote: string, offset: number): Token[] {
  const tokens: Token[] = [];
  let quoteIndex = 0;
  let canonical = offset;
  for (const unit of units(quote)) {
    const width = canonicalText(unit.text).length;
    if (width === 0) tokens.push({ kind: "space", text: unit.text });
    else {
      const start = canonical;
      canonical += width;
      const positioned = { text: unit.text, index: quoteIndex, start, end: canonical };
      tokens.push(unit.kind === "mark" ? { kind: "mark", ...positioned } : { kind: "token", ...positioned });
    }
    quoteIndex += unit.text.length;
  }
  return tokens;
}

export function tokenRanges(quote: string, tokens: Token[], selected: ReadonlySet<number>): TokenRange[] {
  const words = tokens.filter((token): token is Extract<Token, { kind: "token" }> => token.kind === "token");
  const ordinals = [...selected].filter(ordinal => ordinal >= 0 && ordinal < words.length).sort((a, b) => a - b);
  const ranges: TokenRange[] = [];
  let runStart = -1;
  let previous = -1;
  function flush(endOrdinal: number) {
    const first = words[runStart];
    const last = words[endOrdinal];
    if (!first || !last) return;
    ranges.push({ start: first.start, end: last.end, quote: quote.slice(first.index, last.index + last.text.length) });
  }
  for (const ordinal of ordinals) {
    if (previous !== -1 && ordinal !== previous + 1) flush(previous);
    if (previous === -1 || ordinal !== previous + 1) runStart = ordinal;
    previous = ordinal;
  }
  if (previous !== -1) flush(previous);
  return ranges;
}
