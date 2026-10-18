import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAnyPermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { Card, PageHeader } from '@/components/ui';
import { PrimaryButton } from '@/components/actions';
import { ManualMessageDownload } from '@/components/manual-message-download';
import { OrdinaryEmailReceipts } from '@/components/ordinary-email-receipts';
import { OrdinaryEmailReview } from '@/components/ordinary-email-review';
import { OrdinaryEmailInboundRefresh } from '@/components/ordinary-email-inbound-refresh';
import { OrdinaryEmailAttachmentDownload } from '@/components/ordinary-email-attachment-download';
import { CommunicationRecipients } from '@/components/communication-recipients';
import { CommunicationFiles } from '@/components/communication-files';
import { hasPermission } from '@/lib/permission-evaluator';
import { InternalCommunicationEditor } from '@/components/internal-communication-editor';
import { listInternalCommunications, readCommunicationDirectory } from '@/lib/internal-communications';
import { sanitizeFileName } from '@/lib/storage';
import { ordinaryEmailUiAuthorityFromRequest } from '@/lib/ordinary-email-server-candidate';
import { communicationDeliveryLabel, hasBlockingOrdinaryReceipt } from '@/lib/ordinary-email-receipt';
import { readPracticeCommunications } from '@/lib/approved-communications';
import { readRecordUpdateEmailPrefill } from '@/lib/record-update-email-queue';
import { RecordUpdateError } from '@/lib/record-update-contract';
import { emptyCommunicationRecipientSelection } from '@/lib/communication-recipient-policy';
import { mutateApprovedMessageAction } from '@/lib/approved-communication-actions';
import { ApprovedCommunicationError, communicationContextSchema, type ApprovedMessageSnapshot, type CommunicationContext } from '@/lib/approved-communication-contract';

