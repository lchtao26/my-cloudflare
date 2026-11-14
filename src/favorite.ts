export type FavoriteBindings = {
  FAVORITE_PIN?: string;
  FAVORITE_SESSION_SECRET?: string;
  FAVORITE_LOGIN_LIMIT?: { getByName(name: string): { attempt(): Promise<boolean> } };
};

type DocumentRenderer = (title: string, body: string) => string;
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const SESSION_COOKIE = "__Host-read-session";
const CSRF_COOKIE = "__Host-read-csrf";
const LOCAL_SESSION_COOKIE = "read-session";
const LOCAL_CSRF_COOKIE = "read-csrf";
const encoder = new TextEncoder();

function cookieNames(request: Request): { session: string; csrf: string; secure: string } {
  const secure = new URL(request.url).protocol === "https:";
  return secure
    ? { session: SESSION_COOKIE, csrf: CSRF_COOKIE, secure: "; Secure" }
    : { session: LOCAL_SESSION_COOKIE, csrf: LOCAL_CSRF_COOKIE, secure: "" };
}

export const PIN_FIELD = '<p><label for="pin">请输入 6 位密码</label></p><div class="pin-wrap"><input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="current-password" pattern="[0-9]{6}" minlength="6" maxlength="6" required /><div class="pin-slots" aria-hidden="true"><span class="active"></span><span></span><span></span><span></span><span></span><span></span></div></div>';
export const PIN_STYLE = '.pin-wrap{position:relative}input#pin{box-sizing:border-box;display:block;font:1.25rem/1.75 monospace;width:100%;min-height:3rem;padding:0.5rem;border:2px solid #000;border-radius:0;background:#fff;color:#000}input#pin:focus-visible{outline:3px solid #000;outline-offset:3px}.pin-slots{display:none}.pin-enhanced input#pin{position:absolute;inset:0;z-index:1;height:100%;opacity:0}.pin-enhanced .pin-slots{display:flex;height:3rem;pointer-events:none}.pin-slots span{display:flex;align-items:center;justify-content:center;flex:1;min-width:0;border:2px solid #000}.pin-slots span+span{margin-left:0.5rem}.pin-slots span.filled::after{content:"";display:block;width:0.5rem;height:0.5rem;border-radius:50%;background:#000}.pin-enhanced input#pin:focus-visible + .pin-slots span.active{outline:2px solid #000;outline-offset:2px}@media (forced-colors:active){.pin-enhanced input#pin{position:static;opacity:1}.pin-enhanced .pin-slots{display:none}}';

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
  const [expiry, signature, ...extra] = cookie(request, cookieNames(request).session).split(".");
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
  return `<p><a class="btn" href="/r/${code}${query}">返回文章</a></p>`;
}

function form(code: string, query: string, token: string, authenticated: boolean, error = "", desired = true): string {
  return [
    error ? `<p role="alert">${error}</p>` : "",
    `<form id="favorite-form" method="post" action="/read/favorite/${code}${query}">`,
    `<input type="hidden" name="csrf" value="${token}" />`,
    authenticated ? `<p>${desired ? "正在收藏…" : "正在取消收藏…"}</p>` : PIN_FIELD,
    `<noscript><button type="submit" class="btn">${desired ? "收藏" : "取消收藏"}</button></noscript>`,
    "</form>",
    `<script nonce="${token}">(function(){var form=document.getElementById('favorite-form');var pin=document.getElementById('pin');if(!pin){form.submit();return}var slots=pin.nextElementSibling.children;var submitted=false;function mark(){var active=Math.min(pin.selectionStart||0,5);for(var i=0;i<slots.length;i++){slots[i].classList.toggle('active',i===active);slots[i].classList.toggle('filled',i<pin.value.length)}}function check(e){mark();if(!submitted&&!(e&&e.isComposing)&&/^[0-9]{6}$/.test(pin.value)){submitted=true;form.submit()}}pin.addEventListener('focus',mark);pin.addEventListener('click',mark);pin.addEventListener('keyup',mark);pin.addEventListener('select',mark);pin.addEventListener('input',check);pin.addEventListener('change',check);pin.addEventListener('compositionend',check);mark();pin.parentElement.classList.add('pin-enhanced')})();</script>`,
    `<style>body{padding-top:28vh}${PIN_STYLE}form .btn{font:inherit;font-weight:700;color:inherit;background:#fff;cursor:pointer;width:100%}</style>`,
  ].join("\n");
}

