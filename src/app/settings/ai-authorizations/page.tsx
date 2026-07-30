export const dynamic = 'force-dynamic';

import type { Prisma } from '@prisma/client';
import Link from 'next/link';
import { Badge, Card, EmptyState, PageHeader, StatusBadge, Table, formatDateTime } from '@/components/ui';
import {
  effectiveAiExecutionRequestStatus,
  expireAiExecutionRequestsOnRead,
} from '@/lib/ai-execution-authorization';
import { hasPermission, requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

const sections = [
  { title: 'In attesa', statuses: ['PENDING_ADMIN_APPROVAL'] },
  { title: 'Da integrare', statuses: ['NEEDS_INFORMATION'] },
  { title: 'Approvate non ancora utilizzate', statuses: ['APPROVED'] },
  { title: 'Rifiutate', statuses: ['REJECTED'] },
  { title: 'Revocate', statuses: ['REVOKED'] },
  { title: 'Scadute', statuses: ['EXPIRED'] },
  { title: 'Storico completo', statuses: null },
] as const;

export default async function AiAuthorizationsPage() {
  const session = await requireSession();
  const canRequest = hasPermission(session, 'ai.execution.request');
  const canAudit = session.role === 'admin' && hasPermission(session, 'ai.execution.audit');
  if (!canRequest && !canAudit) {
    return <EmptyState title="Accesso non autorizzato">Serve il permesso di richiesta o audit delle autorizzazioni AI.</EmptyState>;
  }

  const where: Prisma.AiExecutionRequestWhereInput = canAudit
    ? {}
    : { requesterUserId: session.userId };
  const requests = await prisma.aiExecutionRequest.findMany({
    where,
    include: {
      requester: { select: { name: true } },
      client: { select: { displayName: true } },
      project: { select: { title: true } },
      authorizationGrant: { select: { id: true } },
      _count: { select: { runs: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 250,
  });
  const now = new Date();
  await expireAiExecutionRequestsOnRead(
    requests
      .filter((request) => effectiveAiExecutionRequestStatus(request, now) === 'EXPIRED')
      .map((request) => request.id),
  );
  const rows = requests.map((request) => ({
    ...request,
    effectiveStatus: effectiveAiExecutionRequestStatus(request, now),
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Autorizzazioni AI"
        description="Richieste persistenti e decisioni Admin separate. L’approvazione non avvia l’AI: nessun consumer operativo è attivo."
      />
      <div className="rounded-2xl bg-fai-orange/10 p-4 text-sm font-bold leading-6 text-fai-orange ring-1 ring-fai-orange/20">
        Ogni utilizzo AI, incluso il mock e la diagnostica, richiede una nuova richiesta. I grant sono monouso, vincolati al fingerprint e non sono consumabili dall’interfaccia.
      </div>
      {sections.map((section) => {
        const sectionRows = section.statuses
          ? rows.filter((request) => (section.statuses as readonly string[]).includes(request.effectiveStatus))
          : rows;
        return (
          <Card
            key={section.title}
            title={section.title}
            action={<Badge tone={sectionRows.length > 0 ? 'blue' : 'gray'}>{sectionRows.length}</Badge>}
          >
            {sectionRows.length === 0 ? (
              <EmptyState title="Nessuna richiesta" />
            ) : (
              <Table
                headers={['Richiedente', 'Funzione', 'Contesto', 'Provider', 'Stato', 'Scadenza', 'Dettaglio']}
                rows={sectionRows.map((request) => [
                  request.requester?.name ?? request.requesterIdentity ?? 'Sistema',
                  request.functionCode.replaceAll('_', ' '),
                  request.client?.displayName ?? request.project?.title ?? 'Amministrativo',
                  `${request.provider}${request.model ? ` · ${request.model}` : ''}`,
                  <StatusBadge key="status" status={request.effectiveStatus} />,
                  formatDateTime(request.expiresAt),
                  <Link key="open" className="font-bold text-fai-blue underline" href={`/settings/ai-authorizations/${request.id}`}>
                    Apri
                  </Link>,
                ])}
              />
            )}
          </Card>
        );
      })}
    </div>
  );
}
