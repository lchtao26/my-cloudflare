import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { parseRssFeed } from "feedsmith";
import worker from "../src/index.ts";

const env = {
  INSTAPAPER_CONSUMER_ID: "consumer",
  INSTAPAPER_CONSUMER_SECRET: "consumer secret",
  INSTAPAPER_OAUTH_TOKEN: "token",
  INSTAPAPER_OAUTH_TOKEN_SECRET: "token secret",
};

test("read-later feed signs the Instapaper request and renders bookmarks", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(url), "https://www.instapaper.com/api/1/bookmarks/list");
    assert.equal(init?.method, "POST");
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get("limit"), "7");
    assert.equal(body.get("folder_id"), "starred");
    const header = new Headers(init?.headers).get("authorization")!;
    const fields = Object.fromEntries([...header.matchAll(/(oauth_\w+)="([^"]*)"/g)].map((match) => [match[1]!, decodeURIComponent(match[2]!)]));
    const signature = fields.oauth_signature;
    delete fields.oauth_signature;
    const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
    const params = [...Object.entries(fields), ...body.entries()].map(([key, value]) => [encode(key), encode(value)] as const).sort(([a, av], [b, bv]) => a.localeCompare(b, "en") || av.localeCompare(bv, "en")).map(([key, value]) => `${key}=${value}`).join("&");
    const base = `POST&${encode(String(url))}&${encode(params)}`;
    assert.equal(signature, createHmac("sha1", "consumer%20secret&token%20secret").update(base).digest("base64"));
    return Response.json([{ type: "meta" }, { type: "bookmark", bookmark_id: 42, title: "A & B", url: "https://example.com/?x=1&y=2", description: "<hello>", time: 1700000000 }]);
  }) as typeof fetch;
  const response = await worker.fetch(new Request("https://chui.dev/read/later.xml?limit=7&folder_id=starred"), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const xml = await response.text();
  assert.match(xml, /A &amp; B/);
  assert.match(xml, /&lt;hello&gt;/);
  const feed = parseRssFeed(xml);
  assert.equal(feed.items?.length, 1);
  assert.equal(feed.items?.[0]?.guid?.value, "42");
  const head = await worker.fetch(new Request("https://chui.dev/read/later.xml?limit=7&folder_id=starred", { method: "HEAD" }), env);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const alias = await worker.fetch(new Request("https://chui.dev/r/later.xml?limit=7&folder_id=starred"), env);
  assert.equal(alias.status, 200);
  assert.equal(await alias.text(), xml);
});

test("read-later feed handles missing credentials and unsupported methods", async () => {
  const missing = await worker.fetch(new Request("https://chui.dev/read/later.xml"), {});
  assert.equal(missing.status, 503);
  const method = await worker.fetch(new Request("https://chui.dev/read/later.xml", { method: "POST" }), env);
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("allow"), "GET, HEAD");
});

test("the former RSS paths no longer match", async () => {
  for (const path of ["/read/rss", "/read/later/rss"]) {
    const response = await worker.fetch(new Request(`https://chui.dev${path}`), env);
    assert.equal(response.status, 404);
  }
});
