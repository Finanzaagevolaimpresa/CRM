export const dynamic = 'force-dynamic';

import { Badge, Card, PageHeader, TimestampMeta } from '@/components/ui';
import { updateAiAgentConfig } from '@/lib/actions';
import { requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

function checklist(value: unknown) {
  return Array.isArray(value) ? value.map(String) : [];
}

export default async function Page() {
  await requirePermission('ai_agents.read');
  const agents = await prisma.aiAgent.findMany({ orderBy: { code: 'asc' } });

  return (
    <div className="space-y-6">
      <PageHeader title="Agenti AI interni" description="Configurazione server-side degli agenti interni CRM FAI. In questo step il provider resta mock: nessuna API AI reale viene invocata." />
      <div className="grid gap-5">
        {agents.map((agent) => (
          <Card key={agent.id} title={`${agent.name} · ${agent.code}`} action={<Badge tone={agent.active ? 'green' : 'gray'}>{agent.active ? 'attivo' : 'non attivo'}</Badge>}>
            <div className="grid gap-4 text-sm leading-6 text-slate-700 lg:grid-cols-2">
              <div className="space-y-3">
                <p><span className="font-extrabold text-fai-navy">Descrizione:</span> {agent.description || '—'}</p>
                <p><span className="font-extrabold text-fai-navy">Ambito operativo:</span> {agent.operationalScope || '—'}</p>
                <p><span className="font-extrabold text-fai-navy">Output atteso:</span> {agent.expectedOutput || '—'}</p>
                <p><span className="font-extrabold text-fai-navy">Tono/stile:</span> {agent.toneStyle || '—'}</p>
                <p><span className="font-extrabold text-fai-navy">Provider:</span> {agent.provider} {agent.futureModel ? `· modello futuro ${agent.futureModel}` : ''}</p>
                <div>
                  <p className="font-extrabold text-fai-navy">Checklist dati richiesti</p>
                  <ul className="mt-1 list-disc pl-5">{checklist(agent.requiredDataChecklist).map((item) => <li key={item}>{item}</li>)}</ul>
                </div>
                <TimestampMeta createdAt={agent.createdAt} updatedAt={agent.updatedAt} />
              </div>
              <form action={updateAiAgentConfig} className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
                <input type="hidden" name="id" value={agent.id} />
                <label className="block text-xs font-black uppercase tracking-wide text-fai-navy" htmlFor={`prompt-${agent.id}`}>Istruzioni / prompt di sistema</label>
                <textarea id={`prompt-${agent.id}`} name="systemPrompt" defaultValue={agent.systemPrompt} className="min-h-56 w-full rounded-2xl border border-slate-200 bg-white p-4 text-sm leading-6 text-slate-700 outline-none transition focus:border-fai-blue focus:ring-2 focus:ring-fai-blue/20" />
                <label className="flex items-center gap-2 text-sm font-bold text-fai-navy"><input type="checkbox" name="active" defaultChecked={agent.active} className="h-4 w-4 rounded border-slate-300" /> Agente attivo</label>
                <button className="rounded-2xl bg-fai-navy px-5 py-3 text-sm font-black text-white transition hover:bg-fai-blue" type="submit">Salva configurazione</button>
              </form>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