export const dynamic = 'force-dynamic';
const field = 'min-w-0 w-full max-w-full rounded-xl border p-2';
type Data = Awaited<ReturnType<typeof readPracticeCommunications>>;
function ContextFields({ context }: { context: CommunicationContext }) {
  return <><input type="hidden" name="contextKind" value={context.kind} /><input type="hidden" name="contextId" value={context.id} /></>;
}
function BindingFields({ context, message }: { context: CommunicationContext; message: Data['messages'][number] }) {
  return <><ContextFields context={context} /><input type="hidden" name="messageId" value={message.id} />
    <input type="hidden" name="expectedRevision" value={message.currentRevision} /><input type="hidden" name="snapshotHash" value={message.snapshotHash} /></>;
}
type UpdateDraft = NonNullable<Data['messages'][number]['updateDraft']> & { subject?: string; body?: string; mailboxId?: string };
function Draft({ data, snapshot, replySource, updateDraft }: { data: Data; snapshot?: ApprovedMessageSnapshot;
  updateDraft?: UpdateDraft;
  replySource?: { id: string; contentHash: string; classification: ApprovedMessageSnapshot['classification'] } }) {
  const updateSelection = emptyCommunicationRecipientSelection();
  if (updateDraft) updateSelection.to.userIds = [updateDraft.recipientId];
  return <form action={mutateApprovedMessageAction} className="grid min-w-0 gap-3" data-message-draft={snapshot?.messageId} data-reply-draft={replySource?.id}>
    <ContextFields context={data.context} /><input type="hidden" name="intent" value="draft" />
    {replySource ? <><input type="hidden" name="replySourceId" value={replySource.id} /><input type="hidden" name="replySourceHash" value={replySource.contentHash} />
      <p>Prepara una nuova bozza. Scegli mittente, destinatari e allegati; poi scrivi il testo da sottoporre ad approvazione.</p></> : null}
    <input type="hidden" name="messageId" value={snapshot?.messageId ?? updateDraft?.deliveryId ?? randomUUID()} /><input type="hidden" name="expectedRevision" value={snapshot?.revision ?? 0} />
    <label>Mittente<select required className={field} name="mailboxId" defaultValue={snapshot?.mailboxId ?? ''}>
      <option value="" disabled>Seleziona una casella registrata</option>{data.mailboxes.filter(box => !updateDraft?.mailboxId || box.id === updateDraft.mailboxId).map(box => <option key={box.id} value={box.id}>{box.address}{box.qualification.enabled ? ' · abilitata' : ' · da qualificare'}</option>)}
    </select></label>
    <label>Reply-To<input required className={field} type="email" name="replyTo" defaultValue={snapshot?.replyTo} /></label>
    {updateDraft ? <section className="rounded-xl border p-3" aria-label="Destinatario dell’aggiornamento">
      <input type="hidden" name="updateDeliveryId" value={updateDraft.deliveryId} /><input type="hidden" name="updateSourceHash" value={updateDraft.sourceHash} />
      <input type="hidden" name="recipientSelection" value={JSON.stringify(updateSelection)} />
      <p className="break-words font-bold">A: {updateDraft.recipientName} · {updateDraft.recipientAddress}</p>
      <p>Questa bozza riguarda il destinatario scelto in Chi aggiornare. Ogni persona ha una bozza distinta. CC e BCC sono vuoti.</p>
      {updateDraft.stale && <p role="status">Il record è cambiato: controlla il testo e salva una nuova versione prima dell’approvazione.</p>}
    </section> : <CommunicationRecipients directory={data.directory} internal={data.context.kind === 'INTERNAL'} participantIds={data.participantIds}
      suggestedRecipients={data.suggestedRecipients}
      initialSelection={snapshot?.schema === 'fai.approved-email.v2' ? snapshot.recipientSelection : undefined}
      initialExternal={snapshot?.schema === 'fai.approved-email.v2' ? snapshot.externalRecipients : snapshot ? { to: snapshot.to, cc: snapshot.cc, bcc: snapshot.bcc } : undefined} />}
    <label>Oggetto<input required maxLength={998} className={field} name="subject" defaultValue={snapshot?.subject ?? updateDraft?.subject} /></label>
    <label>Testo esatto<textarea required rows={8} maxLength={200000} className={field} name="body" defaultValue={snapshot?.body ?? updateDraft?.body} /></label>
    <label>Riservatezza<select name="classification" className={field} defaultValue={snapshot?.classification ?? replySource?.classification ?? 'ORDINARY'}><option value="ORDINARY">Ordinaria</option><option value="SENSITIVE">Materiale sensibile</option>{data.isAdmin ? <option value="COMPLAINT">Reclamo · solo admin</option> : null}</select></label>
    <fieldset className="min-w-0 rounded-xl border p-3"><legend>Allegati · versioni esatte</legend>
      {data.contextFiles.map(file => <label key={file.id} className="flex items-start gap-2 break-words"><input type="checkbox" name="contextFileId" value={file.id}
        defaultChecked={snapshot?.schema === 'fai.approved-email.v2' && snapshot.attachments.some(a => a.source === 'CONTEXT_FILE' && a.versionId === file.id)} />{file.fileName} · {file.sizeBytes} byte</label>)}
      {data.documents.length ? data.documents.map(doc => <div key={doc.id}><b>{doc.title}</b>{doc.versions.map(version => <label key={version.id} className="ml-3 inline-flex gap-2"><input type="checkbox" name="attachmentVersionId" value={version.id} defaultChecked={snapshot?.attachments.some(a => a.versionId === version.id)} />Versione {version.version}</label>)}</div>) : <p>Nessun documento disponibile per il tuo accesso.</p>}
    </fieldset>
    <p className="text-sm text-slate-600">Ogni modifica crea una nuova versione da approvare. Nessun destinatario viene aggiunto automaticamente.</p>
    <PrimaryButton type="submit">{snapshot ? 'Salva nuova versione da approvare' : 'Salva bozza'}</PrimaryButton>
  </form>;
}

