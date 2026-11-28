# List navigation

Readers browse categories, load subsequent items, open an article, and return to the same place in the originating list.

## Sub-features

- `list-categories`: 全部、周刊、文春、小说、IT、收藏、划线、稍后阅读.
- `list-pages`: subsequent articles load near the list end; highlights accumulate pages.
- `list-return`: browser Back and visible article 返回 preserve list identity and position, including after a long article visit.
- `list-gutters`: on touch devices, right/left outer whitespace moves down/up with overlapping visible content.
- `list-refresh`: pulling down at the top refreshes the active category.

## How to get to it (user POV)

Open `/read`, select a category from 阅读分类, or use an article's 返回 link. Direct category/page URLs such as `/read?tab=weekly` and `/read?page=2` are also entry points. 收藏 uses `tab=likes`; 划线 uses `tab=highlights`.

## Driving it with Orca

Preconditions:

- Parent skill doctor passes. At least one category has enough articles for scrolling; pagination needs more than one upstream page. Highlights need saved rows in a sandbox.
- Use a new owned tab. For each entry point, preserve before/after snapshots and action JSON.

- **Browse.** Run `orca goto --page "$VERIFY_PAGE" --url "$VERIFY_BASE/read" --json`, then `orca snapshot --page "$VERIFY_PAGE" --json`. Click the snapshot ref named 周刊 using `orca click --page "$VERIFY_PAGE" --element <snapshot-ref> --json`. Require the category URL and selected `aria-current=page`; record a visible title. Repeat the other category entries with their actual content preconditions.
- **Load more.** Run `orca scroll --page "$VERIFY_PAGE" --direction down --amount 600 --json` until the next page is requested. Record `a.item-link` titles and hrefs before/after. Article lists show the latest loaded page; highlight lists retain preceding pages. Do not assert that all article pages are appended.
- **Open and return.** In a scrolled list, record window offset and an item title plus its viewport position with read-only `orca eval`. Click that visible item's fresh ref. Require `/r/` detail and readable body, then `orca back --page "$VERIFY_PAGE" --json`. Snapshot again; require the same category, item, and viewport position. Repeat through the detail's visible 返回 link, including an item loaded from a later page. Avoid clicking a newly prefetched different article by stale ref.
- **Long visit.** Repeat the preceding journey after more than five minutes in detail. Record timestamps and retain the source list tab/session. A unit clock override is diagnostic only; do not label it an actual long-duration browser run.
- **Touch page.** Set `orca viewport --page "$VERIFY_PAGE" --width 393 --height 844 --mobile --json` after each navigation. Use real browser touch input, from the current Orca guide, on right outer whitespace, then left. Record a bottom-visible line before and its top visibility after paging down; the reverse action should reconnect. If real touch input is unavailable, report a harness gap rather than synthetic success.
- **Refresh.** Use a real downward touch drag starting at the top of the list. Require refresh status then settled content for the same category. Browser reload does not prove pull-to-refresh.

## Gotchas

- List scroll belongs to `window`; detail scroll belongs to `.reader-scroll`. Measure the visible item as well as the offset.
- Later-page article URLs carry article page context separately from the originating list. Returning must not switch to a new initial-page query.
- A native browser Back and a visible 返回 link are both required paths.
- No highlight seeds exist in the default fresh D1. Do not mark highlighted-list pagination verified without creating sandbox highlights first.
- Retention is for the live app session. Full reload/tab eviction and live upstream content reorder are separate scenarios.
