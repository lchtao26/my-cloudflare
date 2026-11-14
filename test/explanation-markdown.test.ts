import assert from "node:assert/strict";
import test from "node:test";
import { explanationMarkdown } from "../src/explanation-markdown.ts";

test("explanation Markdown preserves structure while treating HTML as text", () => {
  const nodes = explanationMarkdown("## 标题\n\n这段 **重要**，见 [来源](https://example.com)。\n\n- 第一项\n- 第二项\n\n```js\nconst x = 1;\n```\n\n<script>alert(1)</script>\n\n[危险](javascript:alert(1))");
  const json = JSON.stringify(nodes);
  for (const tag of ["h2", "strong", "a", "ul", "li", "pre", "code"]) assert.match(json, new RegExp(`"tag":"${tag}"`));
  assert.match(json, /"href":"https:\/\/example\.com"/);
  assert.match(json, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(json, /"tag":"script"|"href":"javascript:/);
});
