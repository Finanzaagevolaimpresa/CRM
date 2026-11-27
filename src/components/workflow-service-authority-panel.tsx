import { Card } from './ui';
import { PrimaryButton } from './actions';
import { mutateWorkflowAction } from '@/lib/workflow-automation-actions';
import { formatRecordNoticeTime } from '@/lib/record-notice-time';
import type { readWorkflowServiceAdministration } from '@/lib/workflow-service-authority';

type Data = Awaited<ReturnType<typeof readWorkflowServiceAdministration>>;
const field = 'mt-1 w-full rounded-xl border border-slate-300 p-2';
export function WorkflowServiceAuthorityPanel({ data,rules,enabled }: { data: Data;rules: Array<{ id: string;name: string;version: number;event: string;state: string }>;enabled: boolean }) {
  return <Card title="Esecuzione autorizzata delle sequenze">
    <p>{enabled ? 'Il runner può operare solo entro una delega valida, con mittente e controlli nativi attuali.' : 'Esecuzione automatica disabilitata. L’attivazione richiede il rilascio autorizzato.'}</p>
    <p className="mt-2 text-sm">La delega approva preventivamente una versione della regola, i modelli pubblicati, il mittente e la policy. Ogni messaggio mantiene una decisione distinta e una ricevuta. Una modifica o una revoca interrompe le esecuzioni successive. L’esito incerto richiede riconciliazione e non viene ripetuto.</p>
    {data.grants.map(grant => <article className="my-3 rounded-xl border p-3" key={grant.id}>
      <b>{rules.find(rule => rule.id === grant.automationId)?.name ?? 'Regola registrata'} · v{grant.automationVersion} · {grant.state === 'ACTIVE' ? 'Delega registrata' : 'Revocata'}</b>
      <p>{formatRecordNoticeTime(grant.validFrom)} → {formatRecordNoticeTime(grant.validUntil)} · massimo {grant.maxMessages} messaggi, {grant.maxPerDay} al giorno UTC · decisioni consumate {grant.used}</p>
      <p className="break-all text-sm">Autorizzazione: {grant.approvalReference} · impronta policy: {grant.policyHash}</p>
      {grant.state === 'ACTIVE' && <form action={mutateWorkflowAction} className="mt-2"><input type="hidden" name="intent" value="service-revoke" /><input type="hidden" name="authorityKind" value="GRANT" />
        <input type="hidden" name="id" value={grant.id} /><input type="hidden" name="expectedRevision" value={grant.revision} /><PrimaryButton type="submit">Revoca delega</PrimaryButton></form>}
    </article>)}
    {enabled && rules.filter(rule => rule.state === 'ACTIVE').map(rule => <details key={rule.id} className="my-3 rounded-xl border p-3"><summary>Autorizza {rule.name} · versione {rule.version}</summary>
      <form action={mutateWorkflowAction} className="mt-3 grid gap-3"><input type="hidden" name="intent" value="service-grant" /><input type="hidden" name="id" value={rule.id} /><input type="hidden" name="expectedVersion" value={rule.version} />
        <label>Credenziale di servizio qualificata<select required name="credentialId" className={field}><option value="">Seleziona</option>{data.credentials.filter(row => row.state === 'ACTIVE').map(row => <option key={row.id} value={row.id}>{row.qualificationReference} · fino al {formatRecordNoticeTime(row.validUntil)}</option>)}</select></label>
        <label>Inizio · Europe/Rome<input type="datetime-local" name="validFrom" required className={field} /></label>
        <label>Fine · Europe/Rome, massimo 31 giorni<input type="datetime-local" name="validUntil" required className={field} /></label>
        <label>Massimo totale messaggi<input type="number" name="maxMessages" min={1} max={100000} required className={field} /></label>
        <label>Massimo giornaliero UTC<input type="number" name="maxPerDay" min={1} max={100000} required className={field} /></label>
        <label>Decisione aziendale preventiva<input name="approvalReference" minLength={8} maxLength={200} required className={field} /></label>
        <label><input type="checkbox" name="approved" required /> Approvo questi limiti, il mittente attuale, la versione della regola e i modelli pubblicati per l’esecuzione senza ulteriori approvazioni personali dei singoli messaggi.</label>
        <PrimaryButton type="submit">Registra delega con conferma di identità</PrimaryButton>
      </form></details>)}
    <details className="mt-3"><summary>Credenziali qualificate del runner</summary>
      {data.credentials.map(row => <article key={row.id} className="my-3 rounded-xl border p-3"><b>{row.qualificationReference} · {row.state === 'ACTIVE' ? 'Registrata' : 'Revocata'}</b>
        <p className="break-all text-sm">Impronta {row.keyFingerprint} · validità {formatRecordNoticeTime(row.validUntil)}</p>
        {row.state === 'ACTIVE' && <form action={mutateWorkflowAction}><input type="hidden" name="intent" value="service-revoke" /><input type="hidden" name="authorityKind" value="CREDENTIAL" /><input type="hidden" name="id" value={row.id} /><input type="hidden" name="expectedRevision" value={row.revision} /><PrimaryButton type="submit">Revoca credenziale e tutte le deleghe collegate</PrimaryButton></form>}
      </article>)}
      {enabled && <form action={mutateWorkflowAction} className="mt-3 grid gap-3"><input type="hidden" name="intent" value="service-credential" />
        <p>Registrare soltanto l’impronta della credenziale già qualificata. La chiave privata non va inserita nel CRM.</p>
        <label>Impronta SHA-256<input name="keyFingerprint" pattern="[a-f0-9]{64}" required className={field} /></label>
        <label>Riferimento della qualifica<input name="qualificationReference" minLength={8} maxLength={200} required className={field} /></label>
        <label>Scadenza · Europe/Rome<input type="datetime-local" name="validUntil" required className={field} /></label>
        <label><input type="checkbox" name="approved" required /> Confermo la qualifica e autorizzo la registrazione entro la scadenza indicata.</label>
        <PrimaryButton type="submit">Registra impronta qualificata</PrimaryButton>
      </form>}
    </details>
  </Card>;
}
