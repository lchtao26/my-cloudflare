import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { EINK_STYLE } from "../reader-style.ts";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { title: "阅读节选" },
    ],
    links: [
      { rel: "icon", type: "image/png", sizes: "32x32", href: "/favicon.png" },
      { rel: "apple-touch-icon", sizes: "180x180", href: "/apple-touch-icon.png" },
      { rel: "manifest", href: "/manifest.webmanifest" },
    ],
  }),
  component: ReaderApp,
  shellComponent: ReaderDocument,
  notFoundComponent: () => <main><p>未找到页面。</p></main>,
});

function ReaderApp() {
  const [client] = useState(() => new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  }));
  return <QueryClientProvider client={client}><Outlet /></QueryClientProvider>;
}

function ReaderDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <head><HeadContent /><style>{EINK_STYLE}</style></head>
      <body>
        {children}
        <noscript><p>启用 JavaScript 可使用完整阅读功能。也可订阅 <a href="/read.xml">阅读节选 RSS</a>。</p></noscript>
        <Scripts />
      </body>
    </html>
  );
}
