export const dynamic = 'force-dynamic';

import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { PrimaryButton } from '@/components/actions';
import { runMockAiAndRedirect } from '@/lib/form-actions';
import { Card, EmptyState, PageHeader, StatusBadge, Table } from '@/components/ui';
import { prisma } from '@/lib/prisma';
import { getAiAgentCategory, isPrimaryOperationalAiAgent, sortAiAgentsByCategory } from '@/lib/ai-agent-catalog';
import { hasPermission, requirePermission } from '@/lib/auth';

export default async function Page({ searchParams }: { searchParams?: Promise<{ supersedesRequestId?: string }> }) {
  const session = await requirePermission('ai.review');
  const params = await searchParams;
  const agents = sortAiAgentsByCategory(await prisma.aiAgent.findMany({ orderBy: { name: 'asc' } }));
  const activeAgents = agents.filter((agent) => agent.active && isPrimaryOperationalAiAgent(agent.code));
  const canQuickRunMock = hasPermission(session, 'ai_agents.write')
    && hasPermission(session, 'ai.execution.request');
  const quickRunRequestKey = canQuickRunMock ? randomUUID() : null;
  const replacementSource = params?.supersedesRequestId && canQuickRunMock
    ? await prisma.aiExecutionRequest.findFirst({
        where: {
          id: params.supersedesRequestId,
          origin: 'CRM_UI',
          requesterKind: 'HUMAN_USER',
          requesterUserId: session.userId,
          status: 'NEEDS_INFORMATION',
          functionCode: 'ADMIN_MOCK_QUICK_RUN',
          purposeCode: 'ADMINISTRATIVE_DRAFT',
          authorizationGrant: null,
          runs: { none: {} },
          supersededBy: null,
        },
        select: { id: true, agentConfig: { select: { code: true } } },
      })
    : null;

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
        <Card title="Quick-run amministrativo">
          {!canQuickRunMock ? (
            <EmptyState title="Funzione riservata">Il quick-run senza fascicolo è disponibile solo ad amministratori e direzione. Gli operatori eseguono gli agenti dal fascicolo cliente.</EmptyState>
          ) : activeAgents.length === 0 ? (
            <EmptyState title="Nessun agente attivo">Riattivare almeno un agente da Impostazioni &gt; Agenti AI per generare una bozza interna.</EmptyState>
          ) : (
            <form action={runMockAiAndRedirect} className="space-y-3">
              <input type="hidden" name="requestKey" value={quickRunRequestKey ?? ''} />
              {replacementSource ? <input type="hidden" name="supersedesRequestId" value={replacementSource.id} /> : null}
              {replacementSource ? <p className="rounded-2xl bg-amber-50 p-4 text-sm font-bold text-amber-900 ring-1 ring-amber-200">Richiesta sostitutiva: integra il prompt prima dell’invio. La richiesta chiusa resta immutabile.</p> : null}
              <select name="agentCode" className="w-full rounded-xl border p-3" defaultValue={replacementSource?.agentConfig.code} required>
                {activeAgents.map((agent) => <option key={agent.code} value={agent.code}>{agent.name} · {getAiAgentCategory(agent.code)}</option>)}
              </select>
              <textarea name="prompt" className="w-full rounded-xl border p-3" placeholder="Input interno per bozza AI" defaultValue="Genera una bozza interna da revisionare." />
              <p className="text-xs leading-5 text-slate-500">Crea una richiesta persistente e notifica tutti gli Admin attivi. Non genera output, non crea un AiRun e non invoca nemmeno il provider mock.</p>
              <PrimaryButton type="submit">{replacementSource ? 'Invia quick mock sostitutivo' : 'Richiedi autorizzazione quick mock'}</PrimaryButton>
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
