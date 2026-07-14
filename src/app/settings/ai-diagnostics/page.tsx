export const dynamic = 'force-dynamic';

import { randomUUID } from 'node:crypto';
import { Badge, Card, PageHeader } from '@/components/ui';
import { runAiProviderDiagnosticTest } from '@/lib/actions';
import { getAiProviderDiagnostics } from '@/lib/ai';
import { getAiControlPolicy } from '@/lib/ai-control-plane';
import { hasPermission, requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

function yesNo(value: boolean) {
  return value ? 'sì' : 'no';
}

export default async function Page({ searchParams }: { searchParams?: Promise<{ status?: string; message?: string }> }) {
  const session = await requirePermission('ai_agents.read');
  const diagnostics = getAiProviderDiagnostics();
  const controlPolicy = await getAiControlPolicy();
  const params = await searchParams;
  const status = params?.status;
  const message = params?.message;
  const externalDiagnostic = diagnostics.provider === 'openai';
  const canRunExternalDiagnostic = hasPermission(session, 'ai.run') && hasPermission(session, 'ai.external.run');
  const selectedModelAllowed = controlPolicy.allowedModels.includes(diagnostics.model);
  const diagnosticAgent = externalDiagnostic ? await prisma.aiAgent.findFirst({
    where: { active: true, provider: 'openai', futureModel: diagnostics.model },
    select: { id: true },
  }) : null;
  const externalRuntimeReady = controlPolicy.effectiveExternalProvidersEnabled
    && controlPolicy.allowedModels.length > 0
    && selectedModelAllowed
    && diagnostics.hasApiKey
    && Boolean(diagnosticAgent);
  const diagnosticRequestKey = randomUUID();

  return (
    <div className="space-y-6">
      <PageHeader title="Diagnostica provider AI" description="Pannello admin/direzione per verificare configurazione e raggiungibilità del provider AI senza esporre chiavi, prompt sensibili o dati cliente." />

      <Card title="Control Plane provider esterni" action={<Badge tone={externalRuntimeReady ? 'green' : 'orange'}>{externalRuntimeReady ? 'pronto' : 'fail-closed'}</Badge>}>
        <div className="grid gap-4 text-sm leading-6 text-slate-700 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
            <p className="text-xs font-black uppercase tracking-wide text-slate-500">Gate ambiente</p>
            <p className="mt-1 text-lg font-extrabold text-fai-navy">{controlPolicy.environmentEnabled ? 'abilitato' : 'disabilitato'}</p>
            <p className="mt-1 text-xs text-slate-500">AI_EXTERNAL_PROVIDERS_ENABLED</p>
          </div>
          <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
            <p className="text-xs font-black uppercase tracking-wide text-slate-500">Switch database</p>
            <p className="mt-1 text-lg font-extrabold text-fai-navy">{controlPolicy.databaseEnabled ? 'abilitato' : 'disabilitato'}</p>
            <p className="mt-1 text-xs text-slate-500">Kill switch operativo auditato</p>
          </div>
          <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
            <p className="text-xs font-black uppercase tracking-wide text-slate-500">Allowlist modelli</p>
            <p className="mt-1 text-lg font-extrabold text-fai-navy">{controlPolicy.allowedModels.length}</p>
            <p className="mt-1 break-words text-xs text-slate-500">{controlPolicy.allowedModels.join(', ') || 'vuota: ogni modello esterno è bloccato'}</p>
          </div>
          <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
            <p className="text-xs font-black uppercase tracking-wide text-slate-500">Limite personale</p>
            <p className="mt-1 text-lg font-extrabold text-fai-navy">{controlPolicy.maxExternalRunsPerUserPerHour}/ora</p>
            <p className="mt-1 text-xs text-slate-500">Conta gli AiRun esterni riservati nell'ultima ora</p>
          </div>
        </div>
        <div className="mt-5 grid gap-3 text-sm leading-6">
          <p className={`rounded-2xl p-4 font-bold ring-1 ${controlPolicy.effectiveExternalProvidersEnabled ? 'bg-fai-teal/10 text-fai-green ring-fai-teal/20' : 'bg-fai-orange/10 text-fai-orange ring-fai-orange/20'}`}>Doppio kill switch: gate ambiente e switch database devono essere entrambi attivi. Uno stato mancante o non valido blocca le chiamate esterne.</p>
          <p className="rounded-2xl bg-slate-50 p-4 text-slate-700 ring-1 ring-slate-200">La chiave API non è mai mostrata. La allowlist vuota o un modello non incluso mantengono il runtime fail-closed anche quando i due switch sono attivi.</p>
        </div>
      </Card>

      <Card title="Stato configurazione" action={<Badge tone={diagnostics.configurationStatus === 'ok' ? 'green' : 'orange'}>{diagnostics.configurationStatus}</Badge>}>
        <div className="grid gap-4 text-sm leading-6 text-slate-700 md:grid-cols-2 xl:grid-cols-3">
          <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
            <p className="text-xs font-black uppercase tracking-wide text-slate-500">AI_PROVIDER attivo</p>
            <p className="mt-1 text-lg font-extrabold text-fai-navy">{diagnostics.configuredProvider}</p>
          </div>
          <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
            <p className="text-xs font-black uppercase tracking-wide text-slate-500">AI_MODEL configurato</p>
            <p className="mt-1 text-lg font-extrabold text-fai-navy">{diagnostics.model || 'non configurato'}</p>
          </div>
          <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
            <p className="text-xs font-black uppercase tracking-wide text-slate-500">AI_API_KEY presente</p>
            <p className="mt-1 text-lg font-extrabold text-fai-navy">{yesNo(diagnostics.hasApiKey)}</p>
            <p className="mt-1 text-xs text-slate-500">La chiave non viene mai mostrata.</p>
          </div>
          <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
            <p className="text-xs font-black uppercase tracking-wide text-slate-500">Modalità attiva</p>
            <p className="mt-1 text-lg font-extrabold text-fai-navy">{diagnostics.mode}</p>
          </div>
          <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
            <p className="text-xs font-black uppercase tracking-wide text-slate-500">Provider normalizzato</p>
            <p className="mt-1 text-lg font-extrabold text-fai-navy">{diagnostics.provider}</p>
          </div>
          <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
            <p className="text-xs font-black uppercase tracking-wide text-slate-500">Output diagnostici</p>
            <p className="mt-1 font-semibold text-slate-600">Nessun AiOutput o dossier. Il test esterno registra un AiRun tecnico minimizzato e auditato.</p>
          </div>
        </div>

        <div className="mt-5 grid gap-3 text-sm leading-6">
          {diagnostics.provider === 'openai' ? <p className="rounded-2xl bg-fai-orange/10 p-4 font-bold text-fai-orange ring-1 ring-fai-orange/20">Avviso costi: la modalità OpenAI può generare costi del provider esterno anche per test minimi.</p> : null}
          <p className="rounded-2xl bg-fai-purple/10 p-4 font-bold text-fai-purple ring-1 ring-fai-purple/20">Revisione umana obbligatoria: ogni output AI operativo resta una bozza interna da validare manualmente.</p>
        </div>
      </Card>

      <Card title="Test provider" action={<Badge tone="purple">server-side</Badge>}>
        <div className="space-y-4 text-sm leading-6 text-slate-700">
          <p>Il test usa un prompt tecnico minimale interno, non usa dati cliente reali, non crea AiOutput o dossier e non registra API key. Il test OpenAI riserva un AiRun tecnico con soli metadati minimizzati, stato, utilizzo token e audit; valgono doppio kill switch, allowlist, `ai.run`, `ai.external.run` e `store: false`.</p>
          {message ? <div className={`rounded-2xl p-4 font-bold ring-1 ${status === 'ok' ? 'bg-fai-teal/10 text-fai-green ring-fai-teal/20' : 'bg-fai-orange/10 text-fai-orange ring-fai-orange/20'}`}>{status === 'ok' ? 'ok' : 'errore controllato'} · {message}</div> : null}
          <form action={runAiProviderDiagnosticTest} className="space-y-3">
            <input type="hidden" name="requestKey" value={diagnosticRequestKey} />
            {externalDiagnostic ? <label className="flex items-start gap-2 rounded-2xl bg-fai-orange/10 p-4 font-bold text-fai-orange ring-1 ring-fai-orange/20">
              <input className="mt-1 h-4 w-4 rounded border-slate-300" type="checkbox" name="externalDiagnosticConfirmed" required />
              <span>Confermo questo singolo test OpenAI, la chiamata al provider esterno e il possibile costo. Il test non usa dati cliente e la conferma non viene riutilizzata.</span>
            </label> : null}
            <button className="rounded-2xl bg-fai-navy px-5 py-3 text-sm font-black text-white transition hover:bg-fai-blue disabled:cursor-not-allowed disabled:opacity-50" type="submit" disabled={externalDiagnostic && (!canRunExternalDiagnostic || !externalRuntimeReady)}>Esegui test provider</button>
          </form>
          {externalDiagnostic && !canRunExternalDiagnostic ? <p className="font-bold text-fai-orange">Il test OpenAI richiede i permessi `ai.run` e `ai.external.run`.</p> : null}
          {externalDiagnostic && canRunExternalDiagnostic && !externalRuntimeReady ? <p className="font-bold text-fai-orange">Test OpenAI bloccato: completare gate ambiente, switch database, allowlist, modello, chiave server-side e configurare un agente OpenAI attivo con il modello diagnostico.</p> : null}
        </div>
      </Card>
    </div>
  );
}
