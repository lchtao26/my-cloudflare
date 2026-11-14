import { strict as assert } from "node:assert";
import { test } from "node:test";
import { canonicalText, hashText, resolveAnchor } from "../src/highlight-anchor.ts";

test("canonical text preserves Unicode and uses DOM-compatible UTF-16 offsets", () => {
  assert.equal(canonicalText("甲 \n😀\u3000乙"), "甲😀乙");
  assert.equal(canonicalText("甲 \n😀\u3000乙").indexOf("乙"), 3);
});

test("anchors resolve only for the unchanged canonical body", async () => {
  const old = "甲重复乙丙重复丁";
  const anchor = { start: 5, end: 7, quote: "重复", prefix: "乙丙", suffix: "丁", bodyHash: await hashText(old) };
  assert.deepEqual(resolveAnchor(old, anchor.bodyHash, anchor), { start: 5, end: 7 });
  assert.equal(resolveAnchor("新增" + old, await hashText("新增" + old), anchor), null);
});

test("removed or equally plausible repeated text is orphaned", () => {
  const anchor = { start: 0, end: 1, quote: "甲", prefix: "", suffix: "", bodyHash: "old" };
  assert.equal(resolveAnchor("乙", "new", anchor), null);
  assert.equal(resolveAnchor("甲乙甲", "new", anchor), null);
});

test("deleting the selected occurrence does not attach it to a different remaining match", async () => {
  const original = "甲首次观点乙。另一段丙首次观点丁";
  const anchor = { start: 1, end: 5, quote: "首次观点", prefix: "甲", suffix: "乙。另一段丙首次观点丁", bodyHash: await hashText(original) };
  assert.equal(resolveAnchor("另一段丙首次观点丁", "changed", anchor), null);
  assert.equal(resolveAnchor("开头" + original, "changed", anchor), null);
  // A shared suffix is not enough when the other side identifies another occurrence.
  assert.equal(resolveAnchor("丙首次观点乙。另一段丙首次观点丁".slice(0, 14), "changed", anchor), null);
  // A full-body quote has no context with which to identify it after edits.
  assert.equal(resolveAnchor("新文字甲", "changed", { start: 0, end: 1, quote: "甲", prefix: "", suffix: "", bodyHash: "old" }), null);
});


test("distant duplicate with similar context never replaces the deleted selection", async () => {
  const unit = "甲乙丙丁首次观点戊己庚辛";
  const original = "前文" + unit + "隔".repeat(80) + unit + "后文";
  const anchor = { start: 6, end: 10, quote: "首次观点", prefix: original.slice(0, 6), suffix: original.slice(10, 42), bodyHash: await hashText(original) };
  assert.equal(anchor.bodyHash, "78780698edc0c9f27429d1ca0377a7464793d85537fd67d8313f6899ce80f4b2");
  assert.deepEqual(resolveAnchor(original, anchor.bodyHash, anchor), { start: 6, end: 10 });
  const changed = "隔".repeat(80) + unit + "后文";
  assert.equal(resolveAnchor(changed, await hashText(changed), anchor), null);
  // The second occurrence also becomes an orphan when the first is deleted:
  // the existing record does not contain evidence to distinguish the cases.
  const second = { ...anchor, start: 98, end: 102 };
  assert.equal(resolveAnchor(changed, await hashText(changed), second), null);
});

test("whitespace-only changes retain the same canonical anchor", async () => {
  const before = canonicalText("甲 乙\n😀 丙");
  const after = canonicalText("甲\n乙 😀　丙");
  const anchor = { start: 2, end: 4, quote: "😀", prefix: "甲乙", suffix: "丙", bodyHash: await hashText(before) };
  assert.equal(await hashText(after), anchor.bodyHash);
  assert.deepEqual(resolveAnchor(after, await hashText(after), anchor), { start: 2, end: 4 });
});
