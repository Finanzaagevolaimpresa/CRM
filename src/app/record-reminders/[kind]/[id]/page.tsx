import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { RecordReminderForm, RecordReminderRecovery } from '@/components/record-reminder-form';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { loadActivePrivilegedStepUpKey } from '@/lib/application-key-registry';
import { privilegedAccessReadiness } from '@/lib/privileged-access';
import { readRecordReminderSetup, reminderTargetSchema } from '@/lib/record-reminder-management';
import { RecordUpdateError } from '@/lib/record-update-contract';

export const dynamic = 'force-dynamic';
export default async function Page({ params, searchParams }: { params: Promise<{ kind: string; id: string }>;
  searchParams: Promise<{ q?: string; page?: string; reminderDecision?: string }> }) {
  const session = await requireSession(), ref = await params, query = await searchParams;
  const target = reminderTargetSchema.safeParse({ kind: ref.kind, recordId: ref.id });
  const search = z.object({ q: z.string().trim().max(120).optional(), page: z.coerce.number().int().min(1).max(100).default(1),
    reminderDecision: z.string().uuid().optional() }).safeParse(query);
  if (session.role !== 'admin' || !target.success || !search.success) notFound();
  const readiness = await privilegedAccessReadiness(session), key = await loadActivePrivilegedStepUpKey(prisma);
  if (!key) notFound();
  let setup;
  if (!search.data.reminderDecision) {
    try { setup = await readRecordReminderSetup(prisma, session, key, target.data, { query: search.data.q ?? '', page: search.data.page }); }
    catch (error) { if (error instanceof RecordUpdateError) notFound(); throw error; }
  }
  const path = `/record-reminders/${target.data.kind}/${target.data.recordId}`;
  const pageLink = (page: number) => `${path}?${new URLSearchParams({ q: search.data.q ?? '', page: String(page) })}`;
  return <div className="min-w-0 space-y-6"><PageHeader title="Programma promemoria CRM"
    description="Scegli una scadenza esistente, l’istante dell’avviso e le persone ammesse. Nessun invio email automatico." />
    <div className="flex flex-wrap gap-4">{setup && <Link className="font-bold underline" href={setup.href}>Torna alla scheda</Link>}
      <Link className="font-bold underline" href="/notifications/reminders">I miei promemoria programmati</Link></div>
    <p className="rounded-xl bg-slate-100 p-3">{readiness.active ? 'Conferma personale attiva.' : 'Per preparare e confermare un promemoria serve la conferma personale corrente.'} {' '}
      <a href="/settings/security" target="_blank" rel="noopener noreferrer" className="font-bold underline">Conferma identità in una nuova scheda</a></p>
    {search.data.reminderDecision ? <Card title="Riconcilia il salvataggio"><RecordReminderRecovery commandId={search.data.reminderDecision}/></Card> : setup && <>
      <Card title={setup.label}><form className="mb-5 flex flex-wrap items-end gap-3" action={path}>
        <label className="min-w-0 flex-1 font-bold">Cerca fra le attività con scadenza<input className="mt-2 w-full rounded-xl border px-3 py-2" name="q" maxLength={120} defaultValue={setup.query}/></label>
        <button className="rounded-xl border px-4 py-2 font-bold">Cerca attività</button>
      </form>
      {setup.tasks.length ? <RecordReminderForm key={`${setup.page}:${setup.query}`} setup={setup}/>
        : <EmptyState title="Nessuna attività con scadenza disponibile">Cerca un’attività aperta nel contesto corrente. Le attività riservate richiedono l’autorità personale pertinente; nessuna attività viene creata da questa pagina.</EmptyState>}
      </Card><nav aria-label="Pagine delle attività" className="flex flex-wrap gap-4">
        {setup.page > 1 && <Link className="font-bold underline" href={pageLink(setup.page - 1)}>Attività precedenti</Link>}
        <span>Pagina {setup.page}</span>{setup.hasNext && setup.page < 100 && <Link className="font-bold underline" href={pageLink(setup.page + 1)}>Altre attività</Link>}
      </nav>
    </>}
  </div>;
}
