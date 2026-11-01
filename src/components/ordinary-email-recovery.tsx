'use client';

import { useActionState, useState } from 'react';
import { previewOrdinaryRecoveryAction, confirmOrdinaryRecoveryAction } from '@/lib/ordinary-email-reconciliation-actions';
import type { OrdinaryRecoveryResult } from '@/lib/ordinary-email-reconciliation-contract';
import { InlinePrivilegedConfirmation } from './inline-privileged-confirmation';

const initial: OrdinaryRecoveryResult = { status: 'UNAVAILABLE' };
const button = 'rounded-xl bg-blue-900 px-4 py-3 font-semibold text-white disabled:opacity-50';
const label = (outcome: 'ACCEPTED' | 'NOT_SENT') => outcome === 'ACCEPTED' ? 'Accettata dal server SMTP' : 'Non inviata · osservazione autorevole';
export function OrdinaryEmailRecovery({ messageId, attemptId }: { messageId: string; attemptId: string }) {
  const [preview, prepare, preparing] = useActionState(previewOrdinaryRecoveryAction,initial);
  const [result, confirm, confirming] = useActionState(confirmOrdinaryRecoveryAction,initial);
  const [reason, setReason] = useState('');
  const [submittedToken, setSubmittedToken] = useState<string | null>(null);
  const recorded = result.status === 'RECORDED' ? result : preview.status === 'RECORDED' ? preview : null;
  const ready = preview.status === 'READY' ? preview : null;
  const blocked = confirming || !!recorded || (ready?.token === submittedToken && result.status !== 'STEP_UP_REQUIRED');
  return <section aria-label="Riconciliazione esito SMTP" className="my-4 space-y-3 rounded-xl border border-amber-300 p-4">
    <h3 className="font-bold">Verifica e riconcilia questo tentativo</h3>
    <p>Si consulta la prova conservata dal trasporto. Nessun messaggio viene inviato o ripetuto e nessuna ricevuta precedente viene riscritta.</p>
    <form action={prepare}>
      <input type="hidden" name="messageId" value={messageId}/><input type="hidden" name="attemptId" value={attemptId}/>
      <button className={button} disabled={preparing || confirming}>Verifica prova ed esito dello stesso tentativo</button>
    </form>
    {preview.status === 'WAITING' && <p role="status">{{
      IN_PROGRESS: 'Il tentativo può essere ancora in corso. Attendi e verifica lo stesso riferimento.',
      NO_AUTHORITATIVE_OBSERVATION: 'Nessuna prova autorevole disponibile per questo tentativo. L’esito resta incerto e il reinvio bloccato.',
      RESERVED_WITHOUT_CLAIM: 'Prenotazione senza avvio del trasporto attestato. Il blocco resta conservato; nessun esito SMTP viene dedotto.',
      ALREADY_FINAL: 'Il tentativo possiede già un esito definitivo. Consulta la ricevuta conservata.',
    }[preview.reason]}</p>}
    {preview.status === 'UNAVAILABLE' && !ready && <p>La verifica richiede l’accesso Admin corrente al contesto e alla prova conservata.</p>}
    {recorded && <p role="status" className="break-all">Riconciliazione registrata: {label(recorded.outcome)} · {recorded.recordedAt} · riferimento {recorded.commandId} · SHA256 {recorded.sourceHash}. Nessun invio eseguito.</p>}
    {ready && !recorded && <form action={confirm} onSubmit={() => setSubmittedToken(ready.token)} className="space-y-3">
      <input type="hidden" name="messageId" value={messageId}/><input type="hidden" name="attemptId" value={attemptId}/>
      <input type="hidden" name="token" value={ready.token}/>
      <p className="break-all">Esito osservato: {label(ready.outcome)} · {ready.observedAt} · prova SHA256 {ready.sourceHash}.</p>
      <p>Anteprima valida fino a {ready.expiresAt}. Questa conferma registra il recupero della prova; non approva un nuovo invio.</p>
      <label className="block">Motivo della riconciliazione<textarea className="block w-full rounded border p-3" name="reason"
        minLength={3} maxLength={500} required value={reason} onChange={event => setReason(event.target.value)}/></label>
      <label className="flex gap-2"><input type="checkbox" name="confirmed" required disabled={blocked}/>
        Confermo la riconciliazione di questo tentativo con la sola prova riepilogata.</label>
      <button className={button} disabled={blocked || preparing}>Registra riconciliazione senza inviare</button>
    </form>}
    {result.status === 'STEP_UP_REQUIRED' && <><p role="status">Riconferma l’identità: motivo e scelte restano disponibili. Aggiorna poi l’anteprima e conferma personalmente.</p><InlinePrivilegedConfirmation/></>}
    {result.status === 'CHECK_CURRENT' && !recorded && <p role="status">Risposta non osservata. Verifica la prova e l’esito dello stesso tentativo prima di proseguire; nessun reinvio automatico.</p>}
  </section>;
}
