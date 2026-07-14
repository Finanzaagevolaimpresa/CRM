export const dynamic = 'force-dynamic';

import { SecondaryLink } from '@/components/actions';
import { Card, EmptyState, PageHeader, StatusBadge, Table, TimestampMeta } from '@/components/ui';
import { requirePermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getProjectReadAccess } from '@/lib/read-access';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('project.read');
  const { id } = await params;
  const project = await getProjectReadAccess(session, id);
  if (!project) return <PageHeader title="Progetto non trovato" description="Il record richiesto non esiste o non è accessibile." />;
  const [expenses, client, consultant] = await Promise.all([
    prisma.projectExpense.findMany({ where: { projectId: id } }),
    prisma.client.findFirst({ where: { id: project.clientId, deletedAt: null } }),
    project.consultantId ? prisma.user.findUnique({ where: { id: project.consultantId } }) : null,
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
  </div>;
}
