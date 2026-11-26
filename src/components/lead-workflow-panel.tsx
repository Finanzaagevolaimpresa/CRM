import Link from 'next/link';
import { randomUUID } from 'node:crypto';
import { workflowEventLabels } from '@/lib/workflow-automation-contract';
import type { AuthSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permission-evaluator';
import { prisma } from '@/lib/prisma';
import { readLeadWorkflowExecutions, readNativeWorkflowLeadSetup, readSyntheticWorkflowLeadSetup } from '@/lib/workflow-executions';
import { runWorkflowNativeEventAction, runWorkflowSyntheticAction } from '@/lib/workflow-execution-actions';
import { PrimaryButton } from './actions';
import { readPracticeCommunications } from '@/lib/approved-communications';
import { ApprovedCommunicationError } from '@/lib/approved-communication-contract';
import { communicationDeliveryLabel } from '@/lib/ordinary-email-receipt';
import { formatRecordNoticeTime } from '@/lib/record-notice-time';
import { Card, Badge } from './ui';

const executionLabels: Record<string, string> = { PENDING: 'In attesa', PREPARED: 'Bozza email preparata · da approvare', SENT: 'Invio registrato su evidenza',
  UNCERTAIN: 'Esito incerto · da riconciliare', ERROR: 'Errore', STOPPED: 'Interrotta' };
export async function LeadWorkflowPanel({ session, leadId }: { session: AuthSession; leadId: string }) {
  const enrollments = await readLeadWorkflowExecutions(prisma, session, leadId);
  const setup = await readSyntheticWorkflowLeadSetup(prisma, session, leadId);
  const nativeSetup = await readNativeWorkflowLeadSetup(prisma, session, leadId);
  let communications: Awaited<ReturnType<typeof readPracticeCommunications>> | null = null;
  if (hasPermission(session, 'practice_communications.read')) {
    try { communications = await readPracticeCommunications(prisma, session, { kind: 'LEAD', id: leadId }); }
    catch (error) { if (!(error instanceof ApprovedCommunicationError)) throw error; }
  }
  return <Card title="Comunicazioni e prossimi invii">
    {setup && setup.rules.length > 0 && setup.receipts.length > 0 && <form action={runWorkflowSyntheticAction} className="mb-4 grid gap-2 rounded-xl border p-3">
      <p className="font-bold">Prova persistente sul solo database sintetico</p>
      <input type="hidden" name="intent" value="enroll" /><input type="hidden" name="leadId" value={leadId} />
      <label>Sequenza<select name="automationId" className="ml-2 rounded border p-2">{setup.rules.map(rule => <option key={rule.id} value={rule.id}>{rule.name} · v{rule.version}</option>)}</select></label>
      <label>Ricevuta<select name="receiptId" className="ml-2 rounded border p-2">{setup.receipts.map(receipt => <option key={receipt.id} value={receipt.id}>{formatRecordNoticeTime(receipt.createdAt)} · {receipt.id.slice(0, 8)}</option>)}</select></label>
      <PrimaryButton type="submit">Registra sequenza e prova conferma</PrimaryButton>
    </form>}
    {[{ setup, synthetic: true }, { setup: nativeSetup, synthetic: false }].flatMap(({ setup: eventSetup, synthetic }) => eventSetup
      ? (['APPOINTMENT_BOOKED', 'ASSIGNMENT_CONFIRMED', 'STATUS_CHANGED', 'DOCUMENT_REQUESTED'] as const).map(kind => {
      const rules = eventSetup.eventRules.filter(rule => rule.event === kind), source = eventSetup.sources.find(item => item.kind === kind);
      if (!rules.length || (!source && kind !== 'DOCUMENT_REQUESTED')) return null;
      return <form key={`${synthetic}-${kind}`} action={synthetic ? runWorkflowSyntheticAction : runWorkflowNativeEventAction} className="mb-4 grid gap-2 rounded-xl border p-3">
        <p className="font-bold">{synthetic ? 'Prova persistente' : 'Registra sequenza'} · {workflowEventLabels[kind]}</p>
        {!synthetic && <p className="text-sm">La sequenza resta in attesa della preparazione da Automazioni. Le email richiedono l’approvazione prevista.</p>}
        <input type="hidden" name="intent" value="event-enroll" /><input type="hidden" name="leadId" value={leadId} />
        <input type="hidden" name="leadVersion" value={eventSetup.leadVersion} /><input type="hidden" name="sourceKind" value={kind} />
        <input type="hidden" name="sourceId" value={source?.referenceId ?? randomUUID()} />
        <input type="hidden" name="sourceVersion" value={source?.referenceVersion ?? ''} /><input type="hidden" name="sourceOrigin" value={source?.origin ?? ''} />
        <label>Regola<select name="automationId" className="ml-2 rounded border p-2">{rules.map(rule => <option key={rule.id} value={rule.id}>{rule.name} · v{rule.version}</option>)}</select></label>
        {kind === 'DOCUMENT_REQUESTED' && <label>Documenti richiesti, uno per riga<textarea name="documents" required className="block w-full rounded border p-2" /></label>}
        <PrimaryButton type="submit">{synthetic ? 'Registra evento e prova il primo passaggio' : 'Registra sequenza'}</PrimaryButton>
      </form>;
    }) : [])}
    {communications && <><Link className="font-bold text-fai-blue underline" href={`/communications?kind=LEAD&practice=${encodeURIComponent(leadId)}`}>Apri comunicazioni, ricevute e risposte</Link>
      {communications.messages.slice(0, 5).map(message => <article key={message.id} className="mt-3 rounded-xl border p-3">
        <h3 className="font-bold">{message.snapshot.subject}</h3><p>{communicationDeliveryLabel(message.state, message.currentRevision, message.ordinaryReceipts, message.attempts)}</p>
        <p className="text-sm">Risposte collegate: {message.replies.length} · ultimo aggiornamento {formatRecordNoticeTime(message.updatedAt)}</p>
      </article>)}
    </>}
    {!communications?.messages.length && !enrollments.length && <p>Nessuna comunicazione o sequenza registrata per questa scheda.</p>}
    {enrollments.map(enrollment => <section key={enrollment.id} className="mt-4 space-y-2">
      {enrollment.synthetic && <Badge tone="purple">Prova sintetica · nessun invio reale</Badge>}
      {setup && enrollment.synthetic && enrollment.state === 'PENDING' && <form action={runWorkflowSyntheticAction}>
        <input type="hidden" name="intent" value="run" /><input type="hidden" name="leadId" value={leadId} /><input type="hidden" name="enrollmentId" value={enrollment.id} />
        <PrimaryButton type="submit">Prova i passaggi giunti a scadenza</PrimaryButton>
      </form>}
      {enrollment.executions.map(execution => <article key={execution.id} className="rounded-xl border p-3">
        <h3 className="font-bold">{execution.internal ? 'Avviso interno' : execution.step === 'FOLLOW_UP' ? 'Sollecito' : execution.step === 'REMINDER' ? 'Promemoria appuntamento' : 'Conferma'}</h3>
        <p>{execution.internal && execution.state === 'SENT' ? 'Avviso registrato per il destinatario' : enrollment.synthetic && execution.state === 'SENT' ? 'Accettata nel canale di prova' : executionLabels[execution.state] ?? execution.state} · {formatRecordNoticeTime(execution.dueAt)}</p>
        {execution.notice && <p className="whitespace-pre-wrap text-sm">{execution.notice.title}: {execution.notice.body}</p>}
        {execution.stopReason && <p className="text-sm">{execution.stopReason === 'REPLIED' ? 'Terminata dopo una risposta.'
          : execution.stopReason === 'APPOINTMENT_BOOKED' ? 'Terminata dopo la prenotazione.'
          : execution.stopReason === 'RECONCILE_BEFORE_RETRY' ? 'Controllare la ricevuta prima di riprovare.'
          : execution.stopReason === 'SOURCE_CHANGED' ? 'Evento o destinatario cambiato: verificare la scheda e preparare il passaggio aggiornato.'
          : execution.stopReason.startsWith('MISSING_FIELDS:') ? 'Completare i campi richiesti dal modello.' : 'Controllare il registro della sequenza.'}</p>}
      </article>)}
    </section>)}
  </Card>;
}
