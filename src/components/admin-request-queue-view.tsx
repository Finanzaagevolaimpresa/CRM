import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readAdminRequestQueue, isRequestUnavailable, AdminRequestQueueLimitError } from '@/lib/admin-request-service';
import { adminRequestStatusLabels } from '@/lib/admin-request-contract';
import { parseAdminRequestQueueSearch, adminRequestQueueHref, type AdminRequestQueueSearch } from '@/lib/admin-request-queue-query';
import { Card, PageHeader } from '@/components/ui';
import { AdminRequestRecovery } from '@/components/admin-request-form';

export async function AdminRequestQueueView({ searchParams, integrations = false }: {
  searchParams: Promise<AdminRequestQueueSearch>; integrations?: boolean;
}) {
  const user = await requireSession();
  const query = parseAdminRequestQueueSearch(await searchParams, integrations ? 'INTEGRATION' : undefined);
  if (!query) notFound();
  if (query.recover) return <AdminRequestRecovery commandId={query.recover} />;
  let data, limited = false;
  try { data = await readAdminRequestQueue(prisma, user, query.page, query.q, query.kind); }
  catch (error) {
    if (isRequestUnavailable(error)) notFound();
    if (!(error instanceof AdminRequestQueueLimitError)) throw error;
    limited = true; data = { isAdmin: error.isAdmin, items: [], hasNext: false };
  }
  const base = integrations ? '/technical-office/integrations' : '/admin-requests';
  return <div className="min-w-0 space-y-5 [overflow-wrap:anywhere]">
    <PageHeader title={integrations ? 'Integrazioni tecniche' : data.isAdmin ? 'Richieste all’Admin' : 'Le mie richieste all’Admin'}
      description={integrations
        ? 'Richieste di integrazione nel tuo perimetro: consulta lo stato, apri lo storico e prosegui il confronto interno con l’Admin.'
        : 'Documenti e integrazioni: richiesta interna, revisione personale e bozza da approvare. Nessun avviso automatico al cliente.'} />
    {integrations && <><p>L’eventuale email richiede una bozza e la decisione personale dell’Admin. Lo stato della richiesta non attesta un invio al cliente.</p>
      <Link className="font-bold underline" href="/admin-requests">Tutte le richieste all’Admin</Link></>}
    {query.result === 'UNAVAILABLE' && <p role="status">La richiesta è cambiata o il perimetro non è più valido. Riapri il record e controlla lo storico prima di riprovare.</p>}
    {query.result === 'INVALID' && <p role="status">Controlla i campi della richiesta.</p>}
    <form action={base} className="flex min-w-0 flex-wrap items-end gap-3">
      <label className="min-w-0 max-w-full">Cerca nelle richieste disponibili<input className="block w-full max-w-full rounded-xl border p-2" name="q" maxLength={160} defaultValue={query.q} /></label>
      {integrations ? <input type="hidden" name="kind" value="INTEGRATION" />
        : <label className="min-w-0 max-w-full">Tipo di richiesta<select name="kind" defaultValue={query.kind ?? ''} className="block max-w-full rounded-xl border p-2">
          <option value="">Tutte</option><option value="DOCUMENT">Documenti</option><option value="INTEGRATION">Integrazioni</option>
        </select></label>}
      <button className="rounded-xl border px-4 py-2" type="submit">Cerca</button>
      <Link className="p-2 underline" href={base}>Azzera ricerca</Link>
    </form>
    {limited ? <p role="status">Restringi la ricerca per consultare le richieste disponibili.</p>
      : !data.items.length && <p>Nessuna richiesta disponibile con questi filtri nel tuo perimetro. Per iniziare, apri un tuo lead o cliente oppure un incarico tecnico che consente richieste all’Admin.</p>}
    {data.items.map(item => <Card key={item.id} title={item.title}><p>{adminRequestStatusLabels[item.status]}</p>
      <p>{item.kind === 'DOCUMENT' ? 'Richiesta documento' : 'Richiesta integrazione'}</p>
      <Link className="font-bold underline" href={`/admin-requests/${item.id}`}>Apri richiesta</Link></Card>)}
    <nav aria-label="Pagine delle richieste" className="flex gap-4">
      {query.page > 1 && <Link href={adminRequestQueueHref(base, { ...query, page: query.page - 1 })}>Precedenti</Link>}
      {data.hasNext && <Link href={adminRequestQueueHref(base, { ...query, page: query.page + 1 })}>Successive</Link>}
    </nav>
  </div>;
}
