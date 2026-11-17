import { createFileRoute } from "@tanstack/react-router";
import { ArticleRoute } from "../reader/article.tsx";

export const Route = createFileRoute("/s/$code")({
  ssr: false,
  component: SharedArticle,
});

function SharedArticle() {
  const { code } = Route.useParams();
  return <ArticleRoute key={code} code={code} category="all" page={1} shared />;
}
