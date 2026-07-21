import Link from 'next/link';
import { Badge, Card, EmptyState, PageHeader, Table, formatDateTime } from '@/components/ui';
import {
  engageAiOrchestratorEmergencyStopAction,
  updateAiOrchestratorGlobalPolicyAction,
  updateAiOrchestratorScopePolicyAction,
} from '@/lib/ai-orchestrator/admin-ui-actions-v1';
import {
  AI_ORCHESTRATOR_ADMIN_CHANGE_REASON_CODES,
  type AiOrchestratorAdminGlobalPolicy,
  type AiOrchestratorAdminScopePolicy,
} from '@/lib/ai-orchestrator/admin-control-policy-v1';
import type { AiOrchestratorAdminEffectiveState } from '@/lib/ai-orchestrator/admin-control-plane-v1';
import {
  AI_ORCHESTRATOR_ADMIN_EMERGENCY_CONFIRMATION_PHRASE,
  AI_ORCHESTRATOR_ADMIN_POLICY_CONFIRMATION_PHRASE,
  AI_ORCHESTRATOR_ADMIN_REASON_CODE_LABELS,
  AI_ORCHESTRATOR_ADMIN_SCOPE_LABELS,
  AI_ORCHESTRATOR_ADMIN_UI_RESULT_MESSAGES,
  labelAiOrchestratorAdminBlockReason,
  minuteUtcToTime,
  type AiOrchestratorAdminAuditRevisionView,
  type AiOrchestratorAdminHistoryMode,
  type AiOrchestratorAdminReadRevisionView,
  type AiOrchestratorAdminUiPermissions,
  type AiOrchestratorAdminUiResultCode,
} from '@/lib/ai-orchestrator/admin-ui-contract-v1';

type GlobalRevisionView = Omit<AiOrchestratorAdminReadRevisionView, 'policy'> & {
  readonly policy: AiOrchestratorAdminGlobalPolicy;
};

type ScopeRevisionView = Omit<AiOrchestratorAdminReadRevisionView, 'policy'> & {
  readonly policy: AiOrchestratorAdminScopePolicy;
};

interface DashboardProps {
  readonly global: GlobalRevisionView;
  readonly scopes: readonly ScopeRevisionView[];
  readonly selectedScope: ScopeRevisionView | null;
  readonly effective: AiOrchestratorAdminEffectiveState;
  readonly permissions: AiOrchestratorAdminUiPermissions;
  readonly mutationIntegritySafe: boolean;
  readonly history: readonly AiOrchestratorAdminAuditRevisionView[] | null;
  readonly historyMode: AiOrchestratorAdminHistoryMode;
  readonly historyNextHref: string | null;
  readonly historyMessage: string | null;
  readonly resultCode: AiOrchestratorAdminUiResultCode | null;
  readonly requestIds: {
    readonly global: string;
    readonly scope: string;
    readonly emergency: string;
  };
}

const inputClass = 'w-full rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-800 outline-none transition focus:border-fai-blue focus:ring-2 focus:ring-fai-blue/20';
const labelClass = 'block text-xs font-black uppercase tracking-wide text-fai-navy';

function hashPreview(value: string) {
  return `${value.slice(0, 12)}…${value.slice(-6)}`;
}

function historyHref(mode: AiOrchestratorAdminHistoryMode, selectedScope: ScopeRevisionView | null) {
  const query = new URLSearchParams();
  if (selectedScope) {
    query.set('scopeType', selectedScope.scopeType);
    query.set('scopeCode', selectedScope.scopeCode);
  }
  if (mode !== 'all') query.set('audit', mode);
  const serialized = query.toString();
  return `/settings/ai-orchestrator${serialized ? `?${serialized}` : ''}`;
}

function BooleanBadge({ value, goodWhen = true }: { value: boolean; goodWhen?: boolean }) {
  const good = value === goodWhen;
  return <Badge tone={good ? 'green' : 'orange'}>{value ? 'sì' : 'no'}</Badge>;
}

function GateCard({ label, value, detail, goodWhen = true }: {
  label: string;
  value: boolean;
  detail: string;
  goodWhen?: boolean;
}) {
  const good = value === goodWhen;
  return (
    <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
      <p className="text-xs font-black uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-2 text-lg font-extrabold ${good ? 'text-fai-green' : 'text-fai-orange'}`}>{value ? 'sì' : 'no'}</p>
      <p className="mt-1 text-xs leading-5 text-slate-500">{detail}</p>
    </div>
  );
}