async function readForm(request: Request, maxBytes = 4096): Promise<URLSearchParams | null> {
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/x-www-form-urlencoded")) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); return null; }
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
  favorite: (desired: boolean, data: URLSearchParams) => Promise<boolean | Record<string, unknown>>,
  render: DocumentRenderer,
  options: { maxBytes?: number; errorMessage?: string } = {},
): Promise<Response> {
  const url = new URL(request.url);
  const params = new URLSearchParams();
  const tab = url.searchParams.get("tab");
  const page = url.searchParams.get("page");
  const requested = url.searchParams.get("favorite");
  if (tab && ["likes", "highlights", "later", "news", "weekly", "bunshun", "novel"].includes(tab)) params.set("tab", tab);
  if (page && /^[1-9]\d{0,2}$/.test(page) && page !== "1") params.set("page", page);
  const returnQuery = params.size ? `?${params.toString().replaceAll("&", "&amp;")}` : "";
  if (requested === "0" || requested === "1") params.set("favorite", requested);
  const query = params.size ? `?${params.toString().replaceAll("&", "&amp;")}` : "";
  const json = request.headers.get("Accept")?.includes("application/json") ?? false;
  function reply(body: string, status = 200, cookies: string[] = [], nonce = "", data: object = {}): Response {
    if (!json) return response(render, body, status, cookies, nonce);
    const headers = new Headers({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    for (const value of cookies) headers.append("Set-Cookie", value);
    return Response.json(data, { status, headers });
  }
  if (request.method !== "GET" && request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST", "Cache-Control": "no-store" } });
  if (!env.FAVORITE_PIN || !/^\d{6}$/.test(env.FAVORITE_PIN) || !env.FAVORITE_SESSION_SECRET || env.FAVORITE_SESSION_SECRET.length < 32 || !env.FAVORITE_LOGIN_LIMIT) {
    return reply(`<h1>收藏暂不可用</h1><p>请先完成配置。</p>${backLink(code, returnQuery)}`, 503, [], "", { error: "收藏暂不可用，请先完成配置。" });
  }
  const key = await hmacKey(env.FAVORITE_SESSION_SECRET);
  const authenticated = await sessionValid(request, key, env.FAVORITE_PIN);
  if (request.method === "GET") {
    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    const names = cookieNames(request);
    return reply(form(code, query, token, authenticated, "", requested !== "0"), 200, [`${names.csrf}=${token}; Path=/${names.secure}; HttpOnly; SameSite=Strict`], token, { authenticated, csrf: token });
  }
  if (request.headers.get("Origin") !== new URL(request.url).origin) return reply(`<h1>请求无效</h1>${backLink(code, returnQuery)}`, 403, [], "", { error: "请求无效，请重试。" });
  const data = await readForm(request, options.maxBytes);
  const token = data?.get("csrf") || "";
  const cookieToken = cookie(request, cookieNames(request).csrf);
  const signature = fromHex(cookieToken);
  if (!signature || !fromHex(token) || !await crypto.subtle.verify("HMAC", key, await sign(key, `csrf:${cookieToken}`), encoder.encode(`csrf:${token}`))) {
    return reply(`<h1>页面已过期</h1><p>请返回文章后重试。</p>${backLink(code, returnQuery)}`, 403, [], "", { error: "验证已过期，请重试。" });
  }
  const target = data?.get("favorite") ?? requested ?? "1";
  if (target !== "0" && target !== "1") return reply("<h1>请求无效</h1>", 400, [], "", { error: "请求无效，请重试。" });
  const desired = target === "1";
  if (!authenticated) {
    const pin = data?.get("pin") || "";
    if (json && !pin) return reply("", 401, [], "", { requiresPin: true });
    if (!/^\d{6}$/.test(pin)) return reply(form(code, query, token, false, "请输入 6 位数字。", desired), 400, [], token, { error: "请输入 6 位数字。" });
    try {
      if (!await env.FAVORITE_LOGIN_LIMIT.getByName("favorite-pin").attempt()) {
        return reply(form(code, query, token, false, "尝试次数过多，请稍后再试。", desired), 429, [], token, { error: "尝试次数过多，请稍后再试。" });
      }
    } catch {
      return reply(`<h1>收藏暂不可用</h1><p>请稍后再试。</p>${backLink(code, returnQuery)}`, 503, [], "", { error: "收藏暂不可用，请稍后再试。" });
    }
    if (!await crypto.subtle.verify("HMAC", key, await sign(key, `pin:${env.FAVORITE_PIN}`), encoder.encode(`pin:${pin}`))) {
      return reply(form(code, query, token, false, "密码不正确。", desired), 401, [], token, { error: "密码不正确。", requiresPin: true });
    }
  }
  try {
    const result = await favorite(desired, data!);
    if (!result) return reply(`<h1>未找到文章</h1>${backLink(code, returnQuery)}`, 404, [], "", { error: "未找到文章。" });
    const expiry = String(Math.floor(Date.now() / 1000) + SESSION_SECONDS);
    const session = `${expiry}.${hex(await sign(key, `session:${expiry}:${env.FAVORITE_PIN}`))}`;
    const names = cookieNames(request);
    return reply(`<h1>${desired ? "已收藏" : "已取消收藏"}</h1>${backLink(code, returnQuery)}`, 200, [`${names.session}=${session}; Path=/; Max-Age=${SESSION_SECONDS}${names.secure}; HttpOnly; SameSite=Strict`], "", { ok: true, favorite: desired, ...(typeof result === "object" ? result : {}) });
  } catch (error) {
    if (error instanceof Response) return error;
    return reply(`<h1>收藏失败</h1><p>请稍后再试。</p>${backLink(code, returnQuery)}`, 502, [], "", { error: options.errorMessage || "收藏失败，请稍后再试。" });
  }
}
