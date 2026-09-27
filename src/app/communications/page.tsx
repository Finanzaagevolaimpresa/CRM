import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { Card, PageHeader } from '@/components/ui';
import { PrimaryButton } from '@/components/actions';
import { ManualMessageDownload } from '@/components/manual-message-download';
import { readPracticeCommunications } from '@/lib/approved-communications';
import { mutateApprovedMessageAction } from '@/lib/approved-communication-actions';
import { ApprovedCommunicationError, approvedMessageLabels, communicationContextSchema, type ApprovedMessageSnapshot, type ApprovedMessageState, type CommunicationContext } from '@/lib/approved-communication-contract';

export const dynamic = 'force-dynamic';
const field = 'w-full rounded-xl border p-2';
type Data = Awaited<ReturnType<typeof readPracticeCommunications>>;
function ContextFields({ context }: { context: CommunicationContext }) {
  return <><input type="hidden" name="contextKind" value={context.kind} /><input type="hidden" name="contextId" value={context.id} /></>;
}
function BindingFields({ context, message }: { context: CommunicationContext; message: Data['messages'][number] }) {
  return <><ContextFields context={context} /><input type="hidden" name="messageId" value={message.id} />
    <input type="hidden" name="expectedRevision" value={message.currentRevision} /><input type="hidden" name="snapshotHash" value={message.snapshotHash} /></>;
}
function Draft({ data, snapshot }: { data: Data; snapshot?: ApprovedMessageSnapshot }) {
  return <form action={mutateApprovedMessageAction} className="grid gap-3">
    <ContextFields context={data.context} /><input type="hidden" name="intent" value="draft" />
    <input type="hidden" name="messageId" value={snapshot?.messageId ?? randomUUID()} /><input type="hidden" name="expectedRevision" value={snapshot?.revision ?? 0} />
    <label>Mittente<select required className={field} name="mailboxId" defaultValue={snapshot?.mailboxId ?? ''}>
      <option value="" disabled>Seleziona una casella registrata</option>{data.mailboxes.map(box => <option key={box.id} value={box.id}>{box.address}{box.qualification.enabled ? ' · abilitata' : ' · da qualificare'}</option>)}
    </select></label>
    <label>Reply-To<input required className={field} type="email" name="replyTo" defaultValue={snapshot?.replyTo} /></label>
    <label>A · indirizzi separati da virgola<input required className={field} name="to" defaultValue={snapshot?.to.join(', ')} /></label>
    <div className="grid gap-3 md:grid-cols-2"><label>CC esplicita<input className={field} name="cc" defaultValue={snapshot?.cc.join(', ')} /></label><label>BCC esplicita<input className={field} name="bcc" defaultValue={snapshot?.bcc.join(', ')} /></label></div>
    <label>Oggetto<input required maxLength={998} className={field} name="subject" defaultValue={snapshot?.subject} /></label>
    <label>Testo esatto<textarea required rows={8} maxLength={200000} className={field} name="body" defaultValue={snapshot?.body} /></label>
    <label>Riservatezza<select name="classification" className={field} defaultValue={snapshot?.classification ?? 'ORDINARY'}><option value="ORDINARY">Ordinaria</option><option value="SENSITIVE">Materiale sensibile</option>{data.isAdmin ? <option value="COMPLAINT">Reclamo · solo admin</option> : null}</select></label>
    <fieldset className="rounded-xl border p-3"><legend>Allegati · versioni esatte</legend>
      {data.documents.length ? data.documents.map(doc => <div key={doc.id}><b>{doc.title}</b>{doc.versions.map(version => <label key={version.id} className="ml-3 inline-flex gap-2"><input type="checkbox" name="attachmentVersionId" value={version.id} defaultChecked={snapshot?.attachments.some(a => a.versionId === version.id)} />Versione {version.version}</label>)}</div>) : <p>Nessun documento disponibile per il tuo accesso.</p>}
    </fieldset>
    <p className="text-sm text-slate-600">Ogni modifica crea una nuova versione da approvare. Nessun destinatario viene aggiunto automaticamente.</p>
    <PrimaryButton type="submit">{snapshot ? 'Salva nuova versione da approvare' : 'Salva bozza'}</PrimaryButton>
  </form>;
}

