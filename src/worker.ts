import * as Sentry from "@sentry/cloudflare";
import { wrapFetchWithSentry } from "@sentry/tanstackstart-react";
import { sentryOptions } from "./sentry.server.ts";
import { DurableObject } from "cloudflare:workers";
import start from "@tanstack/react-start/server-entry";
import worker from "./index.ts";
import { protectRead, readLogin, readLogout, readSession } from "./reader/auth.ts";
import { readProgress } from "./reader/progress.ts";

// One shared PIN needs one global counter: per-IP limits can be bypassed with multiple IPs.
class FavoriteLoginLimitBase extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS attempts (time INTEGER NOT NULL)");
  }

  async attempt(): Promise<boolean> {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    sql.exec("DELETE FROM attempts WHERE time <= ?", now - 15 * 60 * 1000);
    const { count } = sql.exec<{ count: number }>("SELECT count(*) AS count FROM attempts").one();
    if (count >= 5) return false;
    sql.exec("INSERT INTO attempts (time) VALUES (?)", now);
    return true;
  }
}

export type FavoriteLoginLimit = FavoriteLoginLimitBase;
export const FavoriteLoginLimit = Sentry.instrumentDurableObjectWithSentry(sentryOptions, FavoriteLoginLimitBase);

const startWithSentry = wrapFetchWithSentry(start);

function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default Sentry.withSentry(sentryOptions, {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/auth") return readLogin(request, env);
    if (url.pathname === "/logout" || url.pathname === "/logout/") return readLogout(request);
    if (url.pathname === "/api/session") return readSession(request, env);
    const progressMatch = url.pathname.match(/^\/api\/progress\/([A-Za-z0-9]{6})$/);
    const blocked = await protectRead(request, env);
    if (blocked) return blocked;
    if (progressMatch) return readProgress(request, env.HIGHLIGHTS_DB, progressMatch[1]!);
    const isPrivatePage = /^\/(?:read|r\/[A-Za-z0-9]{6})\/?$/.test(url.pathname);
    if (!isPrivatePage && !/^\/s\/[A-Za-z0-9]{6}\/?$/.test(url.pathname)) {
      return worker.fetch(request, env);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }

    if (import.meta.env.DEV) {
      const response = await startWithSentry.fetch(request);
      return isPrivatePage ? noStore(response) : response;
    }

    // All reader routes use the generated SPA shell.
    const shell = await env.ASSETS.fetch(new Request(new URL("/_shell.html", url), { method: request.method }));
    if (shell.status === 404 && request.headers.get("X-TSS_SHELL") === "true") {
      return startWithSentry.fetch(request);
    }
    return isPrivatePage ? noStore(shell) : shell;
  },
} satisfies ExportedHandler<Env>);
