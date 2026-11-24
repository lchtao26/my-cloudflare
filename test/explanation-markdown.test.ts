import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { explanationMarkdown } from "../src/reader/explanation-markdown.ts";
import { renderMarkdown } from "../src/reader/markdown-elements.ts";

test("explanation Markdown preserves structure while treating HTML as text", () => {
  const nodes = explanationMarkdown("## 标题\n\n这段 **重要**，见 [来源](https://example.com)。\n\n- 第一项\n- 第二项\n\n```js\nconst x = 1;\n```\n\n<script>alert(1)</script>\n\n[危险](javascript:alert(1))");
  const json = JSON.stringify(nodes);
  for (const tag of ["h2", "strong", "a", "ul", "li", "pre", "code"]) assert.match(json, new RegExp(`"tag":"${tag}"`));
  assert.match(json, /"href":"https:\/\/example\.com"/);
  assert.match(json, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(json, /"tag":"script"|"href":"javascript:/);
});

test("article Markdown renders safe images without accepting unsafe URLs", () => {
  const nodes = explanationMarkdown("![图片](https://example.com/a.png) ![坏图](javascript:alert(1))", true);
  const json = JSON.stringify(nodes);
  assert.match(json, /"src":"https:\/\/example\.com\/a\.png"/);
  assert.doesNotMatch(json, /"src":"javascript:/);
});

test("renderMarkdown safely renders void elements such as hr, br, and img", () => {
  const nodes = explanationMarkdown("第一行  \n第二行\n\n---\n\n![图片](https://example.com/a.png)", true);
  const html = renderToStaticMarkup(createElement("div", null, renderMarkdown(nodes)));
  assert.match(html, /<br\/>/);
  assert.match(html, /<hr\/>/);
  assert.match(html, /<img src="https:\/\/example\.com\/a\.png" alt="图片"\/>/);
});
