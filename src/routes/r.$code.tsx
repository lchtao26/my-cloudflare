import { createFileRoute } from "@tanstack/react-router";
import { ArticleRoute } from "../reader/article.tsx";
import { readCategory } from "../reader/data.ts";
import { validateReaderSearch } from "../reader/queries.ts";

export const Route = createFileRoute("/r/$code")({
  ssr: false,
  validateSearch: validateReaderSearch,
  component: ReadArticle,
});

function ReadArticle() {
  const { code } = Route.useParams();
  const { tab, page = 1 } = Route.useSearch();
  return <ArticleRoute key={code} code={code} category={readCategory(tab)} page={page} shared={false} />;
}
