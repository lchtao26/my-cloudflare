import { createElement, type ReactNode } from "react";
import type { MarkdownNode } from "./explanation-markdown.ts";

export const VOID_MARKDOWN_TAGS = new Set(["br", "hr", "img"]);

export function renderMarkdown(nodes: MarkdownNode[]): ReactNode[] {
  return nodes.map((node, index) => {
    if (node.type === "text") return node.text;
    const props = { key: index, href: node.href, src: node.src, alt: node.alt, start: node.start };
    return VOID_MARKDOWN_TAGS.has(node.tag) ? createElement(node.tag, props) : createElement(node.tag, props, renderMarkdown(node.children));
  });
}
