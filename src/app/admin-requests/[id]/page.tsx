import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readAdminRequest, isRequestUnavailable, readAdminRequestDraftPrefill } from '@/lib/admin-request-service';
import { AdminRequestForm } from '@/components/admin-request-form';
import { adminRequestStatusLabels } from '@/lib/admin-request-contract';
import { PageHeader } from '@/components/ui';
export const dynamic = 'force-dynamic';
export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ result?: string }> }) {
  const { id } = await params, query = await searchParams, user = await requireSession(); let request;
  try { request = await readAdminRequest(prisma, user, id); }
  catch (error) { if (isRequestUnavailable(error)) notFound(); throw error; }
  const open = ['OPEN', 'NEEDS_INFORMATION'].includes(request.status);
  const fields = <><input type="hidden" name="requestId" value={id} /><input type="hidden" name="expectedRevision" value={request.revision} /><input type="hidden" name="expectedSubmissionSha256" value={request.submissionSha256} /></>;
  let draftHref = request.draftHref;
  if (request.isAdmin && open) {
    const prefill = await readAdminRequestDraftPrefill(prisma, user, id);
    draftHref = `/communications?kind=${prefill.context.kind}&practice=${encodeURIComponent(prefill.context.id)}&request=${id}`;
  }
  const labels: Record<string, string> = { SUBMIT: 'Richiesta registrata', AMEND: 'Integrazione interna registrata', WITHDRAW: 'Richiesta ritirata', REQUEST_INFORMATION: 'Richiesta di chiarimento interno', REJECT: 'Richiesta rifiutata', PREPARE_DRAFT: 'Bozza preparata · invio da decidere' };
  return <div className="min-w-0 space-y-5 [overflow-wrap:anywhere]"><PageHeader title={request.submitted.title} description={adminRequestStatusLabels[request.status]} />
    <Link className="underline" href="/admin-requests">Torna alle richieste</Link>
    {query.result === 'RECORDED' && <p role="status">Operazione registrata nello storico. Nessuna email inviata.</p>}
    <section className="rounded-xl border p-4"><h2 className="font-bold">Indicazioni interne</h2><p className="whitespace-pre-wrap">{request.submitted.details}</p></section>
    {request.requesterReply && <section className="rounded-xl border p-4"><h2 className="font-bold">Risposta interna dell’Admin</h2><p className="whitespace-pre-wrap">{request.requesterReply}</p></section>}
    {request.isAdmin && draftHref && <Link className="inline-block rounded-xl bg-fai-navy p-3 font-bold text-white" href={draftHref}>{request.draftHref ? 'Apri bozza email collegata' : 'Prepara bozza email da approvare'}</Link>}
    {open && request.isAdmin && <AdminRequestForm className="grid max-w-3xl gap-3">{fields}<input type="hidden" name="commandId" value={randomUUID()} />
      <label>Risposta visibile all’autore<textarea className="block w-full rounded-xl border p-3" required minLength={3} maxLength={2000} rows={4} name="requesterReply" /></label>
      <div className="flex flex-wrap gap-3"><button className="rounded-xl border p-3" name="action" value="REQUEST_INFORMATION">Chiedi integrazione interna</button><button className="rounded-xl border p-3" name="action" value="REJECT">Rifiuta richiesta</button></div></AdminRequestForm>}
    {open && !request.isAdmin && <><AdminRequestForm className="grid max-w-3xl gap-3">{fields}<input type="hidden" name="commandId" value={randomUUID()} /><input type="hidden" name="action" value="AMEND" />
      <label>Oggetto della richiesta<input required minLength={3} maxLength={160} className="block w-full rounded-xl border p-3" name="title" defaultValue={request.submitted.title} /></label>
      <label>Indicazioni interne<textarea required minLength={3} maxLength={3000} rows={6} className="block w-full rounded-xl border p-3" name="details" defaultValue={request.submitted.details} /></label>
      <button className="rounded-xl border p-3">Salva integrazione interna</button></AdminRequestForm>
      <AdminRequestForm>{fields}<input type="hidden" name="commandId" value={randomUUID()} /><input type="hidden" name="action" value="WITHDRAW" /><button className="rounded-xl border p-3">Ritira richiesta interna</button></AdminRequestForm></>}
    <section><h2 className="font-bold">Storico della richiesta</h2><ol>{request.history.map(event => <li key={event.revision}>{event.createdAt.toLocaleString('it-IT')} · {labels[event.operation] ?? 'Evento registrato'} · versione {event.revision}</li>)}</ol></section>
    <p>Lo stato della richiesta non è una ricevuta di invio o di lettura. L’approvazione e l’invio sono decisioni personali separate sulla versione esatta dell’email.</p>
  </div>;
}
