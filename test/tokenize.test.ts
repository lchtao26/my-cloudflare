import assert from "node:assert/strict";
import test from "node:test";
import { canonicalText } from "../src/reader/highlight-anchor.ts";
import { tokenRanges, tokenize, type Token } from "../src/reader/tokenize.ts";

function wordTokens(quote: string, offset = 0) {
  return tokenize(quote, offset).filter((token): token is Extract<Token, { kind: "token" }> => token.kind === "token");
}

function ranges(quote: string, selected: number[], offset = 0) {
  return tokenRanges(quote, tokenize(quote, offset), new Set(selected));
}

test("tokens keep canonical offsets and leave whitespace in place", () => {
  const quote = "甲 乙丙";
  const tokens = tokenize(quote, 10);
  assert.deepEqual(
    wordTokens(quote, 10).map(token => [token.text, token.start, token.end]),
    [
      ["甲", 10, 11],
      ["乙", 11, 12],
      ["丙", 12, 13],
    ],
  );
  assert.equal(
    tokens
      .filter(token => token.kind === "space")
      .map(token => token.text)
      .join(""),
    " ",
  );
  assert.equal(wordTokens(quote, 10).at(-1)!.end, 10 + canonicalText(quote).length);
  for (const space of ["\n", "\u3000", "\u00a0", "\t"]) {
    const sample = `甲${space}乙`;
    const parts = tokenize(sample, 0);
    assert.equal(parts.filter(token => token.kind === "space").length, 1, space);
    assert.deepEqual(
      wordTokens(sample).map(token => [token.start, token.end]),
      [
        [0, 1],
        [1, 2],
      ],
    );
  }
});

test("selected tokens merge across whitespace and split at gaps", () => {
  const quote = "甲 乙丙";
  assert.deepEqual(ranges(quote, [0, 1]), [{ start: 0, end: 2, quote: "甲 乙" }]);
  assert.deepEqual(ranges(quote, [0, 2]), [
    { start: 0, end: 1, quote: "甲" },
    { start: 2, end: 3, quote: "丙" },
  ]);
  assert.deepEqual(ranges(quote, [1, 2]), [{ start: 1, end: 3, quote: "乙丙" }]);
  assert.deepEqual(ranges("甲\n乙", [0, 1]), [{ start: 0, end: 2, quote: "甲\n乙" }]);
});

test("emoji stays one token, including a zwj family and the code-point fallback", t => {
  const emoji = wordTokens("a😀b");
  assert.deepEqual(
    emoji.map(token => [token.text, token.start, token.end]),
    [
      ["a", 0, 1],
      ["😀", 1, 3],
      ["b", 3, 4],
    ],
  );
  const family = "👨‍👩‍👧";
  const grouped = wordTokens(family);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0]!.end - grouped[0]!.start, family.length);
  assert.equal(family.length, 8);
  t.mock.property(Intl, "Segmenter", undefined);
  const fallback = wordTokens("a😀b");
  assert.deepEqual(
    fallback.map(token => token.text),
    ["a", "😀", "b"],
  );
  assert.equal(fallback[1]!.end - fallback[1]!.start, 2);
});

test("every range quote canonicalizes to its offsets", () => {
  for (const quote of ["甲 乙丙", "甲\n乙", "a😀b", "全角\u3000空格", "甲\u00a0乙\t丙"]) {
    const selected = new Set(
      wordTokens(quote)
        .map((_, index) => index)
        .filter(index => index % 2 === 0),
    );
    let previous = 0;
    for (const range of ranges(quote, [...selected])) {
      assert.equal(canonicalText(range.quote).length, range.end - range.start);
      assert.ok(range.start >= previous);
      previous = range.end;
    }
    const all = wordTokens(quote);
    assert.equal(all.at(-1)?.end ?? 0, canonicalText(quote).length);
  }
});

const samples = [
  "我们今天去北京大学看看。",
  "don't e-mail me at a@b.com",
  "Hello,world.",
  "C++和C#",
  "¥7,999，约合$1,099.50",
  "50%的人",
  "2026年11月22日",
  "iPhone 15 Pro的价格",
  "人工智能（AI）模型GPT-4o",
  "a😀b",
  "👨‍👩‍👧",
  "🇨🇳",
  "甲 乙丙",
  "甲\n乙",
  "甲，乙丙",
  "hello world",
  "全角\u3000空格",
  "甲\u00a0乙\t丙",
  "e-mail 50%",
  "北京大学",
];

