import { DurableObject } from "cloudflare:workers";
import start from "@tanstack/react-start/server-entry";
import worker from "./index.ts";

// One shared PIN needs one global counter: per-IP limits can be bypassed with multiple IPs.
export class FavoriteLoginLimit extends DurableObject {
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!/^\/(?:read|[rs]\/[A-Za-z0-9]{6})\/?$/.test(url.pathname)) {
      return worker.fetch(request, env);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }

    // Start renders the shell during development and the build's prerender step.
    // Workers serves the generated document for ordinary page requests.
    if (import.meta.env.DEV) return start.fetch(request);
    const shell = await env.ASSETS.fetch(new Request(new URL("/_shell.html", url), { method: request.method }));
    if (shell.status === 404 && /^\/read\/?$/.test(url.pathname) && request.headers.get("X-TSS_SHELL") === "true") {
      return start.fetch(request);
    }
    return shell;
  },
} satisfies ExportedHandler<Env>;
