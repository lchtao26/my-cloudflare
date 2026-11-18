import { shareCodeId } from "./index.ts";

async function readProgressBody(request: Request): Promise<unknown> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 1024) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const data = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(data)); } catch { return null; }
}

export async function readProgress(request: Request, db: D1Database | undefined, code: string): Promise<Response> {
  const id = shareCodeId(code);
  const headers = { "Cache-Control": "no-store" };
  if (id === null) return new Response("Not found", { status: 404, headers });
  if (!db) return Response.json({ error: "阅读进度数据库未配置。" }, { status: 503, headers });
  if (request.method === "GET") {
    const row = await db.prepare("SELECT progress FROM reading_progress WHERE excerpt_number = ?").bind(id).first<{ progress: number }>();
    return Response.json({ progress: row?.progress ?? null }, { headers });
  }
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { ...headers, Allow: "GET, POST" } });
  if (request.headers.get("Origin") !== new URL(request.url).origin || request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return new Response("Forbidden", { status: 403, headers });
  const body = await readProgressBody(request) as { progress?: unknown } | null;
  if (!body || typeof body.progress !== "number" || !Number.isFinite(body.progress) || body.progress < 0 || body.progress > 1) return new Response("Invalid progress", { status: 400, headers });
  await db.prepare(
    "INSERT INTO reading_progress (excerpt_number, progress, updated_at) VALUES (?, ?, ?) " +
    "ON CONFLICT(excerpt_number) DO UPDATE SET progress = excluded.progress, updated_at = excluded.updated_at " +
    "WHERE excluded.progress > reading_progress.progress",
  ).bind(id, body.progress, Date.now()).run();
  return new Response(null, { status: 204, headers });
}
