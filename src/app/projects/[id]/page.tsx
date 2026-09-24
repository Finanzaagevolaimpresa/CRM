export const dynamic = 'force-dynamic';

import { SecondaryLink } from '@/components/actions';
import Link from 'next/link';
import { Card, EmptyState, PageHeader, StatusBadge, Table, TimestampMeta, formatDateTime } from '@/components/ui';
import { hasPermission, requirePermission } from '@/lib/auth';
import { effectiveAiExecutionRequestStatus } from '@/lib/ai-execution-authorization';
import { ManualAssignmentForm } from '@/components/manual-assignment-form';
import { prisma } from '@/lib/prisma';
import { getProjectReadAccess } from '@/lib/read-access';
import { canViewPreAnalysisListRecord } from '@/lib/business-list-access';
import { canEditProject } from '@/lib/access-control';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('project.read');
  const { id } = await params;
  const project = await getProjectReadAccess(session, id);
  if (!project) return <PageHeader title="Progetto non trovato" description="Il record richiesto non esiste o non è accessibile." />;
  const assignmentUsers = session.role === 'admin' ? await prisma.user.findMany({ where: { active: true, deletedAt: null }, select: { id: true, name: true, role: true }, orderBy: { name: 'asc' }, take: 250 }) : [];
  const canAuditAiRequests = session.role === 'admin' && hasPermission(session, 'ai.execution.audit');
  const canRequestAi = hasPermission(session, 'ai.execution.request');
  const canReadPreAnalyses = hasPermission(session, 'dossier.read');
  const [expenses, client, consultant, aiExecutionRequests, preAnalysisRows, companyRows] = await Promise.all([
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
    canReadPreAnalyses ? prisma.preAnalysis.findMany({ where: { projectId: id, clientId: project.clientId }, orderBy: { updatedAt: 'desc' } }) : Promise.resolve([]),
    canReadPreAnalyses ? prisma.company.findMany({ where: { clientId: project.clientId, deletedAt: null }, select: { id: true, clientId: true } }) : Promise.resolve([]),
  ]);
  const companyById = new Map(companyRows.map((company) => [company.id, company]));
  const preAnalyses = preAnalysisRows.filter((preAnalysis) => canViewPreAnalysisListRecord(session, {
    preAnalysis, client, project, company: preAnalysis.companyId ? companyById.get(preAnalysis.companyId) ?? null : null,
  }));

  return <div className="space-y-6">
    <PageHeader title={`Progetto — ${project.title}`} description="Scheda progetto nel perimetro cliente autorizzato, con importi, stato e voci di spesa." />
    <SecondaryLink href="/projects">← Torna alla lista</SecondaryLink>
    {session.role === 'admin' && <Card title="Responsabile del progetto"><ManualAssignmentForm kind="project" id={project.id} updatedAt={project.updatedAt.toISOString()} technicalOwnerId={project.consultantId} users={assignmentUsers} /></Card>}
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
    <Card title="Pre-analisi interne">
      {canReadPreAnalyses && hasPermission(session, 'project.write') && canEditProject(session, project) ? <Link className="mb-4 inline-block rounded-xl bg-fai-blue px-4 py-2 font-bold text-white" href={`/preanalyses/new?clientId=${project.clientId}&projectId=${project.id}`}>Crea pre-analisi</Link> : null}
      {!canReadPreAnalyses ? <EmptyState title="Pre-analisi non disponibili">Il tuo profilo non dispone del permesso di lettura pertinente.</EmptyState> : preAnalyses.length === 0 ? <EmptyState title="Nessuna pre-analisi">Non sono ancora presenti bozze per questo progetto.</EmptyState> : <Table headers={['Stato', 'Sintesi', 'Aggiornata', 'Azione']} rows={preAnalyses.map((pre) => [<StatusBadge key="status" status={pre.status} />, pre.internalSummary ?? 'Bozza interna senza sintesi', formatDateTime(pre.updatedAt), <Link key="open" className="font-bold text-fai-blue underline" href={`/preanalyses/${pre.id}`}>Apri</Link>])} />}
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
