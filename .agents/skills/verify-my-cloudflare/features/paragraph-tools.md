# Paragraph tools

Readers select a paragraph or words to highlight, remove a highlight, match original text, or ask for an explanation.

## Sub-features

- `paragraph-panel`: click a paragraph to open its preview; outside click closes controls.
- `token-selection`: hold the preview to choose words and punctuation ranges.
- `highlight-save-delete`: saved highlights persist and can be removed.
- `original-match`: eligible translated text gets a matched original paragraph.
- `paragraph-explain`: explanation appears in its dialog with readable Markdown.

## How to get to it (user POV)

Open a normal `/r/{code}` article, select a `[data-paragraph]`, and choose 段落 controls. Long-press `#body-preview` for word selection. Existing marked text opens its removal action. The 划线 category links back to saved text. Public `/s/` pages omit these private actions.

## Driving it with Orca

Preconditions:

- Successful tools require the saved-state sandbox prerequisites. Highlighting needs migrated local D1; original matching also needs paired original/translation; AI tools require a disposable/test `AI302_API_KEY` and incur upstream API calls. Default baseline does not satisfy these conditions.

- **Panel.** Open an actual paragraph via its fresh snapshot ref and inspect 段落 / preview controls. Click outside and require dismissal. In signed-out baseline, record the authorization prompt instead of claiming selection/save success.
- **Words.** In an authorized sandbox, use real long-press input on `#body-preview`, then snapshot the 选择文字 group and select the desired visible word buttons. Require selected states and matching preview. A synthesized hold event is diagnostic only.
- **Save.** Choose 划线, require the chosen text visibly marked, leave and reopen the article, then find the record in 划线 and return through its hash link. Verify the corresponding local D1 row with a read-only query. Repeating an identical save must not duplicate the record.
- **Delete.** Click an existing highlight and choose 取消划线. Require the mark to disappear on reopen and its D1 row to be absent. Do not delete another run's records.
- **AI dialogs.** Choose 显示原文 or 解释 on an eligible paragraph. Require the pending state, completed dialog text, and outside/Escape dismissal. Save the resulting screenshot and a redacted network status; do not record API keys. Check successful explanations do not create highlight rows.

## Gotchas

- Missing auth, AI key, translated/original pair, or saved highlight seed is a failed prerequisite; do not substitute a different article/control and claim the journey passed.
- Controls are not available on public shared pages. The default baseline can prove their absence and the signed-out prompt only.
- Release after a long press has a guard to avoid selecting a word accidentally. Use actual input and wait for the visible selection state.
- Writes are limited to 1500 non-whitespace UTF-16 units per selection and 200 highlights per article. Overlap removal targets the clicked innermost mark.
