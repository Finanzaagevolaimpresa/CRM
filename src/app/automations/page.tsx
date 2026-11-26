import Link from 'next/link';
import { randomUUID } from 'node:crypto';
import { requireAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { Card, PageHeader, Badge } from '@/components/ui';
import { PrimaryButton, SecondaryLink } from '@/components/actions';
import { readWorkflowAdministration } from '@/lib/workflow-automations';
import { mutateWorkflowAction } from '@/lib/workflow-automation-actions';
import { workflowEvents, workflowEventLabels, workflowPurposes, workflowPurposeLabels } from '@/lib/workflow-automation-contract';
import { formatRecordNoticeTime } from '@/lib/record-notice-time';
import { romeDateTimeInput } from '@/lib/rome-date-time';
import { withTechnicalPage } from '@/lib/technical-surface-guards';

export const dynamic = 'force-dynamic';
type Administration = Awaited<ReturnType<typeof readWorkflowAdministration>>;
type Template = Administration['templates'][number];
type Rule = Administration['rules'][number];
const field = 'mt-1 w-full rounded-xl border border-slate-300 p-2';
const stateLabels: Record<string, string> = { PENDING: 'In attesa', SENDING: 'Esito da verificare', SENT: 'Accettata',
  UNCERTAIN: 'Da riconciliare', ERROR: 'Errore', BLOCKED: 'Escluso', STOPPED: 'Interrotta', COMPLETED: 'Conclusa', PREPARED: 'Bozza preparata' };
const preferenceLabels: Record<string, string> = { CURRENT_EXPLICIT_CONSENT: 'Consenso attuale verificato', DENIED: 'Consenso negato',
  SUPPRESSED: 'Disiscrizione registrata', WITHDRAWN: 'Consenso revocato', PURPOSE_CLOSED: 'Finalità chiusa', NO_CURRENT_CONSENT: 'Consenso attuale assente',
  CONSENT_EXPIRED: 'Consenso scaduto', RUNTIME_UNQUALIFIED: 'Preferenze da qualificare', STATE_UNAVAILABLE: 'Stato non disponibile',
  HANDOFF_SERIALIZATION_UNAVAILABLE: 'Canale di invio da qualificare', STALE_SELECTION: 'Preferenze cambiate dopo la selezione' };

function TemplateForm({ template, duplicate = false }: { template?: Template; duplicate?: boolean }) {
  return <form action={mutateWorkflowAction} className="mt-3 grid gap-3">
    <input type="hidden" name="intent" value="template" />
    <input type="hidden" name="familyId" value={duplicate ? '' : template?.familyId ?? ''} />
    <input type="hidden" name="expectedVersion" value={duplicate ? 0 : template?.version ?? 0} />
    <label>Nome<input required maxLength={160} name="name" defaultValue={template ? template.name + (duplicate ? ' · copia' : '') : ''} className={field} /></label>
    <label>Uso del modello<select name="purpose" defaultValue={template?.purpose ?? 'CONFIRMATION'} className={field}>
      {workflowPurposes.map(code => <option key={code} value={code}>{workflowPurposeLabels[code]}</option>)}
    </select></label>
    <label>Oggetto<input required name="subject" maxLength={200} defaultValue={template?.subject} className={field} /></label>
    <label>Testo aziendale<textarea required name="body" rows={6} maxLength={20000} defaultValue={template?.body} className={field} /></label>
    <p className="text-sm text-slate-600">Campi disponibili: {'{{firstName}}, {{companyName}}, {{appointmentAt}}, {{documentList}}, {{unsubscribeUrl}}'}. I valori provengono dalla singola scheda. La newsletter richiede il collegamento di disiscrizione.</p>
    <label>Stato<select name="state" defaultValue="DRAFT" className={field}><option value="DRAFT">Bozza</option><option value="PUBLISHED">Pubblicato · testo autorizzato</option></select></label>
    <label>Riferimento all’autorizzazione del testo<input name="authorizationReference" maxLength={200} defaultValue={duplicate ? '' : template?.authorizationReference ?? ''} className={field} placeholder="Documento o decisione aziendale" /></label>
    <PrimaryButton type="submit">{duplicate ? 'Crea copia indipendente' : template ? 'Salva nuova versione' : 'Salva modello'}</PrimaryButton>
  </form>;
}

function RuleForm({ rule, data, newsletter }: { rule?: Rule; data: Administration; newsletter: boolean }) {
  const config = rule?.configuration;
  return <form action={mutateWorkflowAction} className="mt-3 grid gap-3">
    <input type="hidden" name="intent" value="rule" /><input type="hidden" name="id" value={rule?.id ?? ''} />
    <input type="hidden" name="kind" value={newsletter ? 'NEWSLETTER' : 'INDIVIDUAL'} />
    <input type="hidden" name="expectedVersion" value={rule?.version ?? 0} />
    <label>Nome<input required name="name" maxLength={160} defaultValue={rule?.name} className={field} /></label>
    <label>Evento<select name="event" defaultValue={rule?.event ?? (newsletter ? 'NEWSLETTER' : 'LEAD_ACCEPTED')} className={field}>
      {workflowEvents.filter(event => (event === 'NEWSLETTER') === newsletter).map(event => <option key={event} value={event}>{workflowEventLabels[event]}</option>)}
    </select></label>
    <p>Condizioni: richiesta associata a una sola scheda; solleciti interrotti alla risposta o all’appuntamento.</p>
    <label>Azione<select name="action" className={field} defaultValue={config?.action ?? 'EMAIL'}><option value="EMAIL">Messaggio email</option>{!newsletter && <option value="INTERNAL_NOTICE">Avviso interno</option>}</select></label>
    <label>Modello iniziale<select required name="confirmationTemplateId" defaultValue={config?.confirmationTemplateId ?? ''} className={field}>
      <option value="" disabled>Seleziona una versione</option>{data.templates.map(template => <option key={template.id} value={template.id}>{template.name} · v{template.version} · {template.state === 'PUBLISHED' ? 'pubblicato' : 'bozza'}</option>)}
    </select></label>
    {!newsletter && <label>Modello successivo · sollecito o promemoria<select name="followupTemplateId" defaultValue={config?.followupTemplateId ?? ''} className={field}><option value="">Nessun passaggio successivo</option>
      {data.templates.filter(template => ['FOLLOW_UP','APPOINTMENT','INTERNAL_NOTICE'].includes(template.purpose)).map(template => <option key={template.id} value={template.id}>{template.name} · v{template.version} · {workflowPurposeLabels[template.purpose as keyof typeof workflowPurposeLabels]}</option>)}
    </select></label>}
    {newsletter ? <input type="hidden" name="delayMinutes" value={1} /> : <label>Attesa prima del sollecito (minuti)<input name="delayMinutes" type="number" min={1} max={43200} required defaultValue={rule?.delayMinutes ?? 1440} className={field} /></label>}
    {!newsletter && <p className="text-sm">Per gli appuntamenti, i minuti indicano l’anticipo del promemoria. Un avviso interno raggiunge il referente attuale della scheda.</p>}
    {newsletter && <>
      <label>Data e ora programmata · Europe/Rome<input required type="datetime-local" name="newsletterAt" defaultValue={romeDateTimeInput(config?.newsletterAt).slice(0, 16)} className={field} /></label>
      <fieldset className="max-h-64 overflow-y-auto rounded-xl border p-3"><legend>Destinatari proposti</legend>
        <p className="mb-2 text-sm">La selezione non sostituisce le preferenze marketing. Ogni destinatario richiede consenso attuale e disiscrizione prima dell’eventuale invio.</p>
        {data.people.map(person => <label key={person.id} className="block py-1"><input type="checkbox" name="recipientIds" value={person.id} defaultChecked={config?.recipientIds.includes(person.id)} /> {person.companyName || `${person.firstName} ${person.lastName}`}</label>)}
      </fieldset>
    </>}
    <label>Stato<select name="state" defaultValue={rule?.state ?? 'DRAFT'} className={field}><option value="DRAFT">Bozza</option><option value="TEST_READY">Pronta per prova</option><option value="ACTIVE" disabled={process.env.WORKFLOW_NATIVE_PREPARATION_MODE !== 'enabled'}>Attiva · richiede rilascio autorizzato</option></select></label>
    <p className="text-sm text-slate-600">Salvare conserva la configurazione. {newsletter ? 'Gli invii reali richiedono mittente, preferenze marketing e disiscrizione qualificati; sono disponibili le prove su destinatari sintetici.' : 'La preparazione email reale rimane disabilitata fino al rilascio autorizzato; ogni bozza seguirà le approvazioni del mittente.'}</p>
    <PrimaryButton type="submit">Salva regola</PrimaryButton>
  </form>;
}

async function AutomationsPage({ searchParams }: { searchParams: Promise<{ result?: string; kind?: string }> }) {
  const session = await requireAuth(['admin']), query = await searchParams;
  const data = await readWorkflowAdministration(prisma, session), newsletter = query.kind === 'NEWSLETTER';
  const rules = data.rules.filter(rule => (rule.event === 'NEWSLETTER') === newsletter);
  const latest = [...new Map(data.templates.map(template => [template.familyId,
    data.templates.find(row => row.familyId === template.familyId)!])).values()];
  const notices: Record<string, string> = { RECORDED: 'Configurazione salvata.', TEST_PASSED: 'Prova sintetica superata. Nessun messaggio reale inviato.',
    NEWSLETTER_RECORDED: 'Prova destinatari registrata. Consulta gli esiti e gli eventuali blocchi. Nessun invio reale.',
    NATIVE_PREPARED: 'Passaggi preparati. Controlla le bozze nella scheda e procedi con le approvazioni previste.',
    NATIVE_REVIEW: 'Alcuni passaggi richiedono verifica. Consulta le eccezioni e la scheda collegata.',
    TEST_FAILED: 'La prova ha rilevato un errore: consulta il registro e controlla i modelli.',
    STEP_UP_REQUIRED: 'Conferma la tua identità in Impostazioni → Sicurezza prima di salvare.',
    CHECK_CURRENT: 'Operazione non completata. Verifica campi, autorizzazione del testo e versione corrente prima di ripetere.' };
  return <div className="crm-space-y-6">
    <PageHeader title={newsletter ? 'Newsletter' : 'Automazioni'} description={newsletter ? 'Destinatari, programmazione, preferenze e prova interna.' : 'Eventi, condizioni, attese e azioni per seguire ogni richiesta.'} />
    <nav aria-label="Automazioni e marketing" className="flex flex-wrap gap-3"><SecondaryLink href="/automations">Sequenze individuali</SecondaryLink><SecondaryLink href="/automations?kind=NEWSLETTER">Newsletter</SecondaryLink><SecondaryLink href="/settings/integrations">Integrazioni</SecondaryLink></nav>
    {query.result && <p role="status" className="rounded-xl bg-slate-100 p-3">{notices[query.result] ?? notices.CHECK_CURRENT}</p>}
    {!newsletter && process.env.WORKFLOW_NATIVE_PREPARATION_MODE === 'enabled' && <Card title="Passaggi in attesa">
      <form action={mutateWorkflowAction} className="grid gap-3"><input type="hidden" name="intent" value="native-run" />
        <label>Mittente per le bozze<select name="mailboxId" className={field}><option value="">Solo avvisi interni</option>{data.mailboxes.map(box => <option key={box.id} value={box.id}>{box.address}</option>)}</select></label>
        <p>Prepara fino a 20 sequenze giunte a scadenza. Le email restano bozze da approvare nel percorso del mittente.</p>
        <PrimaryButton type="submit">Prepara i passaggi in attesa</PrimaryButton>
      </form>
    </Card>}
    {!newsletter && data.holds.length > 0 && <Card title="Eccezioni da verificare">{data.holds.map(hold => {
      const reason = (hold.after as { reason?: string } | null)?.reason;
      return <p key={hold.id}>{formatRecordNoticeTime(hold.createdAt)} · {reason === 'MULTIPLE_ACTIVE_ACQUISITION_RULES' ? 'Scegli una sola sequenza attiva per la conferma di acquisizione.'
        : reason === 'RULE_AUTHORITY_UNAVAILABLE' ? 'Verifica il responsabile della regola e i suoi permessi.' : 'Verifica fonte, destinatario e autorizzazione del mittente prima di ripetere.'}
        <Link className="ml-2 underline" href={hold.entityType === 'WorkflowAutomation' ? '/automations' : '/leads/acquisition'}>Apri controllo</Link></p>;
    })}</Card>}
    <Card title={newsletter ? 'Nuova newsletter' : 'Nuova automazione'}><RuleForm data={data} newsletter={newsletter} /></Card>
    {rules.map(rule => <Card key={rule.id} title={rule.name} action={<Badge tone="blue">{rule.state === 'DRAFT' ? 'Bozza' : rule.state === 'ACTIVE' ? 'Attiva' : 'Pronta per prova'} · v{rule.version}</Badge>}>
      <p>{workflowEventLabels[rule.event as keyof typeof workflowEventLabels]} · {rule.configuration.action === 'EMAIL' ? 'Email' : 'Avviso interno'} · attesa {rule.delayMinutes} minuti</p>
      {!newsletter && <p className="mt-2 text-sm">La prova persistente dell’evento è disponibile dalla scheda con la sua fonte corrente. Gli avvisi interni registrano un destinatario; le email preparate richiedono approvazione.</p>}
      <p className="my-2">Alla risposta o alla prenotazione termina il sollecito. Il promemoria di appuntamento segue spostamenti e annullamenti.</p>
      <form action={mutateWorkflowAction}><input type="hidden" name="intent" value="test" /><input type="hidden" name="kind" value={newsletter ? 'NEWSLETTER' : 'INDIVIDUAL'} /><input type="hidden" name="id" value={rule.id} /><input type="hidden" name="expectedVersion" value={rule.version} /><PrimaryButton type="submit">Prova la regola con dati sintetici</PrimaryButton></form>
      {newsletter && process.env.APP_ENV === 'test' && <form action={mutateWorkflowAction} className="mt-3"><input type="hidden" name="intent" value="newsletter-test" /><input type="hidden" name="kind" value="NEWSLETTER" /><input type="hidden" name="id" value={rule.id} /><input type="hidden" name="runId" value={randomUUID()} /><PrimaryButton type="submit">Prova i destinatari selezionati</PrimaryButton><p className="mt-2 text-sm">Solo indirizzi sintetici. Il consenso e la disiscrizione sono ricontrollati alla prova; un esito incerto richiede riconciliazione.</p></form>}
      {newsletter && data.newsletterRuns.filter(run => run.automationId === rule.id).map(run => <details key={run.id} className="mt-3 rounded-xl border p-3"><summary>Destinatari · {formatRecordNoticeTime(run.createdAt)} · {stateLabels[run.state] ?? 'Da verificare'} · v{run.automationVersion}</summary>
        {run.recipients.map(recipient => { const policy = recipient.policySnapshot as { decision?: { reason?: string } } | null;
          return <div key={recipient.id} className="my-3 border-t pt-2"><p>{recipient.lead.companyName || `${recipient.lead.firstName} ${recipient.lead.lastName}`} · {stateLabels[recipient.state] ?? 'Da verificare'} · tentativi {recipient.attemptCount}</p>{policy?.decision?.reason && <p className="text-sm">Preferenze: {preferenceLabels[policy.decision.reason] ?? 'Esclusione da verificare nel registro'}</p>}
            {run.synthetic && process.env.APP_ENV === 'test' && ['SENDING','UNCERTAIN'].includes(recipient.state) && <form action={mutateWorkflowAction} className="mt-2 grid gap-2"><input type="hidden" name="intent" value="newsletter-reconcile" /><input type="hidden" name="kind" value="NEWSLETTER" /><input type="hidden" name="recipientId" value={recipient.id} /><label>Esito verificato<select name="outcome" className={field}><option value="SENT">Accettato nel canale di prova</option><option value="NOT_SENT">Non accettato, verificato</option></select></label><label>Evidenza<input name="evidence" required minLength={5} maxLength={500} className={field} /></label><PrimaryButton type="submit">Registra riconciliazione</PrimaryButton></form>}</div>; })}
        {run.synthetic && process.env.APP_ENV === 'test' && <form action={mutateWorkflowAction}><input type="hidden" name="intent" value="newsletter-run" /><input type="hidden" name="kind" value="NEWSLETTER" /><input type="hidden" name="runId" value={run.id} /><PrimaryButton type="submit">Ripeti verifica dei passi in attesa</PrimaryButton></form>}
      </details>)}
      <details className="mt-3"><summary className="cursor-pointer font-bold">Modifica la regola</summary><RuleForm rule={rule} data={data} newsletter={newsletter} /></details>
      <details className="mt-3"><summary className="cursor-pointer font-bold">Registro delle prove</summary>
        {data.tests.filter(test => test.automationId === rule.id).map(test => {
          const result = test.result as { passed?: boolean; cases?: Array<{ name: string; passed: boolean }> };
          return <article key={test.id} className="my-3 rounded-xl border p-3"><p>{formatRecordNoticeTime(test.createdAt)} · versione {test.automationVersion} · {result.passed ? 'Superata' : 'Da correggere'} · canale sintetico</p><ul className="mt-2 list-disc pl-5">{result.cases?.map(item => <li key={item.name}>{item.passed ? '✓' : '✗'} {item.name}</li>)}</ul></article>;
        })}
      </details>
    </Card>)}
    <Card title="Modelli email autorizzati">
      <p>I testi HighLevel devono essere acquisiti e autorizzati prima della pubblicazione. Ogni modifica conserva la versione precedente.</p>
      <details className="mt-3"><summary className="cursor-pointer font-bold">Nuovo modello</summary><TemplateForm /></details>
      {latest.map(template => <article key={template.familyId} className="mt-4 rounded-xl border p-4"><h2 className="font-bold">{template.name} · v{template.version}</h2><p>{template.state === 'PUBLISHED' ? 'Pubblicato' : 'Bozza'} · {workflowPurposeLabels[template.purpose as keyof typeof workflowPurposeLabels]}</p>
        <details className="mt-2"><summary className="cursor-pointer">Anteprima e versioni</summary>{data.templates.filter(row => row.familyId === template.familyId).map(row => <div key={row.id} className="my-3 rounded-lg bg-slate-50 p-3"><b>v{row.version} · {row.subject}</b><p className="whitespace-pre-wrap">{row.body}</p><p className="text-sm">{formatRecordNoticeTime(row.createdAt)} · {row.authorizationReference || 'Testo da autorizzare'}</p></div>)}</details>
        <details className="mt-2"><summary className="cursor-pointer">Crea nuova versione</summary><TemplateForm template={template} /></details>
        <details className="mt-2"><summary className="cursor-pointer">Duplica modello</summary><TemplateForm template={template} duplicate /></details>
      </article>)}
    </Card>
    <Card title="Flussi da censire"><p>HighLevel: assegnazioni lead, documenti aggiuntivi preanalisi, Automazioni interne, Messaggi Automatici, Cold Emailing e SiDial. Per ogni flusso occorrono evento, condizioni, testi autorizzati, canali e responsabile. I 32 modelli riferiti non sono considerati acquisiti.</p><Link href="/settings/communications" className="mt-3 block font-bold text-fai-blue underline">Mittenti e risposte già configurati</Link></Card>
  </div>;
}
export default withTechnicalPage('/automations', AutomationsPage);
