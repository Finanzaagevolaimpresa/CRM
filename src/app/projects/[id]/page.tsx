export const dynamic = 'force-dynamic';

import { SecondaryLink } from '@/components/actions';
import Link from 'next/link';
import { Card, EmptyState, PageHeader, StatusBadge, Table, TimestampMeta, formatDateTime } from '@/components/ui';
import { hasPermission, requirePermission } from '@/lib/auth';
import { effectiveAiExecutionRequestStatus } from '@/lib/ai-execution-authorization';
import { prisma } from '@/lib/prisma';
import { getProjectReadAccess } from '@/lib/read-access';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('project.read');
  const { id } = await params;
  const project = await getProjectReadAccess(session, id);
  if (!project) return <PageHeader title="Progetto non trovato" description="Il record richiesto non esiste o non è accessibile." />;
  const canAuditAiRequests = session.role === 'admin' && hasPermission(session, 'ai.execution.audit');
  const canRequestAi = hasPermission(session, 'ai.execution.request');
  const [expenses, client, consultant, aiExecutionRequests] = await Promise.all([
    prisma.projectExpense.findMany({ where: { projectId: id } }),
    prisma.client.findFirst({ where: { id: project.clientId, deletedAt: null } }),
    project.consultantId ? prisma.user.findUnique({ where: { id: project.consultantId } }) : null,
    canAuditAiRequests || canRequestAi
      ? prisma.aiExecutionRequest.findMany({
          where: { projectId: id, ...(canAuditAiRequests ? {} : { requesterUserId: session.userId }) },
          include: { requester: { select: { name: true } } },
          orderBy: { createdAt: 'desc' },
          take: 15,
        })
      : Promise.resolve([]),
  ]);

  return <div className="space-y-6">
    <PageHeader title={`Progetto — ${project.title}`} description="Scheda progetto nel perimetro cliente autorizzato, con importi, stato e voci di spesa." />
    <SecondaryLink href="/projects">← Torna alla lista</SecondaryLink>
    <Card title="Dati progetto">
      <p>Cliente: {client?.displayName ?? 'Cliente non disponibile'}</p>
      <p>Investimento: {project.totalInvestment ? `€ ${Number(project.totalInvestment).toLocaleString('it-IT')}` : '—'}</p>
      <p>Richiesto: {project.requestedAmount ? `€ ${Number(project.requestedAmount).toLocaleString('it-IT')}` : '—'}</p>
      <p>Stato: <StatusBadge status={project.status} /></p>
      <p className="mt-2 whitespace-pre-wrap text-sm text-fai-gray">{project.description ?? 'Nessun dato presente'}</p>
      <TimestampMeta createdAt={project.createdAt} updatedAt={project.updatedAt} updatedBy={consultant?.name ?? project.consultantId} />
    </Card>
    <Card title="Spese progetto">
      {expenses.length === 0 ? <EmptyState title="Nessun dato presente">Nessuna voce di spesa progetto registrata.</EmptyState> : <Table headers={['Categoria', 'Descrizione', 'Importo', 'Ammissibilità']} rows={expenses.map((expense) => [expense.category, expense.description, `€ ${Number(expense.amount).toLocaleString('it-IT')}`, expense.potentiallyEligible ? 'Potenzialmente' : 'Da verificare'])} />}
    </Card>
    <Card title="Autorizzazioni AI collegate">
      {aiExecutionRequests.length === 0 ? <EmptyState title="Nessuna richiesta AI collegata" /> : <Table headers={['Richiedente', 'Funzione', 'Stato', 'Creata', 'Dettaglio']} rows={aiExecutionRequests.map((request) => [
        request.requester?.name ?? 'Sistema',
        request.functionCode.replaceAll('_', ' '),
        <StatusBadge key="status" status={effectiveAiExecutionRequestStatus(request)} />,
        formatDateTime(request.createdAt),
        <Link key="open" className="font-bold text-fai-blue underline" href={`/settings/ai-authorizations/${request.id}`}>Apri</Link>,
      ])} />}
    </Card>
  </div>;
}
