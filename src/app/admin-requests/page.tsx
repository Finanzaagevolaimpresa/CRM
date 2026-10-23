import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readAdminRequestQueue, isRequestUnavailable, AdminRequestQueueLimitError } from '@/lib/admin-request-service';
import { adminRequestStatusLabels } from '@/lib/admin-request-contract';
import { Card, PageHeader } from '@/components/ui';
import { AdminRequestRecovery } from '@/components/admin-request-form';
import { z } from 'zod';
export const dynamic = 'force-dynamic';
export default async function Page({ searchParams }: { searchParams: Promise<{ page?: string; q?: string; result?: string; recover?: string }> }) {
  const user = await requireSession(), query = await searchParams, page = Number(query.page ?? 1);
  if (query.recover) {
    if (!z.string().uuid().safeParse(query.recover).success) notFound();
    return <AdminRequestRecovery commandId={query.recover} />;
  }
  if (!z.number().int().min(1).max(200).safeParse(page).success || (query.q?.length ?? 0) > 160) notFound();
  let data, limited = false;
  try { data = await readAdminRequestQueue(prisma, user, page, query.q ?? ''); }
  catch (error) {
    if (isRequestUnavailable(error)) notFound();
    if (!(error instanceof AdminRequestQueueLimitError)) throw error;
    limited = true; data = { isAdmin: error.isAdmin, items: [], hasNext: false };
  }
  return <div className="min-w-0 space-y-5 [overflow-wrap:anywhere]"><PageHeader title={data.isAdmin ? 'Richieste all’Admin' : 'Le mie richieste all’Admin'}
    description="Documenti e integrazioni: richiesta interna, revisione personale e bozza da approvare. Nessun avviso automatico al cliente." />
    {query.result === 'UNAVAILABLE' && <p role="status">La richiesta è cambiata o il perimetro non è più valido. Riapri il record e controlla lo storico prima di riprovare.</p>}
    {query.result === 'INVALID' && <p role="status">Controlla i campi della richiesta.</p>}
    <form className="flex flex-wrap gap-2"><label>Cerca nelle richieste disponibili<input className="block max-w-full rounded-xl border p-2" name="q" maxLength={160} defaultValue={query.q} /></label><button className="rounded-xl border px-4" type="submit">Cerca</button></form>
    {limited ? <p role="status">Restringi la ricerca per consultare le richieste disponibili.</p> : !data.items.length && <p>Nessuna richiesta disponibile nel tuo perimetro. Per iniziare, apri un tuo lead o cliente oppure un incarico tecnico che consente richieste all’Admin.</p>}
    {data.items.map(item => <Card key={item.id} title={item.title}><p>{adminRequestStatusLabels[item.status]}</p><p>{item.kind === 'DOCUMENT' ? 'Richiesta documento' : 'Richiesta integrazione'}</p>
      <Link className="font-bold underline" href={`/admin-requests/${item.id}`}>Apri richiesta</Link></Card>)}
    <nav className="flex gap-4">{page > 1 && <Link href={`/admin-requests?page=${page - 1}&q=${encodeURIComponent(query.q ?? '')}`}>Precedenti</Link>}{data.hasNext && <Link href={`/admin-requests?page=${page + 1}&q=${encodeURIComponent(query.q ?? '')}`}>Successive</Link>}</nav>
  </div>;
}
