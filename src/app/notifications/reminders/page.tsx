import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { loadActivePrivilegedStepUpKey } from '@/lib/application-key-registry';
import { listRecordReminderManagement } from '@/lib/record-reminder-management';
import { RecordUpdateError } from '@/lib/record-update-contract';

export const dynamic = 'force-dynamic';
const time = (value: string) => new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', dateStyle: 'long', timeStyle: 'short' }).format(new Date(value));
export default async function Page({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const session = await requireSession(), query = await searchParams, page = z.coerce.number().int().min(1).max(100).safeParse(query.page ?? 1);
  if (session.role !== 'admin' || !page.success) notFound();
  const key = await loadActivePrivilegedStepUpKey(prisma);
  if (!key) notFound();
  let data;
  try { data = await listRecordReminderManagement(prisma, session, key, page.data); }
  catch (error) { if (error instanceof RecordUpdateError) notFound(); throw error; }
  return <div className="min-w-0 space-y-6"><PageHeader title="I miei promemoria programmati"
    description="Consulta le tue decisioni, lo stato corrente e le letture registrate. Tutti gli orari sono in Europe/Rome." />
    <Link className="font-bold underline" href="/notifications">Torna alle notifiche</Link>
    <p>Per programmare un promemoria apri una scheda Cliente, Progetto o Pratica e scegli «Programma promemoria CRM».</p>
    <Card title="Decisioni conservate">{data.rows.length ? <div className="space-y-3">{data.rows.map(row => <article key={row.commandId} className="min-w-0 rounded-xl border p-4">
      <h2 className="break-words font-bold">{row.taskTitle ?? 'Attività modificata o non più disponibile'}</h2>
      <p>Registrato: {time(row.registeredAt)}. Promemoria: {time(row.remindAt)}.</p>
      <p>{row.canceledAt ? 'Annullato' : 'Decisione registrata'} · {row.recipients.length} destinatari scelti.</p>
      <Link className="font-bold underline" href={`/notifications/reminders/${row.commandId}`}>Apri stato e annullamento</Link>
    </article>)}</div> : <EmptyState title="Nessun promemoria registrato">Qui compaiono solo le tue decisioni; gli avvisi destinati a te restano in «Aggiornamenti selezionati».</EmptyState>}</Card>
    <nav aria-label="Pagine dei promemoria" className="flex flex-wrap gap-4">
      {data.page > 1 && <Link className="font-bold underline" href={`/notifications/reminders?page=${data.page - 1}`}>Precedenti</Link>}
      <span>Pagina {data.page}</span>{data.hasNext && data.page < 100 && <Link className="font-bold underline" href={`/notifications/reminders?page=${data.page + 1}`}>Successivi</Link>}
    </nav>
  </div>;
}
