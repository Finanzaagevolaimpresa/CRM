export const dynamic = 'force-dynamic';

import { PrimaryButton } from '@/components/actions';
import { Card, EmptyState, PageHeader, StatusBadge, Table, formatDateTime } from '@/components/ui';
import { canApproveAiOutput, canReviewAiOutput } from '@/lib/access-control';
import { hasPermission, requirePermission } from '@/lib/auth';
import { approveAiOutputAndRefresh, reviewAiOutputAndRefresh } from '@/lib/form-actions';
import { listAccessibleAiOutputs } from '@/lib/read-access';

export default async function Page() {
  const session = await requirePermission('ai.review');
  const contexts = await listAccessibleAiOutputs(session, {
    where: { status: { in: ['needs_review', 'flagged'] } },
    orderBy: { createdAt: 'desc' },
  });
  const canApprove = hasPermission(session, 'ai.approve');

  return <div className="space-y-6">
    <PageHeader title="Output AI da revisionare" description="Coda protetta per fascicolo: generatore, revisore e approvazione sono controllati lato server. Gli output segnalati non sono approvabili." />
    <Card title="Coda revisione">
      {contexts.length === 0 ? <EmptyState title="Nessun output in attesa">Non risultano output accessibili da revisionare.</EmptyState> : <Table
        headers={['Titolo', 'Stato', 'Warning', 'Revisione', 'Creato il', 'Azione']}
        rows={contexts.map((context) => {
          const output = context.output;
          const policyContext = { ...output, run: context.run, client: context.client, project: context.project, clientService: context.clientService };
          const reviewAllowed = canReviewAiOutput(session, policyContext);
          const approvalAllowed = canApprove && canApproveAiOutput(session, policyContext);
          const action = output.status === 'flagged'
            ? <span className="text-xs font-bold text-red-600">Bloccato: rigenerare o archiviare</span>
            : !output.reviewedById
              ? reviewAllowed
                ? <form action={reviewAiOutputAndRefresh}><input type="hidden" name="id" value={output.id} /><PrimaryButton type="submit">Conferma revisione</PrimaryButton></form>
                : <span className="text-xs text-fai-gray">Serve un revisore diverso dal generatore</span>
              : approvalAllowed
                ? <form action={approveAiOutputAndRefresh}><input type="hidden" name="id" value={output.id} /><PrimaryButton type="submit">Approva</PrimaryButton></form>
                : <span className="text-xs text-fai-gray">Revisionato · permesso ai.approve richiesto</span>;
          return [
            output.title,
            <StatusBadge status={output.status} key="s" />,
            output.status === 'flagged' ? '⚠️ Frasi vietate o contenuto non conforme' : '—',
            output.reviewedAt ? `Revisionato il ${formatDateTime(output.reviewedAt)}` : 'Da revisionare',
            formatDateTime(output.createdAt),
            <div key="a">{action}</div>,
          ];
        })}
      />}
    </Card>
  </div>;
}
