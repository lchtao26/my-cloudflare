# Authorization and saved state

Authorization enables saving favorites, collecting later-reading articles, and syncing the furthest reading position across devices. Public reading remains available while signed out.

## Sub-features

- `auth-login`: six-digit PIN submits and creates a session.
- `auth-logout`: logout clears the session while keeping public reading available.
- `favorite-toggle`: favorite/unfavorite is reflected in the 收藏 category.
- `save-later`: 加入待读 reports completion and appears in 稍后阅读.
- `remote-progress`: newer remote progress is offered, only 同步 jumps, 忽略 dismisses.

## How to get to it (user POV)

Use the list's 登录 link or `/auth?next=/read`; logout through `/logout`. Article controls expose saved-state actions. 收藏 and 稍后阅读 are category links. The remote-progress prompt appears on a normal article when another authorized device has progressed farther.

## Driving it with Orca

Preconditions:

- Success journeys require a separately owned disposable Notion sandbox, update permission, local PIN/session secrets, migrated D1, and for remote progress two independent browser sessions. The default helper intentionally omits these secrets. Attempt `/auth?next=/read`, record its unavailable response and missing prerequisite, then report success paths unreachable. Do not guess a PIN or use production writes.
- In a configured sandbox, seed one known article and record its initial favorite/later state. Keep PIN and cookies out of evidence.

- **Login.** Navigate through 登录, snapshot `#pin`, and use the browser fill command with secret input supplied through stdin as documented by Orca. Six digits should submit once. Require the requested reading URL and a read-only `/api/session` result of true in that browser. Do not record raw request headers.
- **Logout.** Navigate `/logout` as a user navigation; require `/read` and session false. Reopen a public article and confirm it remains readable.
- **Favorites.** Open sandbox article controls, choose 收藏, then enter the 收藏 category and reopen the saved item. Inspect the sandbox Notion 已收藏 property independently. Toggle back and prove removal with a fresh read.
- **Later.** Choose 加入待读, observe completion, then find the article in 稍后阅读 and independently inspect the sandbox property. A disabled/completed button alone is insufficient.
- **Progress.** In session A scroll farther and wait for the save; inspect local D1 `reading_progress`. In session B stay behind and open the same article. Require an offer without an automatic jump. Test 忽略, then a new farther position and 同步. Confirm rereading backward never reduces stored remote progress.

## Gotchas

- Missing PIN/session configuration makes authorization unavailable, not a passing login test. The fresh baseline has no successful auth or saved-state seeds.
- Valid-format PIN attempts, including successful ones, share the five-per-15-minute limiter. Do not brute force around it.
- Baseline D1 is isolated, but Notion is external. All successful write journeys require disposable sandbox records and their own cleanup.
- AI and favorites share authorization infrastructure; being able to read an article does not grant save permission.
- A saved-state run needs its own launch/doctor/cleanup record; do not add secrets to the read-only baseline while it is running.
