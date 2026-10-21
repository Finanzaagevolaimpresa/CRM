/** Native links prevent Next prefetch from reading/auditing file bytes. */
export function DocumentFileLinks({ id }: { id: string }) {
  const base = `/documents/${encodeURIComponent(id)}`;
  return <span className="flex flex-wrap items-center gap-3 font-semibold text-fai-blue">
    <a href={`${base}/view`} target="_blank" rel="noopener noreferrer" className="underline">Visualizza</a>
    <a href={`${base}/download`} className="underline">Scarica</a>
  </span>;
}