function ReasonFields({ idPrefix, emergency = false }: { idPrefix: string; emergency?: boolean }) {
  const phrase = emergency
    ? AI_ORCHESTRATOR_ADMIN_EMERGENCY_CONFIRMATION_PHRASE
    : AI_ORCHESTRATOR_ADMIN_POLICY_CONFIRMATION_PHRASE;
  const codes = emergency
    ? (['EMERGENCY_STOP', 'SECURITY_RESPONSE'] as const)
    : AI_ORCHESTRATOR_ADMIN_CHANGE_REASON_CODES;
  const reasonCodeId = `${idPrefix}-reason-code`;
  const reasonId = `${idPrefix}-reason`;
  const confirmationId = `${idPrefix}-confirmation`;
  return (
    <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
      <div>
        <label className={labelClass} htmlFor={reasonCodeId}>Reason code</label>
        <select
          className={`${inputClass} mt-1`}
          id={reasonCodeId}
          name="reasonCode"
          defaultValue={emergency ? 'EMERGENCY_STOP' : 'CONFIGURATION_CHANGE'}
        >
          {codes.map((code) => <option key={code} value={code}>{AI_ORCHESTRATOR_ADMIN_REASON_CODE_LABELS[code]}</option>)}
        </select>
      </div>
      <div>
        <label className={labelClass} htmlFor={reasonId}>Motivazione minimizzata</label>
        <textarea
          className={`${inputClass} mt-1 min-h-28`}
          id={reasonId}
          name="reason"
          minLength={10}
          maxLength={500}
          required
          autoComplete="off"
          placeholder="Descrivere il motivo tecnico senza nomi, dati cliente, URL, credenziali o contenuti operativi."
        />
        <p className="mt-1 text-xs leading-5 text-slate-500">Da 10 a 500 caratteri Unicode, con massimo 500 unità UTF-16 per mantenere il rollback PR79 leggibile. Il filtro riduce il rischio di persistenza accidentale e non sostituisce la minimizzazione manuale.</p>
      </div>
      <div>
        <label className={labelClass} htmlFor={confirmationId}>Frase di conferma</label>
        <code className="mt-1 block rounded-xl bg-slate-100 px-3 py-2 text-xs font-bold text-fai-navy">{phrase}</code>
        <input
          className={`${inputClass} mt-2`}
          id={confirmationId}
          name="confirmationPhrase"
          required
          autoComplete="off"
          aria-label="Ripetere la frase di conferma"
        />
      </div>
      <label className="flex items-start gap-2 text-sm font-bold text-fai-navy">
        <input className="mt-1 h-4 w-4 rounded border-slate-300" type="checkbox" name="confirmationChecked" value="confirmed" required />
        Ho verificato target, versione, impatto e motivazione della richiesta.
      </label>
    </div>
  );
}

