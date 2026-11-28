---
name: verify-my-cloudflare
description: Verify my-cloudflare's reader web UI and RSS endpoints with an isolated local Worker, Orca browser actions, and retained evidence. Use for reading-list navigation, article return positions, paragraph controls, saved-state prerequisites, and feed behavior.
---

# Verify my-cloudflare

Primary surface is the `/read` web reader. Secondary surfaces are public RSS, image proxies, and PIN-protected saved-state APIs. Read [features/README.md](features/README.md) and the relevant feature recipe before driving.

## Launch

Run from the repository root. Requirements are Node/npm, Python 3, `lsof`, Orca CLI, installed dependencies (`npm ci`), and a valid `NOTION_TOKEN` in the environment or ignored `.dev.vars`. The Notion integration must have access to the data sources/views in `wrangler.jsonc`, with at least one published article containing an ID and readable body. This is external seed data, not something the helper creates. Missing credentials, empty/inaccessible views, or upstream outages are startup failures; report them rather than substituting an empty screen.

```sh
VERIFY_SCRIPT="$PWD/.agents/skills/verify-my-cloudflare/scripts/verify.py"
VERIFY_EVIDENCE=$(mktemp -d /tmp/my-cloudflare-proof.XXXXXX)
python3 "$VERIFY_SCRIPT" launch --evidence "$VERIFY_EVIDENCE" --port 8799
```

The helper snapshots tracked working-tree files into its own temporary workspace, symlinks installed dependencies, uses a separate Vite cache, copies only `NOTION_TOKEN`, disables server Sentry, and runs:

```sh
npx wrangler d1 migrations apply HIGHLIGHTS_DB --local --config wrangler.jsonc
npm run dev -- --config vite.verify.config.ts --host 127.0.0.1 --port 8799 --strictPort
```

Those commands run **inside the temporary workspace**, not the user's checkout. The generated Vite config only sets its own dependency cache. All four D1 migrations run on an empty local database. No remote migration, deployment, secret update, or Notion seed write occurs. The baseline serves real Notion content; it is not an offline fixture.

Readiness is the helper's `healthy: true`, not Vite's log line. It requires usable `/api/read`, a nonempty article body from `/api/r/{code}`, and a signed-out `/api/session`. Record the returned code; do not hardcode a production article ID. Source revision and content digest are in `run.json` and `doctor.json`.

One long-lived instance is driven serially. Port conflicts fail before launch; use `--port 8800` for a second isolated run. Each run owns its workspace, local D1, Durable Object state, Vite cache, browser tab, and evidence directory. Do not drive or stop an existing port-8787 development instance. Untracked product files are not copied; track intended new source files before launch. Restart after source changes because this is a snapshot, not checkout HMR.

The baseline omits PIN/session, Instapaper, and AI credentials. Protected writes and paid AI calls cannot succeed. No Notion PATCH is issued by the baseline verification journeys. Confirm this through signed-out session state and captured action/network responses when testing denial; a mode name alone is not proof. Successful mutations require a separate disposable Notion sandbox and its credentials. Report those paths as unreachable in this baseline; never run a saved-state mutation against production content just to make a recipe pass.

## Doctor

Before the first drive, after any failed drive, and whenever the instance behaves unexpectedly:

```sh
python3 "$VERIFY_SCRIPT" doctor --evidence "$VERIFY_EVIDENCE"
```

This read-only check verifies process start identity, that all port listeners belong to the owned process group, the copied source digest, real list/article readability, list response cache headers, and signed-out status. It writes `doctor.json` without credentials. If the process is healthy but UI state is wedged, navigate the owned tab to `/read`; if still surprising, clean up and launch a fresh run. Do not continue driving stale refs or a failed instance.

## Drive

Use the installed `orca-cli` skill for the current CLI/browser guide. Commands below were proved with `orca` on this host; resolve the configured executable through that skill if different. Open a new task-owned tab and retain its `browserPageId` as `VERIFY_PAGE`; pass it to every subsequent command. Derive `VERIFY_BASE` from `doctor.json`.

