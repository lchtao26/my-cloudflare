import MarkdownIt from "markdown-it";

type MarkdownNode = { type: "text"; text: string } | { type: "element"; tag: string; children: MarkdownNode[]; href?: string; start?: number };
const parser = new MarkdownIt({ html: false, linkify: false }).disable("image");
type Token = ReturnType<typeof parser.parse>[number];
const allowedTags = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "ul", "ol", "li", "em", "strong", "s", "a", "table", "thead", "tbody", "tr", "th", "td", "hr", "br"]);

/** Convert model output to an allowlisted tree; no HTML from the model is inserted into the page. */
export function explanationMarkdown(text: string): MarkdownNode[] {
  const root: MarkdownNode[] = [];
  const stack: MarkdownNode[][] = [root];
  const current = () => stack[stack.length - 1]!;
  const addText = (value: string) => { if (value) current().push({ type: "text", text: value }); };
  const addElement = (tag: string, children: MarkdownNode[] = []): Extract<MarkdownNode, { type: "element" }> => {
    const element: Extract<MarkdownNode, { type: "element" }> = { type: "element", tag, children };
    current().push(element);
    return element;
  };
  function visit(tokens: Token[]): void {
    for (const token of tokens) {
      if (token.hidden) continue;
      if (token.type === "inline") { visit(token.children || []); continue; }
      if (token.type === "text" || token.type === "html_inline" || token.type === "html_block") { addText(token.content); continue; }
      if (token.type === "softbreak") { addText("\n"); continue; }
      if (token.type === "hardbreak") { addElement("br"); continue; }
      if (token.type === "code_inline") { addElement("code", [{ type: "text", text: token.content }]); continue; }
      if (token.type === "fence" || token.type === "code_block") {
        addElement("pre", [{ type: "element", tag: "code", children: [{ type: "text", text: token.content }] }]);
        continue;
      }
      if (!allowedTags.has(token.tag)) continue;
      if (token.nesting === -1) { if (stack.length > 1) stack.pop(); continue; }
      const element = addElement(token.tag);
      if (token.tag === "a") {
        const href = String(token.attrGet("href") || "");
        if (/^(https?:\/\/|mailto:|\/(?!\/)|#)/i.test(href)) element.href = href;
      }
      if (token.tag === "ol") {
        const start = Number(token.attrGet("start"));
        if (Number.isSafeInteger(start) && start > 0) element.start = start;
      }
      if (token.nesting === 1) stack.push(element.children);
    }
  }
  visit(parser.parse(text, {}));
  return root;
}
