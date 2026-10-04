import { Card } from './ui';
import { PrimaryButton } from './actions';
import { mutateInitialServiceAction } from '@/lib/initial-service-actions';
import type { readInitialServiceState, initialServiceChoices } from '@/lib/initial-service-workflow';

type State = NonNullable<Awaited<ReturnType<typeof readInitialServiceState>>>;
type Choices = Awaited<ReturnType<typeof initialServiceChoices>>;
const field = 'w-full rounded-xl border p-3';
export function InitialServiceWorkflow({ state, choices, dossierId, admin, canWrite, userId, approved }: {
  state: State; choices: Choices; dossierId: string; admin: boolean; canWrite: boolean; userId: string; approved: boolean;
}) {
  const plan = state.plan, next = state.assessment?.nextStage;
  const human = next?.startsWith('HUMAN_');
  const assigned = human ? plan?.humanReviewerIds[next === 'HUMAN_1' ? 0 : 1] : plan?.responsibleUserId;
  const binding = <><input type="hidden" name="dossierId" value={dossierId}/><input type="hidden" name="expectedVersionId" value={state.version.id}/><input type="hidden" name="expectedPlanHash" value={state.planHash ?? ''}/></>;
  const people = choices.users.map(user => <option key={user.id} value={user.id}>{user.name} · {user.role}</option>);
  return <section className="crm-space-y-4" aria-label="Percorso servizio iniziale">
    <Card title={state.definition.title}>
      <p>{state.definition.outcome}</p>
      <p className="mt-2"><strong>Materiali:</strong> {state.definition.materials.join('; ')}.</p>
      <p><strong>Incluso:</strong> {state.definition.included.join('; ')}.</p>
      <p><strong>Escluso:</strong> {state.definition.excluded.join('; ')}.</p>
      <p className="mt-2 text-sm">Gli approfondimenti compresi completano il servizio acquistato. I servizi successivi sono opzionali. Nessuna promessa di contributi o finanziamenti.</p>
    </Card>
    <Card title="Responsabilità e revisioni">
      <p>{plan ? 'Percorso configurato · revisione ' + plan.planVersion : 'Da configurare: un amministratore assegna il responsabile e i revisori umani.'}</p>
      <p>{state.assessment?.ready ? 'Revisioni complete. Serve l’approvazione finale della versione e la distinta autorizzazione alla consegna.'
        : state.assessment?.blocked === 'CHANGES_REQUIRED' ? 'Modifiche richieste: prepara una nuova versione e ripeti le revisioni pertinenti.'
        : next ? 'Passaggio successivo: ' + next : 'La consegna rimane bloccata soltanto per questo dossier.'}</p>
      <p className="text-sm">A00 → produttore → Q01 → Q02 quando richiesto → Q03 → revisori umani → D01. Le attività Work sono attestate manualmente con un documento verificabile. I giudizi umani sono registrati personalmente.</p>
      {admin && !approved ? <form action={mutateInitialServiceAction} className="mt-4 grid gap-3">
        {binding}<input type="hidden" name="intent" value="configure"/>
        <label>Responsabile della lavorazione<select name="responsibleUserId" className={field} required defaultValue={plan?.responsibleUserId ?? ''}><option value="">Seleziona</option>{people}</select></label>
        <label>Primo revisore umano<select name="human1" className={field} required defaultValue={plan?.humanReviewerIds[0] ?? ''}><option value="">Seleziona</option>{people}</select></label>
        <label>Secondo revisore umano, dove richiesto<select name="human2" className={field} defaultValue={plan?.humanReviewerIds[1] ?? ''}><option value="">Non previsto</option>{people}</select></label>
        <label>Tipo di elaborato<select className={field} name="outputKind" defaultValue={plan?.outputKind ?? 'REPORT'}><option value="REPORT">Report del servizio</option><option value="BUSINESS_PLAN">Business plan</option><option value="APPLICATION">Domanda</option></select></label>
        <label><input type="checkbox" name="numericAnalysis" defaultChecked={plan?.numericAnalysis ?? state.definition.numericReview}/> Contiene analisi numerica</label>
        <fieldset><legend>Contributi specialistici previsti</legend>{['A05','A06','A07','A09','A10','A11'].map(agent => <label className="mr-4 inline-block" key={agent}><input type="checkbox" name="supportingAgent" value={agent} defaultChecked={plan?.supportingAgents.some(item => item === agent)}/> {agent}</label>)}</fieldset>
        <p className="text-sm">Business plan, domande e contributi A07/A09/A10/A11 richiedono due revisori distinti dal produttore. La modifica delle assegnazioni richiede nuove revisioni.</p>
        <PrimaryButton type="submit">Salva responsabilità del servizio</PrimaryButton>
      </form> : null}
    </Card>
    {canWrite && !approved ? <details className="rounded-xl border p-4"><summary className="cursor-pointer font-semibold">Compila il template del servizio</summary>
      <form action={mutateInitialServiceAction} className="mt-4 grid gap-3">{binding}<input type="hidden" name="intent" value="template"/>
        <label>Data del documento<input className={field} type="date" name="date" defaultValue={new Date().toISOString().slice(0,10)} required/></label>
        {state.definition.sections.map((section,index) => <label key={section}>{section}<textarea className={field} name={'section' + index} required maxLength={6000}/></label>)}
        <label>Fonte / evidenza<textarea className={field} name="sourceTitle" required maxLength={300}/></label>
        <label>Riferimento verificabile della fonte<input className={field} name="sourceReference" required/></label>
        <label>Data della verifica<input type="date" className={field} name="sourceDate" required/></label>
        <label>Limite della fonte<textarea className={field} name="sourceLimitation" required/></label>
        <label>Limiti dell’elaborato<textarea className={field} name="limits" required/></label>
        <label>Prossimo passo<textarea className={field} name="nextStep" required/></label>
        <PrimaryButton type="submit">Salva template come nuova versione</PrimaryButton>
      </form></details> : null}
    {next && userId === assigned && !approved ? <Card title={'Registra ' + next}>
      <form action={mutateInitialServiceAction} className="grid gap-3">{binding}<input type="hidden" name="intent" value="review"/><input type="hidden" name="stage" value={next}/>
        {!human ? <><label>Documento della lavorazione / revisione<select name="documentVersionId" className={field}><option value="">Seleziona; non necessario solo per Q02 non applicabile</option>{choices.documents.map(doc => <option key={doc.id} value={doc.id}>{doc.label}</option>)}</select></label>
          <label>Riferimento della versione dell’agente usata<input name="agentVersionReference" className={field} pattern="[A-Za-z][A-Za-z0-9_-]+" placeholder="Riferimento verificabile, nessun valore inventato"/></label></> : null}
        <label>Riferimento Work / decisione<input name="reference" className={field} pattern="[A-Za-z][A-Za-z0-9_-]+" required/></label>
        <label>Motivazione e limiti<textarea name="note" className={field} required minLength={30} maxLength={4000}/></label>
        <label>Esito<select name="decision" className={field}><option value="PASS">PASS</option><option value="REQUEST_CHANGES">Richieste modifiche</option>{next === 'Q02' && !state.assessment?.policy.q02Required ? <option value="NOT_APPLICABLE">Non applicabile, motivato</option> : null}</select></label>
        <PrimaryButton type="submit">{human ? 'Registra il mio giudizio umano' : 'Registra attestazione manuale'}</PrimaryButton>
      </form>
    </Card> : null}
    <Card title="Traccia delle revisioni del servizio"><ul className="crm-space-y-2">{state.allReviews.map((entry,index) => <li key={index}>{entry.review.stage} · {entry.review.decision} · {entry.review.reference} · {entry.review.recordedAt}<br/><span className="text-sm">Versione {entry.review.versionId} · autore {entry.review.actorId} · {entry.review.note}</span></li>)}</ul></Card>
  </section>;
}