```sh
VERIFY_BASE=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["base"])' "$VERIFY_EVIDENCE/doctor.json")
orca tab create --url "$VERIFY_BASE/read" --json > "$VERIFY_EVIDENCE/tab.json"
VERIFY_PAGE=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["result"]["browserPageId"])' "$VERIFY_EVIDENCE/tab.json")
orca viewport --page "$VERIFY_PAGE" --width 393 --height 844 --mobile --json
orca snapshot --page "$VERIFY_PAGE" --json > "$VERIFY_EVIDENCE/before.json"
```

Use the snapshot's refs for actual `click`, `fill`, and `scroll` commands. New snapshots supply new refs after navigation. Useful stable handles are `nav[aria-label="阅读分类"]`, `a.item-link[data-code]`, `.read-list`, `.reader-scroll`, `nav[aria-label="文章导航"]`, `#pin`, `[data-paragraph]`, and the tabs named `文章` / `段落` / `分享`. List window scrolling and article `.reader-scroll` scrolling are different. For a detail use `orca exec --page "$VERIFY_PAGE" --command "scroll down 500 --selector .reader-scroll" --json`; plain `orca scroll` targets the window and does not move this nested scroller. Inspect the correct offset after the action. Use `orca eval` for read-only geometry/visible-state assertions, not to set query caches, manufacture articles, authenticate, or dispatch synthetic app events as proof.

Touch gutter paging requires mobile viewport **and real browser touch input**. A mouse click or manually dispatched PointerEvent is not proof. Read the current browser guide for touch-capable controls; if the harness cannot generate the gesture, record that specific drive gap. Never silently substitute ordinary scrolling.

## Evidence

Store proof outside the checkout, in `VERIFY_EVIDENCE`. Keep launch/doctor logs plus, for each journey, the starting URL/state, action commands and their outputs, resulting URL/state, an ARIA snapshot, and a screenshot. Save `orca click/scroll` JSON outputs as the action record. `orca screenshot --page "$VERIFY_PAGE" --json` returns an artifact path; copy that actual PNG into the evidence directory before closing the tab. Use the returned path rather than assuming a screenshot flag. Inspect the copied PNG.

Assert the full user path. For list return, record the visible article identity and viewport offset before opening it, then both after browser Back or the visible `返回` link. A numeric offset alone can match while a different page's content is displayed. For mutations, verify a fresh read of the saved state and the corresponding local D1 row or sandbox Notion property. For feeds, capture status, content type, XML, and item links. Do not store cookies, CSRF tokens, PINs, API keys, or full authorization headers in evidence. Real article content can be private; keep artifacts local unless sharing them is explicitly requested.

A signed-out request can prove denial but cannot prove a successful save. Do not replace user paths with unit tests or private state setters. Mock only a deliberately isolated external service boundary; do not mock the app's own `/api/read` or `/api/r/` responses for a claimed UI proof. The baseline uses no mocks. It does not prove auth success, Notion writes, Instapaper, AI billing/results, cross-device sync, a fresh browser process restoring cached list data, or deployment behavior.

Write concise `notes.md` with feature IDs exercised, actions, observed results, and exact unreachable prerequisites/routes. A maintenance pass must cover every mapped feature or report the gap; this creation pass only needs one complete mapped feature.

## Cleanup

After the final drive, including every failed attempt's useful diagnostics, close **only** the task-owned browser tab, then stop the owned process group and remove its workspace:

```sh
orca tab close --page "$VERIFY_PAGE" --json
python3 "$VERIFY_SCRIPT" cleanup --evidence "$VERIFY_EVIDENCE"
```

Launch failures automatically run cleanup and retain logs. Cleanup validates process identity and never kills by process name. If the leader identity is lost while children remain, it refuses to signal and names the residue; inspect `run.json` and stop only the recorded run's children. Repeated cleanup is allowed. Do not remove the checkout's `.wrangler`, `.dev.vars`, other tabs, or other servers.

Finally check `run.json` says `stopped: true`, its workspace is absent, the chosen port is no longer listening, and the copied PNG, snapshots, action outputs, and `notes.md` still exist. Evidence survives cleanup.

## Helpers

The executable `scripts/verify.py` has three commands, all shown above: `launch`, `doctor`, and `cleanup`. `--evidence` is required; `launch --port` defaults to 8799. It uses only the Python standard library and repo-installed npm tools. No helper deploys or installs dependencies. Use `/maintain-verification-skill` to update this map as the app changes.
