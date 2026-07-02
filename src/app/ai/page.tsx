export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { PrimaryButton } from '@/components/actions';
import { runMockAiAndRedirect } from '@/lib/form-actions';
import { Card, EmptyState, PageHeader, StatusBadge, Table } from '@/components/ui';
import { prisma } from '@/lib/prisma';
import { getAiAgentCategory, isPrimaryOperationalAiAgent, sortAiAgentsByCategory } from '@/lib/ai-agent-catalog';

export default async function Page() {
  const agents = sortAiAgentsByCategory(await prisma.aiAgent.findMany({ orderBy: { name: 'asc' } }));
  const activeAgents = agents.filter((agent) => agent.active && isPrimaryOperationalAiAgent(agent.code));

  return (
    <div className="space-y-6">
      <PageHeader title="AI interno" description="Agenti e output AI sono strumenti interni: ogni contenuto resta bozza fino alla revisione umana obbligatoria." />
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Azioni rapide">
          <div className="flex flex-wrap gap-3">
            <Link className="rounded-xl bg-fai-blue px-4 py-2 text-sm font-bold text-white" href="/ai/runs">Storico run</Link>
            <Link className="rounded-xl bg-fai-orange px-4 py-2 text-sm font-bold text-white" href="/ai/outputs-to-review">Output da revisionare</Link>
          </div>
        </Card>
        <Card title="Run AI mock">
          {activeAgents.length === 0 ? (
            <EmptyState title="Nessun agente attivo">Riattivare almeno un agente da Impostazioni &gt; Agenti AI per eseguire una bozza mock.</EmptyState>
          ) : (
            <form action={runMockAiAndRedirect} className="space-y-3">
              <select name="agentCode" className="w-full rounded-xl border p-3" required>
                {activeAgents.map((agent) => <option key={agent.code} value={agent.code}>{agent.name} · {getAiAgentCategory(agent.code)}</option>)}
              </select>
              <textarea name="prompt" className="w-full rounded-xl border p-3" placeholder="Input interno per bozza AI" defaultValue="Genera una bozza interna da revisionare." />
              <PrimaryButton type="submit">Run AI mock</PrimaryButton>
            </form>
          )}
        </Card>
        <Card title="Regola operativa"><p className="text-sm text-fai-gray">Bozza AI, da revisionare e approvato internamente sono stati distinti e non comportano invio automatico al cliente.</p></Card>
      </div>
      <Card title="Catalogo agenti">
        {agents.length === 0 ? <EmptyState /> : <Table headers={['Agente', 'Categoria', 'Codice', 'Prompt', 'Stato']} rows={agents.map((agent) => [agent.name, getAiAgentCategory(agent.code), agent.code, agent.promptVersion, <StatusBadge status={agent.active ? 'attivo' : 'disattivato'} key="s" />])} />}
      </Card>
    </div>
  );
}