export default async function Page({ searchParams }: { searchParams: Promise<{ kind?: string; practice?: string; result?: string; page?: string }> }) {
  const query = await searchParams, session = await requirePermission('practice_communications.read');
  const context = communicationContextSchema.safeParse({ kind: query.kind, id: query.practice });
  if (!context.success) return <div className="space-y-5"><PageHeader title="Comunicazioni approvate" description="Apri le comunicazioni dalla pratica interessata." /><Link className="font-bold underline" href="/practice-readiness">Pratiche da preventivo ad avvio</Link><br /><Link className="font-bold underline" href="/technical-office/practices">Pratiche tecniche</Link>{session.role === 'admin' ? <p><Link href="/settings/communications" className="font-bold underline">Caselle e risposte da riconciliare</Link></p> : null}</div>;
  let data: Data;
  try { data = await readPracticeCommunications(prisma, session, context.data, query.page === undefined ? 1 : Number(query.page)); }
  catch (error) { if (error instanceof ApprovedCommunicationError) notFound(); throw error; }
  const feedback: Record<string, string> = { RECORDED: 'Operazione registrata.', DENIED: 'Accesso o contesto non più valido.', CONFLICT: 'La versione è cambiata o l’operazione è già conclusa. Aggiorna e verifica la timeline.', SENDER_NOT_READY: 'Il mittente deve essere configurato, collaudato e abilitato.', INVALID: 'Controlla i campi del messaggio e i limiti degli allegati.', RECONCILIATION_REQUIRED: 'Registra o riconcilia il tentativo aperto prima di prepararne un altro.' };
  return <div className="space-y-6"><PageHeader title="Comunicazioni approvate" description={`Pratica di ${data.client.name}. Email esterna manuale con approvazione nel CRM.`} />
    <p className="text-sm">La preparazione scarica testo, destinatari e allegati approvati. L’invio avviene dal tuo client email; la ricevuta CRM è una dichiarazione manuale, non una conferma del provider.</p>
    {data.isAdmin ? <Link className="font-bold underline" href="/settings/communications">Caselle e risposte da riconciliare</Link> : null}
    {query.result && feedback[query.result] ? <p role="status" className="rounded-xl bg-slate-100 p-3">{feedback[query.result]}</p> : null}
    {data.canWrite ? <Card title="Nuova comunicazione"><Draft data={data} /></Card> : null}
    {data.messages.map(message => <Card key={message.id} title={`${message.snapshot.subject} · v${message.currentRevision}`}>
      <p className="font-bold">{approvedMessageLabels[message.state as ApprovedMessageState]}</p>
      <dl className="my-3 grid gap-1 text-sm"><div><dt className="inline font-bold">Da: </dt><dd className="inline">{message.snapshot.from}</dd></div><div><dt className="inline font-bold">Reply-To: </dt><dd className="inline">{message.snapshot.replyTo}</dd></div>
        <div><dt className="inline font-bold">A: </dt><dd className="inline">{message.snapshot.to.join(', ')}</dd></div><div><dt className="inline font-bold">CC: </dt><dd className="inline">{message.snapshot.cc.join(', ') || 'Nessuna'}</dd></div><div><dt className="inline font-bold">BCC: </dt><dd className="inline">{message.snapshot.bcc.join(', ') || 'Nessuna'}</dd></div></dl>
      <div className="whitespace-pre-wrap rounded-xl bg-slate-50 p-4">{message.snapshot.body}</div>
      <ul className="my-3 text-sm">{message.snapshot.attachments.map(file => <li key={file.versionId}>{file.filename} · {file.bytes} byte · versione {file.versionId} · SHA256 {file.sha256}</li>)}</ul>
      <div className="my-4 grid gap-4">
        {data.canWrite && ['DRAFT', 'PENDING', 'APPROVED', 'ERROR'].includes(message.state) ? <details><summary className="cursor-pointer font-bold">Modifica e invalida l’approvazione precedente</summary><Draft data={data} snapshot={message.snapshot} /></details> : null}
        {data.canWrite && message.state === 'DRAFT' ? <form action={mutateApprovedMessageAction}><BindingFields context={data.context} message={message} /><input type="hidden" name="intent" value="submit" /><PrimaryButton type="submit">Richiedi approvazione admin</PrimaryButton></form> : null}
        {data.isAdmin && message.state === 'PENDING' ? <form action={mutateApprovedMessageAction} className="grid gap-3"><BindingFields context={data.context} message={message} /><input type="hidden" name="intent" value="approve" /><label className="flex gap-2"><input type="checkbox" required name="exactApproval" value="APPROVO_IL_MESSAGGIO_ESATTO" />Approvo questo messaggio esatto, inclusi mittente, Reply-To, A/CC/BCC e versioni degli allegati.</label><PrimaryButton type="submit">Approva versione {message.currentRevision}</PrimaryButton></form> : null}
        {data.canPrepare && ['APPROVED', 'ERROR'].includes(message.state) ? <ManualMessageDownload messageId={message.id} revision={message.currentRevision} snapshotHash={message.snapshotHash} requestId={randomUUID()} /> : null}
        {data.canPrepare && message.state === 'SENDING' && message.attempts[0] ? <ManualMessageDownload messageId={message.id} revision={message.currentRevision} snapshotHash={message.snapshotHash} requestId={message.attempts[0].requestId} resume /> : null}
        {data.canPrepare && (message.state === 'SENDING' || (message.state === 'UNCERTAIN' && data.isAdmin)) && message.attempts[0] ? <form action={mutateApprovedMessageAction} className="grid gap-3 rounded-xl border p-4">
          <BindingFields context={data.context} message={message} /><input type="hidden" name="intent" value="evidence" /><input type="hidden" name="attemptId" value={message.attempts[0].id} /><input type="hidden" name="reconciliation" value={String(message.state === 'UNCERTAIN')} />
          <h3 className="font-bold">{message.state === 'UNCERTAIN' ? 'Riconciliazione admin dell’esito incerto' : 'Registra l’esito manuale'}</h3>
          <label>Esito<select className={field} name="outcome"><option value="UNCERTAIN">Incerto · non ripetere</option><option value="SENT">Invio dichiarato eseguito</option><option value="NOT_SENT">Non inviata · verificato</option></select></label>
          <label>Data e ora con fuso<input className={field} name="occurredAt" defaultValue={new Date().toISOString()} required /></label>
          <label>Riferimento della ricevuta esterna<input className={field} name="reference" required maxLength={500} /></label><label>Nota<textarea className={field} name="note" maxLength={2000} /></label>
          <PrimaryButton type="submit">Registra dichiarazione</PrimaryButton>
        </form> : null}
      </div>
      <details><summary className="cursor-pointer font-bold">Timeline e versioni</summary><p className="break-all text-xs">Riferimento: {message.id} · impronta del messaggio: {message.snapshotHash}</p><ol className="mt-3 space-y-2 text-sm">{message.events.map(event => <li key={event.id}>{event.createdAt.toISOString()} · {event.event}{event.event.startsWith('MANUAL_OUTCOME') ? <span> · dichiarazione manuale conservata</span> : null}</li>)}</ol><p className="mt-3 text-sm">Versioni conservate: {message.versions.map(version => `v${version.revision}`).join(', ')}.</p></details>
      <div className="mt-4"><h3 className="font-bold">Risposte acquisite manualmente</h3>{message.replies.map(reply => <article className="mt-3 rounded-xl border p-3" key={reply.id}><p>{reply.receivedAt.toISOString()} · {reply.sender}</p><h4 className="font-bold">{reply.subject}</h4><p className="whitespace-pre-wrap">{reply.body}</p><p className="text-xs">Evidenza dichiarata: {reply.evidenceReference}</p></article>)}{message.replies.length === 0 ? <p>Nessuna risposta collegata.</p> : null}</div>
    </Card>)}
    <nav aria-label="Pagine comunicazioni" className="flex gap-4">{data.page > 1 ? <Link href={`/communications?kind=${data.context.kind}&practice=${encodeURIComponent(data.context.id)}&page=${data.page - 1}`}>Pagina precedente</Link> : null}{data.hasMore ? <Link href={`/communications?kind=${data.context.kind}&practice=${encodeURIComponent(data.context.id)}&page=${data.page + 1}`}>Pagina successiva</Link> : null}</nav>
    <p className="text-xs text-slate-500">Fino a 100 comunicazioni per pagina, filtrate per accesso. Gli invii nativi email e WhatsApp non sono attivi.</p>
  </div>;
}