export default async function Page({ searchParams }: { searchParams: Promise<{ kind?: string; practice?: string; result?: string; page?: string; reply?: string; update?: string }> }) {
  const query = await searchParams, session = await requireAnyPermission(['practice_communications.read', 'communications.internal.read']);
  const context = communicationContextSchema.safeParse({ kind: query.kind, id: query.practice });
  if (!context.success) {
    if (query.kind || query.practice || query.update) notFound();
    const threads = hasPermission(session,'communications.internal.read') ? await listInternalCommunications(prisma, session) : [];
    const authority = await ordinaryEmailUiAuthorityFromRequest(session);
    const directory = authority ? await readCommunicationDirectory(prisma, session) : [];
    return <div className="min-w-0 crm-space-y-5 [overflow-wrap:anywhere]"><PageHeader title="Comunicazioni" description="Scrivi dal lead, dal cliente o dalla pratica. Le conversazioni interne restano riservate ai partecipanti confermati." />
      <nav className="flex flex-wrap gap-4"><Link className="font-bold underline" href="/leads">Lead</Link><Link className="font-bold underline" href="/clients">Clienti</Link><Link className="font-bold underline" href="/practice-readiness">Pratiche da avviare</Link><Link className="font-bold underline" href="/technical-office/practices">Pratiche tecniche</Link></nav>
      {authority ? <Link className="font-bold underline" href="/communications/updates">Bozze da aggiornamenti</Link> : null}
      {authority ? <Card title="Nuova comunicazione interna"><InternalCommunicationEditor id={randomUUID()} people={directory} stepUpActive={authority.stepUpActive} /></Card> : null}
      <Card title="Conversazioni interne a cui partecipi"><ul className="grid gap-3">{threads.map(thread => <li key={thread.id}><Link className="font-bold underline" href={`/communications?kind=INTERNAL&practice=${thread.id}`}>{thread.title}</Link></li>)}</ul>{threads.length === 0 ? <p>Nessuna conversazione disponibile.</p> : null}</Card>
      {session.role === 'admin' ? <Link className="font-bold underline" href="/settings/communications">Caselle e risposte da riconciliare</Link> : null}
    </div>;
  }
  let updatePrefill: Awaited<ReturnType<typeof readRecordUpdateEmailPrefill>> | undefined;
  if (query.update) {
    if (query.reply) notFound();
    try { updatePrefill = await readRecordUpdateEmailPrefill(prisma, session, query.update); }
    catch (error) { if (error instanceof RecordUpdateError) notFound(); throw error; }
    if (updatePrefill.context.kind !== context.data.kind || updatePrefill.context.id !== context.data.id) notFound();
  }
  let data: Data;
  try { data = await readPracticeCommunications(prisma, session, context.data, query.page === undefined ? 1 : Number(query.page),
    updatePrefill?.saved ? updatePrefill.deliveryId : undefined); }
  catch (error) { if (error instanceof ApprovedCommunicationError) notFound(); throw error; }
  const replyParent = query.reply ? data.messages.find(message => message.replies.some(reply => reply.id === query.reply)) : undefined;
  const replySource = replyParent?.replies.find(reply => reply.id === query.reply);
  if (query.reply && (!data.canWrite || !replySource)) notFound();
  const ordinaryAuthority = await ordinaryEmailUiAuthorityFromRequest(session);
  const feedback: Record<string, string> = { RECORDED: 'Operazione registrata.', DENIED: 'Accesso o contesto non più valido.', CONFLICT: 'La versione è cambiata o l’operazione è già conclusa. Aggiorna e verifica la timeline.', SENDER_NOT_READY: 'Il mittente deve essere configurato, collaudato e abilitato.', INVALID: 'Controlla i campi del messaggio e i limiti degli allegati.', RECONCILIATION_REQUIRED: 'Registra o riconcilia il tentativo aperto prima di prepararne un altro.' };
  return <div className="min-w-0 crm-space-y-6 [overflow-wrap:anywhere]"><PageHeader title="Comunicazioni approvate" description={`Comunicazioni · ${data.label}`} />
    <Link className="font-bold underline" href="/communications">Tutte le comunicazioni</Link>
    {data.thread && data.personal && data.thread.ownerUserId === session.userId ? <details className="rounded-xl border p-3"><summary className="cursor-pointer font-bold">Gestisci partecipanti della conversazione interna</summary>
      <InternalCommunicationEditor key={`${data.thread.id}-${data.thread.version}`} id={data.thread.id} version={data.thread.version} title={data.thread.title}
        selectedIds={data.participantIds} people={data.directory} stepUpActive={ordinaryAuthority?.stepUpActive ?? false} /></details> : null}
    <p className="text-sm">Per l’invio manuale, scarica il messaggio approvato e usa il tuo client email. Quando l’invio dal CRM è disponibile, scegli «Approva e invia» sulla versione esatta. Le due modalità conservano ricevute distinte.</p>
    {data.isAdmin ? <Link className="font-bold underline" href="/settings/communications">Caselle e risposte da riconciliare</Link> : null}
    {query.result && feedback[query.result] ? <p role="status" className="rounded-xl bg-slate-100 p-3">{feedback[query.result]}</p> : null}
    <details className="rounded-xl border p-3"><summary className="cursor-pointer font-bold">Allegati del contesto</summary>
      <CommunicationFiles key={`${data.context.kind}-${data.context.id}-${data.contextFiles.map(file=>file.id).join(',')}`}
        context={data.context} files={data.contextFiles} canWrite={data.canWrite && data.personal} requestId={randomUUID()} />
    </details>
    {data.canWrite && !updatePrefill?.saved ? <Card title={updatePrefill ? 'Bozza da aggiornamento' : replySource ? 'Bozza da risposta ricevuta' : 'Nuova comunicazione'}>
      {replySource ? <aside className="mb-4 rounded-xl border p-3"><p>{replySource.sender} · {replySource.receivedAt.toISOString()}</p>
        <h3 className="font-bold">{replySource.subject}</h3><p className="whitespace-pre-wrap break-words">{replySource.body}</p>
        <p className="text-sm">Testo ricevuto dall’esterno, da valutare prima di rispondere.</p></aside> : null}
      <Draft data={data} updateDraft={updatePrefill} replySource={replySource && replyParent ? { id: replySource.id, contentHash: replySource.contentHash, classification: replyParent.snapshot.classification } : undefined} />
    </Card> : null}
    {data.messages.map(message => <Card key={message.id} title={`${message.snapshot.subject} · v${message.currentRevision}`}>
      <p className="font-bold">{communicationDeliveryLabel(message.state, message.currentRevision, message.ordinaryReceipts, message.attempts)}</p>
      <dl className="my-3 grid gap-1 text-sm"><div><dt className="inline font-bold">Da: </dt><dd className="inline">{message.snapshot.from}</dd></div><div><dt className="inline font-bold">Reply-To: </dt><dd className="inline">{message.snapshot.replyTo}</dd></div>
        <div><dt className="inline font-bold">A: </dt><dd className="inline">{message.snapshot.to.join(', ')}</dd></div><div><dt className="inline font-bold">CC: </dt><dd className="inline">{message.snapshot.cc.join(', ') || 'Nessuna'}</dd></div><div><dt className="inline font-bold">BCC: </dt><dd className="inline">{message.snapshot.bcc.join(', ') || 'Nessuna'}</dd></div></dl>
      <div className="whitespace-pre-wrap rounded-xl bg-slate-50 p-4">{message.snapshot.body}</div>
      <ul className="my-3 min-w-0 break-all text-sm">{message.snapshot.attachments.map(file => <li key={file.versionId}>{file.filename} · {file.bytes} byte · versione {file.versionId} · SHA256 {file.sha256}</li>)}</ul>
      <OrdinaryEmailReceipts receipts={message.ordinaryReceipts} />
      <div className="my-4 grid gap-4">
        {data.canWrite && (!message.updateDeliveryId || message.updateDraft) && ['DRAFT', 'PENDING', 'APPROVED', 'ERROR'].includes(message.state) ? <OrdinaryEmailReview
          key={`${message.id}-${message.currentRevision}-${message.snapshotHash}`} messageId={message.id} revision={message.currentRevision} snapshotHash={message.snapshotHash}
          eligible={!message.updateDraft?.stale && ordinaryAuthority?.mailboxId === message.mailboxId && message.snapshot.classification === 'ORDINARY'
            && !hasBlockingOrdinaryReceipt(message.ordinaryReceipts) && !message.attempts.some(attempt => ['SENDING','UNCERTAIN','SENT'].includes(attempt.state))}
          stepUpActive={ordinaryAuthority?.stepUpActive ?? false}>
          <details><summary className="cursor-pointer font-bold">Modifica e invalida l’approvazione precedente</summary><Draft data={data} snapshot={message.snapshot} updateDraft={message.updateDraft ?? undefined} /></details>
        </OrdinaryEmailReview> : null}
        {data.canWrite && (!message.updateDeliveryId || (message.updateDraft && !message.updateDraft.stale)) && message.state === 'DRAFT' ? <form action={mutateApprovedMessageAction}><BindingFields context={data.context} message={message} /><input type="hidden" name="intent" value="submit" /><PrimaryButton type="submit">Richiedi approvazione admin</PrimaryButton></form> : null}
        {data.isAdmin && (!message.updateDeliveryId || (message.updateDraft && !message.updateDraft.stale)) && message.state === 'PENDING' ? <form action={mutateApprovedMessageAction} className="grid gap-3"><BindingFields context={data.context} message={message} /><input type="hidden" name="intent" value="approve" /><label className="flex gap-2"><input type="checkbox" required name="exactApproval" value="APPROVO_IL_MESSAGGIO_ESATTO" />Approvo questo messaggio esatto, inclusi mittente, Reply-To, A/CC/BCC e versioni degli allegati.</label><PrimaryButton type="submit">Approva versione {message.currentRevision}</PrimaryButton></form> : null}
        {data.canPrepare && !hasBlockingOrdinaryReceipt(message.ordinaryReceipts) && ['APPROVED', 'ERROR'].includes(message.state) ? <ManualMessageDownload messageId={message.id} revision={message.currentRevision} snapshotHash={message.snapshotHash} requestId={randomUUID()} /> : null}
        {data.canPrepare && !hasBlockingOrdinaryReceipt(message.ordinaryReceipts) && message.state === 'SENDING' && message.attempts[0] ? <ManualMessageDownload messageId={message.id} revision={message.currentRevision} snapshotHash={message.snapshotHash} requestId={message.attempts[0].requestId} resume /> : null}
        {data.canPrepare && !hasBlockingOrdinaryReceipt(message.ordinaryReceipts) && (message.state === 'SENDING' || (message.state === 'UNCERTAIN' && data.isAdmin)) && message.attempts[0] ? <form action={mutateApprovedMessageAction} className="grid gap-3 rounded-xl border p-4">
          <BindingFields context={data.context} message={message} /><input type="hidden" name="intent" value="evidence" /><input type="hidden" name="attemptId" value={message.attempts[0].id} /><input type="hidden" name="reconciliation" value={String(message.state === 'UNCERTAIN')} />
          <h3 className="font-bold">{message.state === 'UNCERTAIN' ? 'Riconciliazione admin dell’esito incerto' : 'Registra l’esito manuale'}</h3>
          <label>Esito<select className={field} name="outcome"><option value="UNCERTAIN">Incerto · non ripetere</option><option value="SENT">Invio dichiarato eseguito</option><option value="NOT_SENT">Non inviata · verificato</option></select></label>
          <label>Data e ora con fuso<input className={field} name="occurredAt" defaultValue={new Date().toISOString()} required /></label>
          <label>Riferimento della ricevuta esterna<input className={field} name="reference" required maxLength={500} /></label><label>Nota<textarea className={field} name="note" maxLength={2000} /></label>
          <PrimaryButton type="submit">Registra dichiarazione</PrimaryButton>
        </form> : null}
      </div>
      <details><summary className="cursor-pointer font-bold">Timeline e versioni</summary><p className="break-all text-xs">Riferimento: {message.id} · impronta del messaggio: {message.snapshotHash}</p><ol className="mt-3 crm-space-y-2 text-sm">{message.events.map(event => <li key={event.id}>{event.createdAt.toISOString()} · {event.event === 'ORDINARY_REJECTED' ? 'Versione rifiutata · nuova bozza da approvare' : event.event}{event.event.startsWith('MANUAL_OUTCOME') ? <span> · dichiarazione manuale conservata</span> : null}</li>)}</ol><p className="mt-3 text-sm">Versioni conservate: {message.versions.map(version => `v${version.revision}`).join(', ')}.</p></details>
      <div className="mt-4"><h3 className="font-bold">Risposte collegate</h3>
        {message.ordinaryReceipts.some(receipt => receipt.outcome === 'ACCEPTED') ? <OrdinaryEmailInboundRefresh messageId={message.id} revision={message.currentRevision} snapshotHash={message.snapshotHash} /> : null}
        {message.replies.map(reply => <article className="mt-3 break-words rounded-xl border p-3" key={reply.id} data-linked-reply={reply.id}>
          <p>{reply.receivedAt.toISOString()} · {reply.sender}</p><h4 className="font-bold">{reply.subject}</h4><p className="whitespace-pre-wrap">{reply.body}</p>
          <p className="text-xs">Riferimento di acquisizione: {reply.evidenceReference}</p>
          {reply.receivedAttachments.length ? <section aria-label="Allegati ricevuti" className="my-3 grid gap-2">
            <h5 className="font-bold">Allegati ricevuti</h5>
            {reply.receivedAttachments.map(file => <OrdinaryEmailAttachmentDownload key={file.ordinal}
              replyId={reply.id} file={file} downloadName={sanitizeFileName(file.filename)} />)}
            <p className="text-sm">File ricevuti dall’esterno. Il download non li aggiunge ai documenti della pratica o alla bozza.</p>
          </section> : null}
          {data.canWrite ? <Link className="font-bold underline" href={`/communications?kind=${data.context.kind}&practice=${encodeURIComponent(data.context.id)}&page=${data.page}&reply=${reply.id}`}>Prepara risposta</Link> : null}
        </article>)}{message.replies.length === 0 ? <p>Nessuna risposta collegata.</p> : null}</div>
    </Card>)}
    <nav aria-label="Pagine comunicazioni" className="flex gap-4">{data.page > 1 ? <Link href={`/communications?kind=${data.context.kind}&practice=${encodeURIComponent(data.context.id)}&page=${data.page - 1}`}>Pagina precedente</Link> : null}{data.hasMore ? <Link href={`/communications?kind=${data.context.kind}&practice=${encodeURIComponent(data.context.id)}&page=${data.page + 1}`}>Pagina successiva</Link> : null}</nav>
    <p className="text-xs text-slate-500">Fino a 100 comunicazioni per pagina, filtrate per accesso. L’invio dal CRM richiede la conferma personale della versione esatta. L’accettazione SMTP non attesta consegna o lettura.</p>
  </div>;
}