function assertTokens(quote: string, offset = 0) {
  const tokens = tokenize(quote, offset);
  assert.equal(tokens.map(token => token.text).join(""), quote);
  let canonical = offset;
  let quoteIndex = 0;
  for (const token of tokens) {
    if (token.kind !== "space") {
      assert.equal(token.start, canonical, quote);
      assert.equal(token.index, quoteIndex, quote);
      assert.equal(quote.slice(token.index, token.index + token.text.length), token.text);
      canonical = token.end;
    }
    quoteIndex += token.text.length;
  }
  assert.equal(quoteIndex, quote.length, quote);
  assert.equal(canonical, offset + canonicalText(quote).length, quote);
  const selected = new Set<number>();
  let ordinal = 0;
  for (const token of tokens) {
    if (token.kind !== "token") continue;
    if (ordinal % 2 === 0) selected.add(ordinal);
    ordinal++;
  }
  let previousEnd = -1;
  for (const range of tokenRanges(quote, tokens, selected)) {
    assert.equal(canonicalText(range.quote).length, range.end - range.start, quote);
    assert.ok(range.start > previousEnd, quote);
    previousEnd = range.end;
  }
}

test("chinese words are shorter than one token per character", () => {
  const quote = "我们今天去北京大学看看。";
  const words = wordTokens(quote).map(token => token.text);
  assert.ok(words.includes("我们"));
  assert.ok(words.includes("今天"));
  const hanCount = Array.from(quote).filter(char => /[\u3400-\u9fff]/.test(char)).length;
  assert.ok(words.length < hanCount);
  assert.equal(tokenize(quote, 0).find(token => token.text === "。")?.kind, "mark");
  assert.equal(words.includes("。"), false);
});

test("latin words keep internal joins and leave punctuation as marks", () => {
  assert.deepEqual(
    wordTokens("don't e-mail me at a@b.com").map(token => token.text),
    ["don't", "e-mail", "me", "at", "a@b.com"],
  );
  assert.deepEqual(
    wordTokens("Hello,world.").map(token => token.text),
    ["Hello", "world"],
  );
  assert.deepEqual(
    tokenize("Hello,world.", 0)
      .filter(token => token.kind === "mark")
      .map(token => token.text),
    [",", "."],
  );
  assert.deepEqual(
    wordTokens("C++和C#").map(token => token.text),
    ["C++", "和", "C#"],
  );
});

test("numbers keep currency, percent, and unit characters", () => {
  const money = wordTokens("¥7,999，约合$1,099.50").map(token => token.text);
  assert.ok(money.includes("¥7,999"));
  assert.ok(money.includes("$1,099.50"));
  assert.ok(
    wordTokens("50%的人")
      .map(token => token.text)
      .includes("50%"),
  );
  assert.deepEqual(
    wordTokens("2026年11月22日").map(token => token.text),
    ["2026年", "11月", "22日"],
  );
});

test("mixed script words split on script changes", () => {
  assert.deepEqual(
    wordTokens("iPhone 15 Pro的价格").map(token => token.text),
    ["iPhone", "15", "Pro", "的", "价格"],
  );
  const quote = "人工智能（AI）模型GPT-4o";
  const words = wordTokens(quote).map(token => token.text);
  assert.ok(words.includes("AI"));
  assert.ok(words.includes("GPT-4o"));
  const marks = tokenize(quote, 0)
    .filter(token => token.kind === "mark")
    .map(token => token.text);
  assert.deepEqual(marks, ["（", "）"]);
});

test("emoji clusters are single tokens", () => {
  const face = wordTokens("a😀b").find(token => token.text === "😀");
  assert.ok(face);
  assert.equal(face.end - face.start, 2);
  assert.equal(wordTokens("👨‍👩‍👧").length, 1);
  assert.equal(wordTokens("🇨🇳").length, 1);
});

test("marks do not break a run and an unselected token does", () => {
  const quote = "甲，乙丙";
  assert.equal(wordTokens(quote).length, 3);
  assert.deepEqual(ranges(quote, [0, 1]), [{ start: 0, end: 3, quote: "甲，乙" }]);
  const split = ranges(quote, [0, 2]);
  assert.equal(split.length, 2);
  assert.ok(split[1]!.start > split[0]!.end);
});

test("whitespace does not break a run", () => {
  assert.deepEqual(ranges("hello world", [0, 1]), [{ start: 0, end: 10, quote: "hello world" }]);
});

test("missing Segmenter falls back to per-character cjk and joined latin", t => {
  t.mock.property(Intl, "Segmenter", undefined);
  assert.deepEqual(
    wordTokens("北京大学").map(token => token.text),
    ["北", "京", "大", "学"],
  );
  assert.deepEqual(
    wordTokens("e-mail 50%").map(token => token.text),
    ["e-mail", "50%"],
  );
  const emoji = wordTokens("a😀b");
  assert.deepEqual(
    emoji.map(token => token.text),
    ["a", "😀", "b"],
  );
  assert.equal(emoji[1]!.end - emoji[1]!.start, 2);
  assert.equal(wordTokens("👨‍👩‍👧").length, 1);
});

test("token offsets and ranges stay canonical on both segmenters", t => {
  for (const quote of samples) assertTokens(quote);
  assertTokens("甲，乙丙", 10);
  t.mock.property(Intl, "Segmenter", undefined);
  for (const quote of samples) assertTokens(quote);
  assertTokens("甲，乙丙", 10);
});
