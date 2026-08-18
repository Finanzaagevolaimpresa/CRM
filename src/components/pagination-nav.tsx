import Link from 'next/link';
import { coreQueryPageHref } from '@/lib/core-query-policy';

export function PaginationNav({
  pathname,
  params,
  page,
  hasPrevious,
  hasNext,
}: {
  pathname: string;
  params: Readonly<Record<string, string | undefined>>;
  page: number;
  hasPrevious: boolean;
  hasNext: boolean;
}) {
  if (!hasPrevious && !hasNext) return null;
  const linkClass = 'rounded-xl border border-fai-blue/15 bg-white px-4 py-2 text-sm font-bold text-fai-blue shadow-sm hover:bg-fai-blue/10';
  return <nav aria-label="Paginazione elenco" className="mt-4 flex items-center justify-between gap-3">
    <span className="text-sm font-semibold text-slate-500">Pagina {page}</span>
    <div className="flex gap-2">
      {hasPrevious ? <Link className={linkClass} href={coreQueryPageHref(pathname, params, page - 1)}>Precedente</Link> : null}
      {hasNext ? <Link className={linkClass} href={coreQueryPageHref(pathname, params, page + 1)}>Successiva</Link> : null}
    </div>
  </nav>;
}
