import Link from 'next/link';
import type { readCommercialProgress } from '@/lib/commercial-progress';
import { Card, EmptyState } from './ui';
import { operationalRomeTime as formatDateTime } from '@/lib/operational-time';

type Progress = Awaited<ReturnType<typeof readCommercialProgress>>;
export function CommercialProgress({ result, query }: { result: Progress; query: { client?: string; q?: string } }) {
  const nextQuery = new URLSearchParams({ ...(query.client ? { client: query.client } : {}), ...(query.q ? { q: query.q } : {}), ...(result.next ? { after: result.next } : {}) });
  return <section aria-labelledby="commercial-progress-heading" className="crm-space-y-6">
    <h2 id="commercial-progress-heading" className="text-xl font-bold">Avanzamento tecnico dei miei clienti</h2>
    <p>{result.items.length} avanzamenti in questa pagina.</p>
    <div className="grid gap-4 lg:grid-cols-2">{result.items.map(item => <Card key={item.id} title={item.clientName}>
      <div data-commercial-progress={item.id} className="crm-space-y-2">
        <p><b>Stato della pratica:</b> {item.statusLabel}</p>
        <p><b>Scadenza operativa:</b> {item.dueDate ? formatDateTime(item.dueDate) : 'Da pianificare'}</p>
        <p><b>Prossimo aggiornamento al cliente:</b> {item.nextClientUpdateAt ? formatDateTime(item.nextClientUpdateAt) : 'Da concordare'}</p>
        <p className="text-sm">Aggiornato il {formatDateTime(item.updatedAt)}.</p>
      </div>
    </Card>)}</div>
    {!result.items.length ? <EmptyState title="Nessun avanzamento disponibile">Per i clienti assegnati, l’avanzamento compare quando la pratica è attiva e il riferimento commerciale è confermato.</EmptyState> : null}
    {result.next ? <Link className="inline-block rounded-xl border px-4 py-3" href={`/progress?${nextQuery.toString()}`}>Altri avanzamenti</Link> : null}
  </section>;
}