function GlobalPolicyForm({ global, requestId }: { global: GlobalRevisionView; requestId: string }) {
  const policy = global.policy;
  return (
    <form action={updateAiOrchestratorGlobalPolicyAction} className="space-y-4">
      <input type="hidden" name="requestId" value={requestId} />
      <input type="hidden" name="expectedVersion" value={global.version} />
      <input type="hidden" name="expectedRevisionHash" value={global.revisionHash} />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <label className={labelClass}>Modalità desiderata
          <select className={`${inputClass} mt-1`} name="desiredMode" defaultValue={policy.desiredMode}>
            {['STOPPED', 'PAUSED', 'DRAINING', 'READY'].map((mode) => <option key={mode}>{mode}</option>)}
          </select>
        </label>
        <label className={labelClass}>State machine desiderata
          <select className={`${inputClass} mt-1`} name="desiredStateMachineEnabled" defaultValue={String(policy.desiredStateMachineEnabled)}>
            <option value="false">disabilitata</option><option value="true">abilitata</option>
          </select>
        </label>
        <label className={labelClass}>Emergency stop
          <select className={`${inputClass} mt-1`} name="emergencyStopEngaged" defaultValue={String(policy.emergencyStopEngaged)}>
            <option value="true">inserito</option><option value="false">rimosso</option>
          </select>
        </label>
        <label className={labelClass}>Kill switch globale
          <select className={`${inputClass} mt-1`} name="globalKillSwitch" defaultValue={String(policy.globalKillSwitch)}>
            <option value="true">inserito</option><option value="false">rimosso</option>
          </select>
        </label>
      </div>

      <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
        <h3 className="font-extrabold text-fai-navy">Limiti desiderati</h3>
        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {([
            ['maxConcurrentGlobal', 'Concorrenza globale', 0, 1, policy.limits.maxConcurrentGlobal],
            ['maxConcurrentPerWorkflow', 'Per workflow', 0, 1, policy.limits.maxConcurrentPerWorkflow],
            ['maxConcurrentPerAgent', 'Per agente', 0, 1, policy.limits.maxConcurrentPerAgent],
            ['maxRetryableFailures', 'Failure ritentabili', 0, 3, policy.limits.maxRetryableFailures],
            ['leaseDurationMs', 'Lease ms', 30000, 120000, policy.limits.leaseDurationMs],
            ['heartbeatIntervalMs', 'Heartbeat ms', 10000, 30000, policy.limits.heartbeatIntervalMs],
            ['maxAttemptDurationMs', 'Tentativo max ms', 5000, 600000, policy.limits.maxAttemptDurationMs],
            ['dailyJobLimit', 'Job giornalieri', 0, 1000, policy.limits.dailyJobLimit],
          ] as const).map(([name, label, min, max, value]) => (
            <label className={labelClass} key={name}>{label}
              <input className={`${inputClass} mt-1`} name={name} type="number" min={min} max={max} step={1} defaultValue={value} required />
            </label>
          ))}
        </div>
      </div>

      <div className="grid gap-3 rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200 md:grid-cols-3">
        <label className={labelClass}>Finestra UTC
          <select className={`${inputClass} mt-1`} name="operatingWindowEnabled" defaultValue={String(policy.operatingWindow.enabled)}>
            <option value="false">disabilitata</option><option value="true">abilitata</option>
          </select>
        </label>
        <label className={labelClass}>Inizio UTC
          <input className={`${inputClass} mt-1`} name="operatingWindowStartUtc" type="time" defaultValue={minuteUtcToTime(policy.operatingWindow.startMinuteUtc)} />
        </label>
        <label className={labelClass}>Fine UTC
          <input className={`${inputClass} mt-1`} name="operatingWindowEndUtc" type="time" defaultValue={minuteUtcToTime(policy.operatingWindow.endMinuteUtc)} />
        </label>
      </div>

      <ReasonFields idPrefix="global" />
      <button className="rounded-2xl bg-fai-navy px-5 py-3 text-sm font-black text-white transition hover:bg-fai-blue" type="submit">Registra policy desiderata</button>
    </form>
  );
}

function ScopePolicyForm({ scope, requestId }: { scope: ScopeRevisionView; requestId: string }) {
  return (
    <form action={updateAiOrchestratorScopePolicyAction} className="space-y-4">
      <input type="hidden" name="requestId" value={requestId} />
      <input type="hidden" name="expectedVersion" value={scope.version} />
      <input type="hidden" name="expectedRevisionHash" value={scope.revisionHash} />
      <input type="hidden" name="scopeType" value={scope.scopeType} />
      <input type="hidden" name="scopeCode" value={scope.scopeCode} />
      <div className="grid gap-3 md:grid-cols-2">
        <label className={labelClass}>Abilitazione desiderata
          <select className={`${inputClass} mt-1`} name="desiredEnabled" defaultValue={String(scope.policy.desiredEnabled)}>
            <option value="false">disabilitata</option><option value="true">abilitata</option>
          </select>
        </label>
        <label className={labelClass}>Kill switch scope
          <select className={`${inputClass} mt-1`} name="killSwitch" defaultValue={String(scope.policy.killSwitch)}>
            <option value="true">inserito</option><option value="false">rimosso</option>
          </select>
        </label>
      </div>
      <ReasonFields idPrefix="scope" />
      <button className="rounded-2xl bg-fai-navy px-5 py-3 text-sm font-black text-white transition hover:bg-fai-blue" type="submit">Registra modifica scope</button>
    </form>
  );
}

