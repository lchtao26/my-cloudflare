import { favoriteRequest, isReadAuthorized, PIN_FIELD, pinFormScript, type FavoriteBindings } from "./favorite.ts";
import { EINK_STYLE } from "./style.ts";

export async function protectRead(request: Request, env: FavoriteBindings): Promise<Response | null> {
  const url = new URL(request.url);
  if (!/^\/(?:read\/?|r\/[A-Za-z0-9]{6}\/?|api\/read\/?|api\/r\/[A-Za-z0-9]{6}\/?|api\/progress\/[A-Za-z0-9]{6})$/.test(url.pathname)) return null;
  if (await isReadAuthorized(request, env)) return null;
  if (url.pathname.startsWith("/api/")) return Response.json({ error: "请先授权。" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  const login = new URL("/auth", url.origin);
  login.searchParams.set("next", url.pathname + url.search);
  return new Response(null, { status: 302, headers: { Location: login.toString(), "Cache-Control": "no-store" } });
}

function destination(url: URL): string {
  const value = url.searchParams.get("next") || "/read";
  try {
    const target = new URL(value, url.origin);
    if (target.origin === url.origin && (/^\/read\/?$/.test(target.pathname) || /^\/r\/[A-Za-z0-9]{6}\/?$/.test(target.pathname))) {
      return target.pathname + target.search + target.hash;
    }
  } catch {
    /* Use the list if the destination is invalid. */
  }
  return "/read";
}

export async function readLogin(request: Request, env: FavoriteBindings): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
  const url = new URL(request.url);
  const next = destination(url);
  if (request.method === "GET" && (await isReadAuthorized(request, env))) return Response.redirect(new URL(next, url.origin), 303);
  const headers = new Headers(request.headers);
  headers.set("Accept", "application/json");
  let error = "";
  let status = 200;
  if (request.method === "POST") {
    const result = await favoriteRequest(
      new Request(request, { headers }),
      env,
      "000000",
      async () => ({ verified: true }),
      () => "",
    );
    if (result.ok) {
      const responseHeaders = new Headers({ Location: next, "Cache-Control": "no-store" });
      const session = result.headers.get("Set-Cookie");
      if (session) responseHeaders.append("Set-Cookie", session);
      return new Response(null, { status: 303, headers: responseHeaders });
    }
    status = result.status;
    const body: { error?: string } = await result.json<{ error?: string }>().catch(() => ({}));
    error = body.error || "验证失败，请重试。";
  }
  const tokenResponse = await favoriteRequest(
    new Request(request.url, { method: "GET", headers }),
    env,
    "000000",
    async () => true,
    () => "",
  );
  if (!tokenResponse.ok) return new Response("授权服务暂不可用，请稍后再试。", { status: 503, headers: { "Cache-Control": "no-store" } });
  const { csrf } = await tokenResponse.json<{ csrf: string }>();
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const responseHeaders = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  });
  const csrfCookie = tokenResponse.headers.get("Set-Cookie");
  if (csrfCookie) responseHeaders.append("Set-Cookie", csrfCookie);
  const pinField = error ? PIN_FIELD.replace('id="pin"', 'id="pin" aria-invalid="true" aria-describedby="auth-error"') : PIN_FIELD;
  return new Response(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>阅读授权</title><style>${EINK_STYLE}body{min-height:100vh;min-height:100dvh;display:flex;flex-direction:column}main{width:100%;max-width:24rem;margin:auto;text-align:center}#auth-form .btn{width:100%;font:inherit;font-weight:700;cursor:pointer}#auth-form .pin-enhanced ~ .btn{display:none}</style></head><body><main><form id="auth-form" method="post" action="/auth?next=${encodeURIComponent(next)}"><input type="hidden" name="csrf" value="${escape(csrf)}">${pinField}${error ? `<p id="auth-error" role="alert">${escape(error)}</p>` : ""}<button class="btn" type="submit">进入阅读</button></form></main><script nonce="${nonce}">${pinFormScript("auth-form")}</script></body></html>`,
    { status, headers: responseHeaders },
  );
}
