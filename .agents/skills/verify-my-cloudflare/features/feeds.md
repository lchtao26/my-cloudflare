# RSS and images

Subscribers read book recommendations, excerpt links, and Instapaper bookmarks in RSS readers; image proxies keep published image URLs stable.

## Sub-features

- `books-rss`: `/book.xml` includes book metadata and optional cover proxy links.
- `excerpts-rss`: `/read.xml` includes titles and normal article links with optional first-image previews and without embedded article prose.
- `instapaper-rss`: `/read/later.xml` exposes the configured bookmark folder and limit.
- `image-proxies`: `/book/p/{pageId}` and `/read/p/{pageId}/{blockId}` return image bytes.

## How to get to it (user POV)

Subscribe using the feed URL, open an item link in the browser, and load images referenced in rendered content. Instapaper supports `limit` and `folder_id` URL parameters. Feed URLs are public even while reading progress is protected.

## Driving it with Orca and HTTP

Preconditions:

- Doctor passes. Book journeys require accessible populated book data; covers/images need actual seeded files. Instapaper requires four sandbox credentials omitted from baseline.

- **Excerpt feed.** Run `curl --fail --silent --show-error --dump-header "$VERIFY_EVIDENCE/read-feed.headers" "$VERIFY_BASE/read.xml" --output "$VERIFY_EVIDENCE/read-feed.xml"`. Parse XML using Python `xml.etree.ElementTree`; require an RSS channel and at least one item with title, GUID, `/r/` link, and no embedded article prose. A description may contain exactly one image preview; parse it as an image element and verify its URL. Open an actual item URL in the owned browser using `orca goto`, snapshot, and require its article title/body.
- **Book feed.** Capture `/book.xml` using the same curl pattern with separate files. Require title/link/GUID and description metadata. Check the seed's author/summary/source and optional proxied cover. Do not demand cover markup for a coverless seed.
- **Images.** Extract an actual proxy path from a feed/detail and GET it with curl, saving headers and binary. Require successful image Content-Type and decodable pixels. A rendered broken-image icon is failure. No seeded image means this journey remains unreachable; do not invent a page or block ID.
- **Instapaper.** In a configured sandbox capture `/read/later.xml?limit=25` and another supported folder URL, require bookmark title/link and requested scope. The baseline should record the missing-configuration response as unreachable, not a successful empty feed.

## Gotchas

- Feeds, images, and signed-out public list/article data can cache for five minutes; personalized data and mutations use no-store. Capture headers instead of inferring freshness from a changed UI.
- Old `/book/rss` and `/read/{code}` routes are not supported entry points.
- Feed/cache requests may contact upstream services. This is a real read path, not an offline/dry-run guarantee.
- Never publish private Instapaper feed bodies or credentials as evidence.
