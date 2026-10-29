import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { Card, PageHeader } from '@/components/ui';
import { CancelRecordReminder } from '@/components/record-reminder-form';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { loadActivePrivilegedStepUpKey } from '@/lib/application-key-registry';
import { readRecordReminderManagement } from '@/lib/record-reminder-management';
import { RecordUpdateError } from '@/lib/record-update-contract';

export const dynamic = 'force-dynamic';
const states = { SCHEDULED: 'Programmato', AVAILABLE: 'Disponibile nel CRM', READ: 'Letto nel CRM',
  SUPPRESSED: 'Sospeso: attività, destinatari o permessi non più conformi', CANCELED: 'Annullato' } as const;
const time = (value: string) => new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', dateStyle: 'long', timeStyle: 'short' }).format(new Date(value));
export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>;
  searchParams: Promise<{ cancelDecision?: string }> }) {
  const session = await requireSession(), ref = z.object({ id: z.string().uuid() }).safeParse(await params);
  const query = z.object({ cancelDecision: z.string().uuid().optional() }).safeParse(await searchParams);
  if (session.role !== 'admin' || !ref.success || !query.success) notFound();
  const key = await loadActivePrivilegedStepUpKey(prisma);
  if (!key) notFound();
  let row;
  try { row = await readRecordReminderManagement(prisma, session, key, ref.data.id); }
  catch (error) { if (error instanceof RecordUpdateError) notFound(); throw error; }
  if (!row) notFound();
  return <div className="min-w-0 space-y-6"><PageHeader title="Stato del promemoria"
    description="Programmazione, disponibilità e lettura sono fatti distinti. Nessuno stato attesta un invio email. Orari Europe/Rome." />
    <div className="flex flex-wrap gap-4"><Link className="font-bold underline" href="/notifications/reminders">Torna ai miei promemoria</Link>
      {row.recordHref && <Link className="font-bold underline" href={row.recordHref}>Apri scheda corrente</Link>}</div>
    <Card title={row.taskTitle ?? 'Attività modificata o non più disponibile'}>
      <p>Registrato: {time(row.registeredAt)}.</p><p>Promemoria: {time(row.remindAt)}.</p>
      {row.dueAt && <p>Scadenza dell’attività: {time(row.dueAt)}.</p>}
      {row.canceledAt && <p className="font-bold">Annullato: {time(row.canceledAt)}.</p>}
      <p className="break-all text-sm">Riferimento: {row.commandId}</p>
      <ul className="mt-4 space-y-3">{row.recipients.map((person, index) => <li key={index} className="rounded-xl border p-3">
        <strong>{person.name ?? `Destinatario ${index + 1}: dati non più disponibili`}</strong><p>{states[person.state]}</p>
        {person.readAt && <p>Lettura già registrata: {time(person.readAt)}. La ricevuta è conservata anche se l’accesso successivo è sospeso.</p>}
      </li>)}</ul>
    </Card>
    {!row.canceledAt && <><p>Per annullare serve la conferma personale corrente. <a className="font-bold underline" href="/settings/security" target="_blank" rel="noopener noreferrer">Conferma identità in una nuova scheda</a></p>
      <CancelRecordReminder reminderCommandId={row.commandId} resumeCommandId={query.data.cancelDecision}/></>}
  </div>;
}
