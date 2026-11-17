export function LoadingStatus() {
  return (
    <p className="loading" role="status">
      <span className="loader" aria-hidden="true" />
      <span className="visually-hidden">正在加载…</span>
    </p>
  );
}
