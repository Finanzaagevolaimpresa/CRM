export const dynamic = 'force-dynamic';
import { Card, EmptyState, PageHeader, StatusBadge, Table, formatDateTime } from '@/components/ui';
import { prisma } from '@/lib/prisma';
import { requirePermission } from '@/lib/auth';
export default async function Page(){ await requirePermission('ai.run'); const [runs, agents] = await Promise.all([prisma.aiRun.findMany({ orderBy:{createdAt:'desc'}, take:100 }), prisma.aiAgent.findMany()]); const agent = new Map(agents.map(a=>[a.id,a.name])); return <div className="space-y-6"><PageHeader title="AI runs" description="Storico run agenti con stato, input/output conservati internamente e tracciabilità operativa."/><Card title="Run recenti">{runs.length===0?<EmptyState/>:<Table headers={['Agente','Stato','Creato il','Creato da']} rows={runs.map(r=>[agent.get(r.agentId)??r.agentId,<StatusBadge status={r.status} key='s'/>,formatDateTime(r.createdAt),r.createdById??'Sistema'])}/>}</Card></div> }
