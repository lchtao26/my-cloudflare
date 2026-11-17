import assert from "node:assert/strict";
import test from "node:test";
import { withScope, type Event } from "@sentry/core";
import { ServerRuntimeClient } from "@sentry/core/server";
import worker from "../src/index.ts";
import { readLaterFeed } from "../src/read-later.ts";
import { sentryDataCollection } from "../src/sentry-options.ts";

test("handled upstream failures reach Sentry while ordinary 4xx responses do not", async t => {
  const events: Event[] = [];
  const client = new ServerRuntimeClient({
    dsn: "https://public@example.invalid/1",
    integrations: [],
    stackParser: () => [],
    dataCollection: sentryDataCollection,
    transport: () => ({ send: async () => ({ statusCode: 200 }), flush: async () => true }),
    beforeSend: event => { events.push(event); return event; },
  });
  client.init();
  t.after(() => client.close());
  t.mock.method(globalThis, "fetch", async () => new Response("unavailable", { status: 503 }));
  t.mock.method(console, "error", () => {});

  await withScope(async scope => {
    scope.setClient(client);
    const feed = await worker.fetch(new Request("https://example.com/book.xml"), {
      NOTION_TOKEN: "test-token", NOTION_DATA_SOURCE_ID: "source",
    });
    assert.equal(feed.status, 502);
    const later = await readLaterFeed(new Request("https://example.com/read/later.xml"), {
      INSTAPAPER_CONSUMER_ID: "id", INSTAPAPER_CONSUMER_SECRET: "secret",
      INSTAPAPER_OAUTH_TOKEN: "token", INSTAPAPER_OAUTH_TOKEN_SECRET: "secret",
    });
    assert.equal(later.status, 502);
    await client.flush();
    assert.deepEqual(events.map(event => event.exception?.values?.[0]?.value), [
      "Notion API returned 503", "Instapaper returned 503",
    ]);
    assert.ok(!JSON.stringify(events).includes("test-token"));

    const missing = await worker.fetch(new Request("https://example.com/missing"), {});
    const invalid = await worker.fetch(new Request("https://example.com/read/highlight/invalid"), {});
    assert.equal(missing.status, 404);
    assert.equal(invalid.status, 404);
    await client.flush();
    assert.equal(events.length, 2);
  });
});
