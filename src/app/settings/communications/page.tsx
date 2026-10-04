import { notFound } from 'next/navigation';
import { requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readCommunicationAdministration } from '@/lib/approved-communications';
import { ApprovedCommunicationError } from '@/lib/approved-communication-contract';
import { mutateCommunicationAdministrationAction as act } from '@/lib/approved-communication-actions';
import { Card, PageHeader } from '@/components/ui';
import { PrimaryButton, SecondaryLink } from '@/components/actions';

export const dynamic = 'force-dynamic';
const field = 'w-full rounded-xl border p-2';
export default async function Page({ searchParams }: { searchParams: Promise<{ result?: string }> }) {
  const session = await requirePermission('practice_communications.read'), query = await searchParams;
  let data: Awaited<ReturnType<typeof readCommunicationAdministration>>;
  try { data = await readCommunicationAdministration(prisma, session); }
  catch (error) { if (error instanceof ApprovedCommunicationError) notFound(); throw error; }
  return <div className="crm-space-y-6"><PageHeader title="Caselle e risposte" description="Inventario email e prove dichiarate. Nessuna modifica a provider, DNS o credenziali." />
    {session.role === 'admin' ? <SecondaryLink href="/settings/communications/test">Test di invio diretto</SecondaryLink> : null}
    {query.result ? <p role="status">{query.result === 'RECORDED' ? 'Operazione registrata.' : 'Operazione non eseguita. Controlla versione, accesso, prova e campi.'}</p> : null}
    <p>Configurazione e test fanno riferimento a prove esterne già acquisite. Non inserire password, token o contenuti di configurazioni private. Per abilitare l’invio occorrono capacità di invio/ricezione e una prova della stessa revisione.</p>
    {data.mailboxes.map(box => <Card key={box.id} title={box.address}>
      <p>{box.purpose}</p><p className="my-2 font-bold">Registrata: sì · Configurata: {box.qualification.configured ? 'sì' : 'no'} · Collaudata: {box.qualification.tested ? 'sì' : 'no'} · Abilitata: {box.qualification.enabled ? 'sì' : 'no'}</p>
      <details><summary className="cursor-pointer font-bold">Registra o aggiorna la configurazione · revoca approvazioni precedenti</summary><form action={act} className="mt-3 grid gap-3">
        <input type="hidden" name="intent" value="configure" /><input type="hidden" name="mailboxId" value={box.id} /><input type="hidden" name="expectedRevision" value={box.revision} />
        <label>Tipo<select name="kind" className={field} defaultValue={box.kind === 'UNATTESTED' ? 'MAILBOX' : box.kind}><option value="MAILBOX">Casella</option><option value="ALIAS">Alias</option><option value="FORWARD">Inoltro · sola ricezione</option></select></label>
        <label>Casella canonica per alias/inoltro<select name="canonicalMailboxId" className={field} defaultValue={box.canonicalMailboxId ?? ''}><option value="">Nessuna · casella autonoma</option>{data.mailboxes.filter(other => other.id !== box.id && other.kind === 'MAILBOX').map(other => <option key={other.id} value={other.id}>{other.address}</option>)}</select></label>
        <label>Riferimento pubblico del provider<input required className={field} name="providerReference" defaultValue={box.providerReference ?? ''} maxLength={128} /></label>
        <label>Responsabile<select name="responsibleUserId" required className={field} defaultValue={box.responsibleUserId ?? ''}><option value="" disabled>Seleziona</option>{data.users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label>
        <label>Riferimento della configurazione verificata<input required className={field} name="configurationReference" maxLength={128} defaultValue={box.configurationReference ?? ''} /></label>
        <label><input type="checkbox" name="canSend" defaultChecked={box.canSend} /> Invio esterno manuale disponibile</label><label><input type="checkbox" name="canReceive" defaultChecked={box.canReceive} /> Ricezione disponibile</label><label><input type="checkbox" name="restricted" defaultChecked={box.restricted} /> Accesso riservato admin</label>
        <PrimaryButton type="submit">Registra configurazione</PrimaryButton>
      </form></details>
      {box.qualification.configured && !box.qualification.tested ? <form action={act} className="my-3 grid gap-2"><input type="hidden" name="intent" value="TEST" /><input type="hidden" name="mailboxId" value={box.id} /><input type="hidden" name="expectedRevision" value={box.revision} /><label>Riferimento del collaudo invio e ricezione già eseguito<input required name="testReference" className={field} maxLength={128} /></label><PrimaryButton type="submit">Registra prova esterna</PrimaryButton></form> : null}
      {box.qualification.tested && !box.enabled && box.canSend && box.canReceive ? <form action={act} className="mt-3"><input type="hidden" name="intent" value="ENABLE" /><input type="hidden" name="mailboxId" value={box.id} /><input type="hidden" name="expectedRevision" value={box.revision} /><PrimaryButton type="submit">Abilita per messaggi approvati</PrimaryButton></form> : null}
      {box.enabled ? <form action={act} className="mt-3"><input type="hidden" name="intent" value="DISABLE" /><input type="hidden" name="mailboxId" value={box.id} /><input type="hidden" name="expectedRevision" value={box.revision} /><PrimaryButton type="submit">Disabilita e richiedi nuovo collaudo</PrimaryButton></form> : null}
    </Card>)}
    <Card title="Acquisisci una risposta ricevuta"><p className="mb-3 text-sm">Trascrizione manuale da una casella qualificata. Non è una ricezione automatica. Nessuna approvazione in uscita è richiesta per acquisirla.</p><form action={act} className="grid gap-3">
      <input type="hidden" name="intent" value="reply" /><label>Casella<select required className={field} name="mailboxId">{data.mailboxes.filter(box => box.canReceive && box.qualification.tested).map(box => <option value={box.id} key={box.id}>{box.address}</option>)}</select></label>
      <label>Message-ID del messaggio ricevuto<input required name="externalMessageId" className={field} maxLength={255} /></label><label>In-Reply-To · se presente<input name="inReplyTo" className={field} maxLength={255} /></label>
      <label>Da<input required type="email" name="sender" className={field} /></label><label>Oggetto<input required name="subject" className={field} maxLength={998} /></label><label>Testo<textarea required name="body" className={field} rows={6} maxLength={200000} /></label>
      <label>Data di ricezione con fuso<input required name="receivedAt" className={field} defaultValue={new Date().toISOString()} /></label><label>Riferimento della prova<input required name="evidenceReference" className={field} maxLength={128} /></label><PrimaryButton type="submit">Acquisisci risposta</PrimaryButton>
    </form></Card>
    <Card title="Risposte da riconciliare"><p>Collegamento non univoco: scegli una comunicazione della pratica dopo aver verificato la risposta. Le 100 risposte più vecchie non ancora collegate sono mostrate qui.</p>{data.replies.map(reply => <article className="my-4 rounded-xl border p-4" key={reply.id}><h3 className="font-bold">{reply.subject}</h3><p>{reply.sender} · {reply.receivedAt.toISOString()}</p><p className="whitespace-pre-wrap">{reply.body}</p><form action={act} className="mt-3 grid gap-3"><input type="hidden" name="intent" value="link" /><input type="hidden" name="replyId" value={reply.id} /><label>Riferimento CRM della comunicazione<input required className={field} name="messageId" /></label><label>Motivo del collegamento<textarea required minLength={10} maxLength={1000} className={field} name="reason" /></label><PrimaryButton type="submit">Collega alla pratica</PrimaryButton></form></article>)}</Card>
  </div>;
}
