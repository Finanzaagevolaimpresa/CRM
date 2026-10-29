import { formatRecordNoticeTime } from '@/lib/record-notice-time';
import Link from 'next/link';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { listSelectedRecordNotices } from '@/lib/record-reminder-notifications';
import { loadActivePrivilegedStepUpKey } from '@/lib/application-key-registry';
export const dynamic = 'force-dynamic';
export default async function Page() {
  const rows = await listSelectedRecordNotices(prisma, await requireSession(), await loadActivePrivilegedStepUpKey(prisma), 100, false);
  return <div className="crm-space-y-6"><PageHeader title="Aggiornamenti selezionati" description="Aggiornamenti e promemoria CRM disponibili, destinati a te e ammessi dai permessi correnti. La lettura non rappresenta un invio email. Orari Europe/Rome." />
    <Link href="/notifications" className="font-bold underline">← Notifiche</Link>
    <Card title="Disponibili e letti">{rows.length ? <div className="crm-space-y-3">{rows.map(row => <article key={row.id} className="rounded-xl border p-4">
      <p className="break-words font-bold">{row.related}</p><p>{row.title} · {formatRecordNoticeTime(row.date)}</p>
      {row.noticeKind === 'REMINDER' && <p>Scadenza dell’attività: {formatRecordNoticeTime(row.dueAt)}</p>}
      <p className="text-sm">{row.readAt ? 'Letto: ' + formatRecordNoticeTime(row.readAt) : 'Disponibile · non ancora segnato come letto'}</p>
      <Link className="font-bold underline" href={row.href}>Apri aggiornamento</Link>
    </article>)}</div> : <EmptyState title="Nessun aggiornamento disponibile">Sono mostrati solo gli avvisi destinati a te che puoi ancora consultare.</EmptyState>}</Card>
    {rows.length === 100 && <p className="text-sm">Sono mostrati i 100 avvisi disponibili più recenti.</p>}</div>;
}
