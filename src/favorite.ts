export type FavoriteBindings = {
  FAVORITE_PIN?: string;
  FAVORITE_SESSION_SECRET?: string;
  FAVORITE_LOGIN_LIMIT?: { getByName(name: string): { attempt(): Promise<boolean> } };
};

type DocumentRenderer = (title: string, body: string) => string;
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const SESSION_COOKIE = "__Host-read-session";
const CSRF_COOKIE = "__Host-read-csrf";
const encoder = new TextEncoder();

function cookie(request: Request, name: string): string {
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return "";
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[a-f0-9]{64}$/.test(value)) return null;
  return Uint8Array.from(value.match(/../g)!, (part) => parseInt(part, 16));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function sign(key: CryptoKey, text: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(text)));
}

async function sessionValid(request: Request, key: CryptoKey, pin: string): Promise<boolean> {
  const [expiry, signature, ...extra] = cookie(request, SESSION_COOKIE).split(".");
  const signed = fromHex(signature || "");
  const now = Math.floor(Date.now() / 1000);
  if (extra.length || !expiry || !/^\d{10}$/.test(expiry) || !signed || Number(expiry) <= now || Number(expiry) > now + SESSION_SECONDS) return false;
  return crypto.subtle.verify("HMAC", key, signed, encoder.encode(`session:${expiry}:${pin}`));
}

function response(render: DocumentRenderer, body: string, status = 200, cookies: string[] = [], nonce = ""): Response {
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; ${nonce ? `script-src 'nonce-${nonce}'; ` : ""}form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  });
  for (const value of cookies) headers.append("Set-Cookie", value);
  return new Response(render("收藏", body), { status, headers });
}

function backLink(code: string, query: string): string {
  return `<p><a class="btn" href="/read/d/${code}${query}">返回文章</a></p>`;
}

function form(code: string, query: string, token: string, authenticated: boolean, error = ""): string {
  return [
    "<h1>收藏</h1>",
    error ? `<p role="alert">${error}</p>` : "",
    `<form id="favorite-form" method="post" action="/read/favorite/${code}${query}">`,
    `<input type="hidden" name="csrf" value="${token}" />`,
    authenticated ? "<p>正在收藏…</p>" : '<p><label for="pin">请输入 6 位密码</label></p><p><input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="current-password" pattern="[0-9]{6}" minlength="6" maxlength="6" required /></p>',
    '<button type="submit" class="btn">收藏</button>',
    "</form>",
    authenticated ? `<script nonce="${token}">document.getElementById('favorite-form').submit();</script>` : "",
    backLink(code, query),
    '<style>input#pin{font:1.25rem/1.75 monospace;letter-spacing:1.25rem;width:12rem;max-width:100%;min-height:3rem;padding:0.5rem 0 0.5rem 0.625rem;border:2px solid #000;border-radius:0;background:#fff;background-image:linear-gradient(to right,transparent calc(100% - 2px),#000 0);background-size:calc(100% / 6) 100%;color:#000}input#pin:focus-visible{outline:3px solid #000;outline-offset:3px}form .btn{font:inherit;font-weight:700;color:inherit;background:#fff;cursor:pointer;width:100%}</style>',
  ].join("\n");
}

async function readForm(request: Request): Promise<URLSearchParams | null> {
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/x-www-form-urlencoded")) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4096) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new URLSearchParams(new TextDecoder().decode(bytes));
}

export async function favoriteRequest(
  request: Request,
  env: FavoriteBindings,
  code: string,
  favorite: () => Promise<boolean>,
  render: DocumentRenderer,
): Promise<Response> {
  const url = new URL(request.url);
  const params = new URLSearchParams();
  const tab = url.searchParams.get("tab");
  const page = url.searchParams.get("page");
  if (tab && ["likes", "later", "news", "weekly", "bunshun", "novel"].includes(tab)) params.set("tab", tab);
  if (page && /^[1-9]\d{0,2}$/.test(page) && page !== "1") params.set("page", page);
  const query = params.size ? `?${params.toString().replaceAll("&", "&amp;")}` : "";
  if (request.method !== "GET" && request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST", "Cache-Control": "no-store" } });
  if (!env.FAVORITE_PIN || !/^\d{6}$/.test(env.FAVORITE_PIN) || !env.FAVORITE_SESSION_SECRET || env.FAVORITE_SESSION_SECRET.length < 32 || !env.FAVORITE_LOGIN_LIMIT) {
    return response(render, `<h1>收藏暂不可用</h1><p>请先完成配置。</p>${backLink(code, query)}`, 503);
  }
  const key = await hmacKey(env.FAVORITE_SESSION_SECRET);
  const authenticated = await sessionValid(request, key, env.FAVORITE_PIN);
  if (request.method === "GET") {
    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    return response(render, form(code, query, token, authenticated), 200, [`${CSRF_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict`], authenticated ? token : "");
  }
  if (request.headers.get("Origin") !== new URL(request.url).origin) return response(render, `<h1>请求无效</h1>${backLink(code, query)}`, 403);
  const data = await readForm(request);
  const token = data?.get("csrf") || "";
  const cookieToken = cookie(request, CSRF_COOKIE);
  const signature = fromHex(cookieToken);
  if (!signature || !fromHex(token) || !await crypto.subtle.verify("HMAC", key, await sign(key, `csrf:${cookieToken}`), encoder.encode(`csrf:${token}`))) {
    return response(render, `<h1>页面已过期</h1><p>请返回文章后重试。</p>${backLink(code, query)}`, 403);
  }
  if (!authenticated) {
    const pin = data?.get("pin") || "";
    if (!/^\d{6}$/.test(pin)) return response(render, form(code, query, token, false, "请输入 6 位数字。"), 400);
    try {
      if (!await env.FAVORITE_LOGIN_LIMIT.getByName("favorite-pin").attempt()) {
        return response(render, form(code, query, token, false, "尝试次数过多，请稍后再试。"), 429);
      }
    } catch {
      return response(render, `<h1>收藏暂不可用</h1><p>请稍后再试。</p>${backLink(code, query)}`, 503);
    }
    if (!await crypto.subtle.verify("HMAC", key, await sign(key, `pin:${env.FAVORITE_PIN}`), encoder.encode(`pin:${pin}`))) {
      return response(render, form(code, query, token, false, "密码不正确。"), 401);
    }
  }
  try {
    if (!await favorite()) return response(render, `<h1>未找到文章</h1>${backLink(code, query)}`, 404);
    const expiry = String(Math.floor(Date.now() / 1000) + SESSION_SECONDS);
    const session = `${expiry}.${hex(await sign(key, `session:${expiry}:${env.FAVORITE_PIN}`))}`;
    return response(render, `<h1>已收藏</h1>${backLink(code, query)}`, 200, [`${SESSION_COOKIE}=${session}; Path=/; Max-Age=${SESSION_SECONDS}; Secure; HttpOnly; SameSite=Strict`]);
  } catch {
    return response(render, `<h1>收藏失败</h1><p>请稍后再试。</p>${backLink(code, query)}`, 502);
  }
}
