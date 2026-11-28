# Article reading and sharing

Readers open full articles, switch available original text, resume local progress, navigate related articles, and read a public share without private controls.

## Sub-features

- `article-body`: title, author/source metadata, paragraphs, images, and available terminology.
- `article-original`: display original text when supplied alongside translation.
- `article-local-progress`: leave and reopen a normal detail to resume locally.
- `article-navigation`: previous/next article and return to source list.
- `article-share`: share link and public `/s/{code}` view.

## How to get to it (user POV)

Click a list article, open `/r/{code}` directly using a code returned by doctor, or open its `/s/{code}` share address. Normal details expose article navigation; shared details omit private actions and progress.

## Driving it with Orca

Preconditions:

- Doctor passes and its `article_code` has nonempty body. Original-text switching needs an article with both versions. Images/terms need suitable upstream seed content.

- **Read detail.** From `/read`, snapshot, click a visible title's ref and require its heading and body on `/r/`. Run `orca screenshot --page "$VERIFY_PAGE" --json`; copy and inspect the PNG. Use `orca snapshot --page "$VERIFY_PAGE" --json` to save metadata and text evidence. No horizontal clipping should appear at 393px.
- **Controls.** Click a paragraph once using its snapshot ref. Snapshot the resulting tabs and controls; click the article tab when needed. Choose the actual original-text control if present and verify the alternate text/language. An article without original text does not prove switching.
- **Resume locally.** Run `orca exec --page "$VERIFY_PAGE" --command "scroll down 500 --selector .reader-scroll" --json`, record its offset and a paragraph, leave using browser Back without scrolling to the footer, reopen the same title through the UI, and require the same paragraph to be visible. Test in signed-out baseline to isolate local progress. Browser reload is an additional resume entry, with its own evidence.
- **Navigate.** At article bottom, snapshot the 文章导航 region. Click 上一篇 or 下一篇 if enabled and require a changed code/title in the same category context. Then click 返回 and verify the original list location.
- **Share.** Open the 分享 tab and use the visible share-link field. Capture its value without dumping unrelated state. Open that `/s/` address in another task-owned signed-out tab. Require readable title/body and absence of article navigation, favorite/highlight controls, and progress requests. Close this extra tab during cleanup. Clipboard confirmation alone does not prove the copied URL opens.

## Gotchas

- Normal public article reading is available without PIN. The README's older authorization wording is not the verification contract; current routes/source and live behavior are.
- First paragraph click opens controls; a second surface click dismisses them. Do not rely on the README's historical double-click instruction.
- Source text may be Japanese, English, or Chinese. Compare the chosen seed's actual title/body; do not assume every article has a translation, image, or terminology section.
- No signed-out remote progress request is expected; shared pages must not save local or remote progress.
