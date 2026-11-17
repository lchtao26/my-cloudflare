import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { shareCode } from "../src/index.ts";
import { protectRead, readLogin } from "../src/read-auth.ts";
import { readProgress } from "../src/read-progress.ts";

const origin = "https://example.com";
const code = shareCode(42);
function environment() {
  let count = 0;
  return { FAVORITE_PIN: "012345", FAVORITE_SESSION_SECRET: "1234567890abcdef1234567890abcdef", FAVORITE_LOGIN_LIMIT: { getByName: () => ({ attempt: async () => ++count <= 5 }) } };
}

test("reading access requires the existing session and login rejects forged requests", async () => {
  const env = environment();
  for (const path of ["/read?tab=weekly", `/r/${code}`, "/api/read", `/api/r/${code}`, `/api/progress/${code}`]) {
    const response = await protectRead(new Request(origin + path), env);
    assert.ok(response);
    assert.equal(response.status, path.startsWith("/api/") ? 401 : 302);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
  assert.equal(await protectRead(new Request(`${origin}/s/${code}`), env), null);
  assert.equal(await protectRead(new Request(`${origin}/api/s/${code}`), env), null);
  const loginUrl = `${origin}/read-auth?next=${encodeURIComponent(`/r/${code}?tab=weekly`)}`;
  const login = await readLogin(new Request(loginUrl), env);
  const csrfCookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const token = (await login.text()).match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
  const post = (pin: string, requestOrigin = origin, csrf = token) => new Request(loginUrl, { method: "POST", headers: { Origin: requestOrigin, Cookie: csrfCookie, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, pin }) });
  assert.equal((await readLogin(post("012345", "https://evil.example"), env)).status, 403);
  assert.equal((await readLogin(post("012345", origin, "0".repeat(64)), env)).status, 403);
  assert.equal((await readLogin(post("999999"), env)).status, 401);
  const success = await readLogin(post("012345"), env);
  assert.equal(success.status, 303);
  assert.equal(success.headers.get("Location"), `/r/${code}?tab=weekly`);
  const session = success.headers.get("set-cookie")!.split(";")[0]!;
  assert.match(session, /^__Host-read-session=/);
  assert.equal(await protectRead(new Request(`${origin}/api/r/${code}`, { headers: { Cookie: session } }), env), null);
  assert.ok(await protectRead(new Request(`${origin}/read`, { headers: { Cookie: session } }), { ...env, FAVORITE_PIN: "654321" }));
});

test("progress is shared by article and rejects invalid or cross-origin writes", async t => {
  const sql = new DatabaseSync(":memory:");
  t.after(() => sql.close());
  sql.exec(readFileSync("migrations/0004_reading_progress.sql", "utf8"));
  const db = { prepare(query: string) { return { bind(...args: SQLInputValue[]) { return {
    async run() { return sql.prepare(query).run(...args); },
    async first() { return sql.prepare(query).get(...args) ?? null; },
  }; } }; } } as unknown as D1Database;
  const url = `${origin}/api/progress/${code}`;
  const get = () => readProgress(new Request(url), db, code);
  const post = (body: string, from = origin) => readProgress(new Request(url, { method: "POST", headers: { Origin: from, "Content-Type": "application/json" }, body }), db, code);
  assert.deepEqual(await (await get()).json(), { progress: null });
  assert.equal((await post('{"progress":0.4}', "https://evil.example")).status, 403);
  assert.equal((await post('{"progress":2}')).status, 400);
  assert.equal((await post(JSON.stringify({ progress: 0.4, extra: "x".repeat(1100) }))).status, 400);
  assert.equal((await post('{"progress":0.4}')).status, 204);
  assert.deepEqual(await (await get()).json(), { progress: 0.4 });
  assert.equal((await post('{"progress":0.2}')).status, 204);
  assert.deepEqual(await (await get()).json(), { progress: 0.2 });
  assert.deepEqual(await (await readProgress(new Request(url), db, shareCode(43))).json(), { progress: null });
});
