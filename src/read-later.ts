type InstapaperBindings = {
  INSTAPAPER_CONSUMER_ID?: string;
  INSTAPAPER_CONSUMER_SECRET?: string;
  INSTAPAPER_OAUTH_TOKEN?: string;
  INSTAPAPER_OAUTH_TOKEN_SECRET?: string;
};

type Bookmark = {
  type: string;
  bookmark_id: number;
  title: string;
  url: string;
  description: string;
  time: number;
};

const ENDPOINT = "https://www.instapaper.com/api/1/bookmarks/list";

function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

async function authorization(env: Required<InstapaperBindings>, body: Record<string, string>): Promise<string> {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const oauth: Record<string, string> = {
    oauth_consumer_key: env.INSTAPAPER_CONSUMER_ID,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: env.INSTAPAPER_OAUTH_TOKEN,
    oauth_version: "1.0",
  };
  const parameters = Object.entries({ ...oauth, ...body })
    .map(([key, value]) => [encode(key), encode(value)] as const)
    .sort(([a, av], [b, bv]) => a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join("&");
  const base = `POST&${encode(ENDPOINT)}&${encode(parameters)}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`${encode(env.INSTAPAPER_CONSUMER_SECRET)}&${encode(env.INSTAPAPER_OAUTH_TOKEN_SECRET)}`), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(base));
  oauth.oauth_signature = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return `OAuth ${Object.entries(oauth).map(([key, value]) => `${encode(key)}="${encode(value)}"`).join(", ")}`;
}

export async function readLaterFeed(request: Request, env: InstapaperBindings): Promise<Response> {
  const { INSTAPAPER_CONSUMER_ID, INSTAPAPER_CONSUMER_SECRET, INSTAPAPER_OAUTH_TOKEN, INSTAPAPER_OAUTH_TOKEN_SECRET } = env;
  if (!INSTAPAPER_CONSUMER_ID || !INSTAPAPER_CONSUMER_SECRET || !INSTAPAPER_OAUTH_TOKEN || !INSTAPAPER_OAUTH_TOKEN_SECRET) {
    return new Response("Instapaper feed is not configured", { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  const url = new URL(request.url);
  const body = { limit: url.searchParams.get("limit") || "25", folder_id: url.searchParams.get("folder_id") || "unread" };
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: await authorization({ INSTAPAPER_CONSUMER_ID, INSTAPAPER_CONSUMER_SECRET, INSTAPAPER_OAUTH_TOKEN, INSTAPAPER_OAUTH_TOKEN_SECRET }, body),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body),
    });
    if (!response.ok) throw new Error(`Instapaper returned ${response.status}`);
    const data = await response.json() as Bookmark[];
    const items = data.filter((item) => item.type === "bookmark").map((item) => `    <item>
      <title>${escapeXml(item.title || "Untitled")}</title>
      <link>${escapeXml(item.url)}</link>
      <description>${escapeXml(item.description || "")}</description>
      <pubDate>${new Date(item.time * 1000).toUTCString()}</pubDate>
      <guid isPermaLink="false">${item.bookmark_id}</guid>
    </item>`).join("\n");
    const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Instapaper</title>
    <link>https://www.instapaper.com</link>
    <description>My Instapaper bookmarks feed</description>
${items}
  </channel>
</rss>`;
    return new Response(request.method === "HEAD" ? null : feed, { headers: { "Content-Type": "application/rss+xml; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (error) {
    console.error("Failed to build Instapaper RSS", error);
    return new Response("Feed temporarily unavailable", { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