function EmergencyStopForm({ requestId }: { requestId: string }) {
  return (
    <form action={engageAiOrchestratorEmergencyStopAction} className="space-y-4">
      <input type="hidden" name="requestId" value={requestId} />
      <p className="rounded-2xl bg-red-50 p-4 text-sm font-bold leading-6 text-red-800 ring-1 ring-red-200">Operazione monotona e CAS-less: forza la policy desiderata globale su STOPPED, disabilita la state machine desiderata e inserisce entrambi i kill switch. Non avvia né arresta un worker reale in questa Foundation.</p>
      <ReasonFields idPrefix="emergency" emergency />
      <button className="rounded-2xl bg-red-700 px-5 py-3 text-sm font-black text-white transition hover:bg-red-800" type="submit">Inserisci emergency stop</button>
    </form>
  );
}

export function AiOrchestratorAdminDashboard(props: DashboardProps) {
  const groupedScopes = ['PROVIDER', 'AGENT', 'CAPABILITY', 'JOB', 'WORKFLOW'].map((scopeType) => ({
    scopeType,
    scopes: props.scopes.filter((scope) => scope.scopeType === scopeType),
  }));
  const canMutate = props.mutationIntegritySafe;

  return (
    <div className="space-y-6">
      <PageHeader title="AI Orchestrator · Admin Control Center" description="Vista privata della configurazione desiderata e dei gate effettivi Foundation. Questa UI registra policy append-only ma non è collegata a worker, coda, runtime, dispatch o provider esterni." />

      <div className="rounded-3xl border border-fai-orange/30 bg-fai-orange/10 p-5 shadow-sm">
        <p className="text-xs font-black uppercase tracking-[0.18em] text-fai-orange">Stato contrattuale permanente</p>
        <h2 className="mt-1 text-xl font-black text-fai-navy">Configurazione desiderata, non operativa</h2>
        <p className="mt-2 text-sm leading-6 text-slate-700">Ogni valore inserito resta subordinato a Foundation lock, approvazione umana, gate ambiente/database e barriera fisica PostgreSQL. Nessuna modifica in questa pagina autorizza esecuzione o dispatch.</p>
      </div>

      {props.resultCode ? (
        <div className={`rounded-2xl p-4 text-sm font-bold ring-1 ${props.resultCode === 'UPDATED' || props.resultCode === 'REPLAYED' ? 'bg-emerald-50 text-emerald-800 ring-emerald-200' : 'bg-amber-50 text-amber-900 ring-amber-200'}`}>
          {AI_ORCHESTRATOR_ADMIN_UI_RESULT_MESSAGES[props.resultCode]}
        </div>
      ) : null}

      {!props.mutationIntegritySafe ? (
        <div className="rounded-2xl bg-red-50 p-4 text-sm font-bold text-red-800 ring-1 ring-red-200">Integrità del ledger non verificata: tutti i moduli di modifica sono rimossi e lo stato resta fail-closed.</div>
      ) : null}

      <Card title="Stato effettivo · sempre fail-closed" action={<Badge tone="orange">non operativo</Badge>}>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <GateCard label="Operativo" value={props.effective.operational} goodWhen={false} detail="Hard-coded false nella Foundation v1." />
          <GateCard label="Worker effettivo" value={props.effective.workerEnabled} goodWhen={false} detail="La UI non avvia processi worker." />
          <GateCard label="Dispatch effettivo" value={props.effective.dispatchEnabled} goodWhen={false} detail="Il dispatch resta impossibile." />
          <GateCard label="Bypass approvazione" value={props.effective.humanApprovalBypassAllowed} goodWhen={false} detail="La barriera umana non è configurabile." />
          <GateCard label="Gate ambiente osservato" value={props.effective.environmentWorkerGateOpen} goodWhen={false} detail="Un gate aperto non significa worker attivo." />
          <GateCard label="Gate state machine DB" value={props.effective.stateMachineGateOpen} goodWhen={false} detail="Stato letto dal singleton database." />
          <GateCard label="Gate dispatch DB" value={props.effective.databaseDispatchGateOpen} goodWhen={false} detail="Deve restare chiuso." />
          <GateCard label="Barriera fisica" value={props.effective.physicalDispatchBarrierPresent} detail="CHECK PostgreSQL validato." />
          <GateCard label="Provider mock" value={props.effective.providerIsMock} detail="Ambiente e database coerenti su mock." />
          <GateCard label="Synthetic-only" value={props.effective.syntheticDataOnly} detail="Nessun dato CRM reale ammesso." />
          <GateCard label="Provider esterni spenti" value={props.effective.externalProvidersDisabled} detail="Gate ambiente e database chiusi." />
          <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
            <p className="text-xs font-black uppercase tracking-wide text-slate-500">Capability abilitate</p>
            <p className="mt-2 text-lg font-extrabold text-fai-navy">{props.effective.enabledCapabilityCount}</p>
            <p className="mt-1 text-xs leading-5 text-slate-500">Atteso: zero su 13 capability canoniche.</p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {props.effective.blockReasons.map((code) => <Badge key={code} tone="gray">{labelAiOrchestratorAdminBlockReason(code)}</Badge>)}
        </div>
      </Card>

      <Card title="Policy globale desiderata" action={<div className="flex gap-2"><Badge tone="purple">v{props.global.version}</Badge><Badge tone="gray">{props.global.policy.desiredMode}</Badge></div>}>
        <div className="grid gap-3 text-sm md:grid-cols-2 xl:grid-cols-4">
          <p><span className="font-extrabold text-fai-navy">State machine:</span> <BooleanBadge value={props.global.policy.desiredStateMachineEnabled} goodWhen={false} /></p>
          <p><span className="font-extrabold text-fai-navy">Dispatch:</span> <BooleanBadge value={props.global.policy.desiredDispatchEnabled} goodWhen={false} /></p>
          <p><span className="font-extrabold text-fai-navy">Emergency stop:</span> <BooleanBadge value={props.global.policy.emergencyStopEngaged} /></p>
          <p><span className="font-extrabold text-fai-navy">Kill globale:</span> <BooleanBadge value={props.global.policy.globalKillSwitch} /></p>
          <p><span className="font-extrabold text-fai-navy">Provider:</span> {props.global.policy.provider}</p>
          <p><span className="font-extrabold text-fai-navy">Synthetic-only:</span> {props.global.policy.syntheticDataOnly ? 'sì' : 'no'}</p>
          <p><span className="font-extrabold text-fai-navy">Activation epoch:</span> {props.global.policy.activationEpoch}</p>
          <p><span className="font-extrabold text-fai-navy">Revision hash:</span> <code>{hashPreview(props.global.revisionHash)}</code></p>
        </div>
        <p className="mt-3 text-xs text-slate-500">Ultima revisione: {formatDateTime(props.global.createdAt)} · policy hash {hashPreview(props.global.policyHash)}</p>
        {canMutate && props.permissions.canConfigure ? <div className="mt-5"><GlobalPolicyForm global={props.global} requestId={props.requestIds.global} /></div> : <p className="mt-5 rounded-2xl bg-slate-50 p-4 text-sm text-slate-600 ring-1 ring-slate-200">Vista in sola lettura. Serve `ai.orchestrator.configure`; i permessi specifici vengono ricalcolati nella transazione.</p>}
      </Card>

      <Card title="Scope canonici · 35">
        <div className="grid gap-4 lg:grid-cols-2">
          {groupedScopes.map((group) => (
            <section className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200" key={group.scopeType}>
              <div className="flex items-center justify-between gap-2"><h3 className="font-extrabold text-fai-navy">{AI_ORCHESTRATOR_ADMIN_SCOPE_LABELS[group.scopeType]}</h3><Badge tone="gray">{group.scopes.length}</Badge></div>
              <div className="mt-3 flex flex-wrap gap-2">
                {group.scopes.map((scope) => {
                  const active = props.selectedScope?.scopeType === scope.scopeType && props.selectedScope.scopeCode === scope.scopeCode;
                  const query = new URLSearchParams({ scopeType: scope.scopeType, scopeCode: scope.scopeCode });
                  if (props.historyMode !== 'all') query.set('audit', props.historyMode);
                  return <Link className={`rounded-xl px-3 py-2 text-xs font-bold ring-1 ${active ? 'bg-fai-navy text-white ring-fai-navy' : 'bg-white text-slate-700 ring-slate-200 hover:ring-fai-blue'}`} href={`/settings/ai-orchestrator?${query.toString()}`} key={`${scope.scopeType}:${scope.scopeCode}`}>{scope.scopeCode}</Link>;
                })}
              </div>
            </section>
          ))}
        </div>
      </Card>

      <Card title="Scope selezionato" action={props.selectedScope ? <Badge tone="blue">{props.selectedScope.scopeType}</Badge> : undefined}>
        {!props.selectedScope ? <EmptyState title="Selezionare uno scope canonico" /> : (
          <div className="space-y-4">
            <div className="grid gap-3 text-sm md:grid-cols-2 xl:grid-cols-4">
              <p><span className="font-extrabold text-fai-navy">Codice:</span> {props.selectedScope.scopeCode}</p>
              <p><span className="font-extrabold text-fai-navy">Versione:</span> {props.selectedScope.version}</p>
              <p><span className="font-extrabold text-fai-navy">Desired enabled:</span> <BooleanBadge value={props.selectedScope.policy.desiredEnabled} goodWhen={false} /></p>
              <p><span className="font-extrabold text-fai-navy">Kill switch:</span> <BooleanBadge value={props.selectedScope.policy.killSwitch} /></p>
              <p className="md:col-span-2"><span className="font-extrabold text-fai-navy">Definition hash:</span> <code>{hashPreview(props.selectedScope.targetDefinitionHash)}</code></p>
              <p className="md:col-span-2"><span className="font-extrabold text-fai-navy">Revision hash:</span> <code>{hashPreview(props.selectedScope.revisionHash)}</code></p>
            </div>
            {canMutate && props.permissions.canConfigure ? <ScopePolicyForm scope={props.selectedScope} requestId={props.requestIds.scope} /> : <p className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-600 ring-1 ring-slate-200">Modifica scope non disponibile per questa sessione.</p>}
          </div>
        )}
      </Card>

      {canMutate && props.permissions.canEmergencyStop ? <Card title="Emergency stop" action={<Badge tone="orange">azione critica</Badge>}><EmergencyStopForm requestId={props.requestIds.emergency} /></Card> : null}

      {props.permissions.canAudit ? (
        <Card title="Storico append-only" action={<Badge tone="purple">audit autorizzato</Badge>}>
          <div className="mb-4 flex flex-wrap gap-2" aria-label="Filtro storico Orchestrator">
            {([
              ['all', 'Tutto il ledger'],
              ['global', 'Policy globale ed emergenze'],
              ['scope', props.selectedScope ? `Scope ${props.selectedScope.scopeCode}` : 'Scope selezionato'],
            ] as const).map(([mode, label]) => (
              <Link
                className={`rounded-xl px-3 py-2 text-xs font-black ring-1 ${props.historyMode === mode ? 'bg-fai-navy text-white ring-fai-navy' : 'bg-white text-slate-700 ring-slate-200 hover:ring-fai-blue'}`}
                href={historyHref(mode, props.selectedScope)}
                key={mode}
              >
                {label}
              </Link>
            ))}
          </div>
          {props.historyMessage ? <p className="mb-4 rounded-2xl bg-amber-50 p-4 text-sm font-bold text-amber-900 ring-1 ring-amber-200">{props.historyMessage}</p> : null}
          {!props.history || props.history.length === 0 ? <EmptyState title="Nessuna revisione disponibile" /> : (
            <Table headers={['Data', 'Target', 'Operazione', 'Attore', 'Motivazione', 'Versione']} rows={props.history.map((revision) => [
              formatDateTime(revision.createdAt),
              <span key="target"><strong>{revision.scopeType}</strong><br /><span className="text-xs">{revision.scopeCode}</span></span>,
              <span key="operation"><Badge tone="gray">{revision.operationCode}</Badge><br /><span className="text-xs">{revision.reasonCode}</span></span>,
              revision.actorUserId ? `${revision.actorRole ?? 'ruolo non disponibile'} · ${revision.actorUserId}` : 'Sistema Foundation',
              <span className="max-w-md whitespace-pre-wrap break-words" key="reason">{revision.reason}</span>,
              <span key="version">v{revision.version}<br /><code className="text-xs">{hashPreview(revision.revisionHash)}</code></span>,
            ])} />
          )}
          {props.historyNextHref ? <Link className="mt-4 inline-flex rounded-2xl bg-slate-100 px-4 py-2 text-sm font-black text-fai-navy ring-1 ring-slate-200 hover:bg-white" href={props.historyNextHref}>Revisioni precedenti →</Link> : null}
          <p className="mt-4 text-xs leading-5 text-slate-500">La motivazione completa è mostrata solo dopo la verifica database del permesso `ai.orchestrator.audit`.</p>
        </Card>
      ) : null}
    </div>
  );
}
