import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createRootRoute, HeadContent, Outlet, Scripts, useLocation } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { readSessionQuery } from "../reader/queries.ts";
import { EINK_STYLE } from "../reader/style.ts";

export const Route = createRootRoute({
  head: () => ({
    meta: [{ charSet: "utf-8" }, { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" }, { name: "color-scheme", content: "light dark" }, { title: "阅读节选" }],
    links: [
      { rel: "icon", type: "image/png", sizes: "32x32", href: "/favicon.png" },
      { rel: "apple-touch-icon", sizes: "180x180", href: "/apple-touch-icon.png" },
      { rel: "manifest", href: "/manifest.webmanifest" },
    ],
  }),
  component: ReaderApp,
  shellComponent: ReaderDocument,
  errorComponent: ({ reset }) => (
    <main>
      <p role="alert">页面出错了，请重试。</p>
      <p>
        <button type="button" className="other-link" onClick={reset}>
          重试
        </button>
      </p>
      <p>
        <a href="/read">返回列表</a>
      </p>
    </main>
  ),
  notFoundComponent: () => (
    <main>
      <p>未找到页面。</p>
    </main>
  ),
});

function ReaderApp() {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <Outlet />
      <ReadBar />
    </QueryClientProvider>
  );
}

function useReadSession(active: boolean) {
  const session = useQuery({ ...readSessionQuery(), enabled: active });
  return session.isSuccess ? session.data : null;
}

function ReadBar() {
  const pathname = useLocation({ select: location => location.pathname });
  const search = useLocation({ select: location => location.searchStr });
  const active = /^\/read\/?$/.test(pathname);
  const authenticated = useReadSession(active);
  if (!active) return null;
  const next = pathname + search;
  return (
    <header className="read-bar">
      <div className="read-bar-side" />
      <p className="read-bar-title">Read</p>
      <div className="read-bar-side">{authenticated === false ? <a href={`/auth?next=${encodeURIComponent(next)}`}>登录</a> : null}</div>
    </header>
  );
}

function ReaderDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        <HeadContent />
        <style>{EINK_STYLE}</style>
      </head>
      <body>
        {children}
        <noscript>
          <p>
            启用 JavaScript 可使用完整阅读功能。也可订阅 <a href="/read.xml">阅读节选 RSS</a>。
          </p>
        </noscript>
        <Scripts />
      </body>
    </html>
  );
}
