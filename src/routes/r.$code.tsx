import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequest, setResponseStatus } from "@tanstack/react-start/server";
import worker from "../index.ts";
import { ArticleRoute, type InitialArticle } from "../reader/article.tsx";
import { readCategory, type ReadCategory, type ReaderArticle } from "../reader/data.ts";
import { articlePath, validateReaderSearch } from "../reader/queries.ts";

const loadInitialArticle = createIsomorphicFn()
  .server(async (code: string, category: ReadCategory, page: number): Promise<InitialArticle> => {
    const request = getRequest();
    const url = new URL(articlePath(code, false, category, page), request.url);
    const response = await worker.fetch(new Request(url, { signal: request.signal }), env);
    if (response.ok) return { data: await response.json<ReaderArticle>() };

    setResponseStatus(response.status);
    const { error } = await response.json<{ error: string }>();
    return { error: { message: error, status: response.status } };
  })
  .client(() => undefined);

export const Route = createFileRoute("/r/$code")({
  validateSearch: validateReaderSearch,
  loaderDeps: ({ search }) => ({ category: readCategory(search.tab), page: search.page ?? 1 }),
  loader: ({ params, deps }) => loadInitialArticle(params.code, deps.category, deps.page),
  head: ({ loaderData }) => (loaderData?.data ? { meta: [{ title: loaderData.data.item.title }] } : {}),
  headers: () => ({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }),
  component: ReadArticle,
});

function ReadArticle() {
  const { code } = Route.useParams();
  const { category, page } = Route.useLoaderDeps();
  const initial = Route.useLoaderData();
  return <ArticleRoute key={code} code={code} category={category} page={page} shared={false} initial={initial} />;
}
