import * as Sentry from "@sentry/cloudflare";
import { wrapFetchWithSentry } from "@sentry/tanstackstart-react";
import { sentryOptions } from "./sentry.server.ts";
import { DurableObject } from "cloudflare:workers";
import start from "@tanstack/react-start/server-entry";
import worker from "./index.ts";
import { protectRead, readLogin } from "./read-auth.ts";
import { readProgress } from "./read-progress.ts";

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

export default Sentry.withSentry(sentryOptions, {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/read-auth") return readLogin(request, env);
    const progressMatch = url.pathname.match(/^\/api\/progress\/([A-Za-z0-9]{6})$/);
    const blocked = await protectRead(request, env);
    if (blocked) return blocked;
    if (progressMatch) return readProgress(request, env.HIGHLIGHTS_DB, progressMatch[1]!);
    const isDetail = /^\/r\/[A-Za-z0-9]{6}\/?$/.test(url.pathname);
    if (!isDetail && !/^\/(?:read|s\/[A-Za-z0-9]{6})\/?$/.test(url.pathname)) {
      const response = await worker.fetch(request, env);
      if (!/^\/api\/(?:read\/?|r\/[A-Za-z0-9]{6}\/?)$/.test(url.pathname)) return response;
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "no-store");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }

    if (isDetail || import.meta.env.DEV) {
      const response = await startWithSentry.fetch(request);
      if (!isDetail && !/^\/read\/?$/.test(url.pathname)) return response;
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "no-store");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }

    // The list and share routes use the generated SPA shell.
    const shell = await env.ASSETS.fetch(new Request(new URL("/_shell.html", url), { method: request.method }));
    if (shell.status === 404 && request.headers.get("X-TSS_SHELL") === "true") {
      return startWithSentry.fetch(request);
    }
    if (!/^\/read\/?$/.test(url.pathname)) return shell;
    const headers = new Headers(shell.headers);
    headers.set("Cache-Control", "no-store");
    return new Response(shell.body, { status: shell.status, statusText: shell.statusText, headers });
  },
} satisfies ExportedHandler<Env>);
