import Link from 'next/link';
import { Card, EmptyState, PageHeader, formatDateTime } from '@/components/ui';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { listRecordUpdates } from '@/lib/record-update-delivery';
export const dynamic = 'force-dynamic';
export default async function Page() {
  const rows = await listRecordUpdates(prisma, await requireSession(), 100, false);
  return <div className="crm-space-y-6"><PageHeader title="Aggiornamenti selezionati" description="Avvisi CRM destinati a te e ancora ammessi dai permessi correnti. La lettura non rappresenta un invio email." />
    <Link href="/notifications" className="font-bold underline">← Notifiche</Link>
    <Card title="Disponibili e letti">{rows.length ? <div className="crm-space-y-3">{rows.map(row => <article key={row.id} className="rounded-xl border p-4">
      <p className="break-words font-bold">{row.related}</p><p>{row.title} · {formatDateTime(row.date)}</p>
      <p className="text-sm">{row.readAt ? 'Letto: ' + formatDateTime(row.readAt) : 'Disponibile · non ancora segnato come letto'}</p>
      <Link className="font-bold underline" href={row.href}>Apri aggiornamento</Link>
    </article>)}</div> : <EmptyState title="Nessun aggiornamento disponibile">Sono mostrati solo gli avvisi destinati a te che puoi ancora consultare.</EmptyState>}</Card></div>;
}
