import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, HeadContent, Outlet, Scripts, useLocation } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
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
      <ReadLoginBanner />
    </QueryClientProvider>
  );
}

function useReadSession(active: boolean) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void fetch("/api/session", { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error("无法确认登录状态");
        return response.json() as Promise<{ authenticated?: boolean }>;
      })
      .then(data => {
        if (!controller.signal.aborted) setAuthenticated(data.authenticated === true);
      })
      .catch(() => {
        if (!controller.signal.aborted) setAuthenticated(null);
      });
    return () => controller.abort();
  }, [active]);
  return [authenticated, setAuthenticated] as const;
}

function ReadBar() {
  const pathname = useLocation({ select: location => location.pathname });
  const search = useLocation({ select: location => location.searchStr });
  const active = /^\/read\/?$/.test(pathname);
  const [authenticated, setAuthenticated] = useReadSession(active);
  if (!active) return null;
  const next = pathname + search;
  return (
    <header className="read-bar">
      <div className="read-bar-side" />
      <p className="read-bar-title">Read</p>
      <div className="read-bar-side">
        {authenticated === true ? (
          <button
            type="button"
            onClick={() => {
              void fetch("/api/session", { method: "POST", credentials: "same-origin", cache: "no-store" }).then(response => {
                if (response.ok) setAuthenticated(false);
              });
            }}
          >
            登出
          </button>
        ) : authenticated === false ? (
          <a href={`/auth?next=${encodeURIComponent(next)}`}>登录</a>
        ) : null}
      </div>
    </header>
  );
}

function ReadLoginBanner() {
  const pathname = useLocation({ select: location => location.pathname });
  const search = useLocation({ select: location => location.searchStr });
  const hash = useLocation({ select: location => location.hash });
  const active = /^\/r\/[A-Za-z0-9]{6}\/?$/.test(pathname);
  const [authenticated] = useReadSession(active);
  if (!active || authenticated !== false) return null;
  const next = pathname + search + hash;
  return (
    <div className="login-banner" role="region" aria-label="登录">
      <span>请登录</span>
      <a href={`/auth?next=${encodeURIComponent(next)}`}>登录</a>
    </div>
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
