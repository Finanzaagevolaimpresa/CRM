export const dynamic = 'force-dynamic';

import { Badge, Card, PageHeader, TimestampMeta } from '@/components/ui';
import { updateAiAgentConfig, updateAiControlSetting } from '@/lib/actions';
import { getAiControlPolicy } from '@/lib/ai-control-plane';
import { hasPermission, requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getAiAgentCategory, sortAiAgentsByCategory } from '@/lib/ai-agent-catalog';

function checklist(value: unknown) {
  return Array.isArray(value) ? value.map(String) : [];
}

export default async function Page() {
  const session = await requirePermission('ai_agents.read');
  const [agentRows, controlPolicy] = await Promise.all([
    prisma.aiAgent.findMany({ orderBy: { code: 'asc' } }),
    getAiControlPolicy(),
  ]);
  const agents = sortAiAgentsByCategory(agentRows);
  const canWrite = hasPermission(session, 'ai_agents.write');
  const canManageControlPlane = hasPermission(session, 'settings.manage');
  const externalRuntimeConfigured = controlPolicy.effectiveExternalProvidersEnabled && controlPolicy.allowedModels.length > 0;

  return (
    <div className="space-y-6">
      <PageHeader title="Agenti AI interni" description="Control Plane server-side per provider, modelli autorizzati e prompt degli agenti interni CRM FAI. Nessuna chiave API viene mostrata o salvata da questa pagina." />

      <Card title="Kill switch provider esterni" action={<Badge tone={externalRuntimeConfigured ? 'green' : 'orange'}>{externalRuntimeConfigured ? 'gate aperto' : 'fail-closed'}</Badge>}>
        <div className="grid gap-4 text-sm leading-6 text-slate-700 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
            <p className="text-xs font-black uppercase tracking-wide text-slate-500">Gate ambiente</p>
            <p className="mt-1 text-lg font-extrabold text-fai-navy">{controlPolicy.environmentEnabled ? 'abilitato' : 'disabilitato'}</p>
            <p className="mt-1 text-xs text-slate-500">Modificabile solo nel deploy server.</p>
          </div>
          <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
            <p className="text-xs font-black uppercase tracking-wide text-slate-500">Switch database</p>
            <p className="mt-1 text-lg font-extrabold text-fai-navy">{controlPolicy.databaseEnabled ? 'abilitato' : 'disabilitato'}</p>
            <p className="mt-1 text-xs text-slate-500">Modifica manuale e auditata.</p>
          </div>
          <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
            <p className="text-xs font-black uppercase tracking-wide text-slate-500">Modelli autorizzati</p>
            <p className="mt-1 text-lg font-extrabold text-fai-navy">{controlPolicy.allowedModels.length}</p>
            <p className="mt-1 break-words text-xs text-slate-500">{controlPolicy.allowedModels.join(', ') || 'Allowlist vuota: OpenAI bloccato.'}</p>
          </div>
          <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
            <p className="text-xs font-black uppercase tracking-wide text-slate-500">Gate combinato</p>
            <p className="mt-1 text-lg font-extrabold text-fai-navy">{controlPolicy.effectiveExternalProvidersEnabled ? 'aperto' : 'chiuso'}</p>
            <p className="mt-1 text-xs text-slate-500">Serve anche una allowlist non vuota.</p>
          </div>
        </div>

        <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_420px]">
          <div className="space-y-3 text-sm leading-6 text-slate-700">
            <p className="rounded-2xl bg-fai-orange/10 p-4 font-bold text-fai-orange ring-1 ring-fai-orange/20">Fail-closed: gate ambiente e switch database devono essere entrambi attivi; una allowlist vuota o un modello non autorizzato blocca comunque il run esterno.</p>
            <p>Ogni run OpenAI richiede inoltre agente attivo, modello ammesso, chiave API server-side, permessi `ai.run` e `ai.external.run`, conferma per la singola esecuzione e limite personale disponibile. Disattivare questo switch ferma nuove chiamate esterne senza modificare i singoli agenti.</p>
            <p className="text-xs text-slate-500">Ultimo aggiornamento switch: {controlPolicy.updatedAt ? controlPolicy.updatedAt.toLocaleString('it-IT') : 'nessuna configurazione salvata; default disabilitato'}.</p>
          </div>
          {canManageControlPlane ? <form action={updateAiControlSetting} className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
            <input type="hidden" name="expectedUpdatedAt" value={controlPolicy.updatedAt?.toISOString() ?? ''} />
            <label className="flex items-start gap-2 text-sm font-bold text-fai-navy">
              <input type="checkbox" name="externalProvidersEnabled" defaultChecked={controlPolicy.databaseEnabled} className="mt-1 h-4 w-4 rounded border-slate-300" />
              Abilita lo switch database per provider esterni
            </label>
            <label className="block text-xs font-black uppercase tracking-wide text-fai-navy" htmlFor="external-rate-limit">Run esterni massimi per utente / ora</label>
            <input id="external-rate-limit" name="maxExternalRunsPerUserPerHour" type="number" min={1} max={1000} required defaultValue={controlPolicy.maxExternalRunsPerUserPerHour} className="w-full rounded-xl border border-slate-200 bg-white p-3 text-sm" />
            <p className="text-xs leading-5 text-slate-600">L&apos;attivazione non supera il gate ambiente, l&apos;allowlist, i permessi o la conferma. Il salvataggio viene registrato nell&apos;audit log.</p>
            <button className="rounded-2xl bg-fai-navy px-5 py-3 text-sm font-black text-white transition hover:bg-fai-blue" type="submit">Salva Control Plane</button>
          </form> : <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">Visualizzazione in sola lettura. Serve `settings.manage` per modificare il kill switch.</div>}
        </div>
      </Card>

      <div className="grid gap-5">
        {agents.map((agent) => (
          <Card key={agent.id} title={`${agent.name} · ${agent.code}`} action={<div className="flex flex-wrap gap-2"><Badge tone={agent.provider === 'openai' ? 'orange' : 'gray'}>{agent.provider}</Badge><Badge tone={agent.active ? 'green' : 'gray'}>{agent.active ? 'attivo' : 'non attivo'}</Badge></div>}>
            <div className="grid gap-4 text-sm leading-6 text-slate-700 lg:grid-cols-2">
              <div className="space-y-3">
                <p><span className="font-extrabold text-fai-navy">Categoria:</span> <Badge tone="blue">{getAiAgentCategory(agent.code)}</Badge></p>
                <p><span className="font-extrabold text-fai-navy">Descrizione:</span> {agent.description || '—'}</p>
                <p><span className="font-extrabold text-fai-navy">Ambito operativo:</span> {agent.operationalScope || '—'}</p>
                <p><span className="font-extrabold text-fai-navy">Output atteso:</span> {agent.expectedOutput || '—'}</p>
                <p><span className="font-extrabold text-fai-navy">Tono/stile:</span> {agent.toneStyle || '—'}</p>
                <p><span className="font-extrabold text-fai-navy">Provider:</span> {agent.provider} {agent.futureModel ? `· modello ${agent.futureModel}` : '· nessun modello esterno'}</p>
                {agent.provider === 'openai' && (!agent.futureModel || !controlPolicy.allowedModels.includes(agent.futureModel)) ? <p className="rounded-2xl bg-fai-orange/10 p-3 text-xs font-bold text-fai-orange ring-1 ring-fai-orange/20">Configurazione bloccata: il modello corrente non è presente nella allowlist server.</p> : null}
                <div>
                  <p className="font-extrabold text-fai-navy">Checklist dati richiesti</p>
                  <ul className="mt-1 list-disc pl-5">{checklist(agent.requiredDataChecklist).map((item) => <li key={item}>{item}</li>)}</ul>
                </div>
                <TimestampMeta createdAt={agent.createdAt} updatedAt={agent.updatedAt} />
              </div>
              {canWrite ? <form action={updateAiAgentConfig} className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
                <input type="hidden" name="id" value={agent.id} />
                <input type="hidden" name="expectedConfigVersion" value={agent.configVersion} />
                <label className="block text-xs font-black uppercase tracking-wide text-fai-navy" htmlFor={`provider-${agent.id}`}>Provider</label>
                <select id={`provider-${agent.id}`} name="provider" defaultValue={agent.provider} className="w-full rounded-xl border border-slate-200 bg-white p-3 text-sm">
                  <option value="mock">mock · nessuna chiamata esterna</option>
                  <option value="openai">openai · richiede tutti i gate</option>
                </select>
                <label className="block text-xs font-black uppercase tracking-wide text-fai-navy" htmlFor={`model-${agent.id}`}>Modello esterno</label>
                <select id={`model-${agent.id}`} name="futureModel" defaultValue={agent.futureModel && controlPolicy.allowedModels.includes(agent.futureModel) ? agent.futureModel : ''} className="w-full rounded-xl border border-slate-200 bg-white p-3 text-sm">
                  <option value="">Nessun modello · usare con mock</option>
                  {controlPolicy.allowedModels.map((model) => <option key={model} value={model}>{model}</option>)}
                </select>
                <p className="text-xs leading-5 text-slate-500">OpenAI richiede un modello della allowlist; mock richiede “Nessun modello”. La lista viene dalla configurazione server e non può essere ampliata da questo form.</p>
                <label className="block text-xs font-black uppercase tracking-wide text-fai-navy" htmlFor={`prompt-${agent.id}`}>Istruzioni / prompt di sistema</label>
                <textarea id={`prompt-${agent.id}`} name="systemPrompt" defaultValue={agent.systemPrompt} className="min-h-56 w-full rounded-2xl border border-slate-200 bg-white p-4 text-sm leading-6 text-slate-700 outline-none transition focus:border-fai-blue focus:ring-2 focus:ring-fai-blue/20" />
                <label className="flex items-center gap-2 text-sm font-bold text-fai-navy"><input type="checkbox" name="active" defaultChecked={agent.active} className="h-4 w-4 rounded border-slate-300" /> Agente attivo</label>
                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900"><strong>Suggerimento miglioramento prompt:</strong> eventuali proposte, incluse quelle dell’agente governance, devono essere valutate da admin/direzione. Nessun prompt viene modificato automaticamente; il salvataggio manuale resta tracciato in audit log.</div>
                <button className="rounded-2xl bg-fai-navy px-5 py-3 text-sm font-black text-white transition hover:bg-fai-blue" type="submit">Salva configurazione</button>
              </form> : <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">Configurazione in sola lettura. Serve `ai_agents.write` per modificare agente, provider, modello o prompt.</div>}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
