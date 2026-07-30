export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PrimaryButton } from '@/components/actions';
import { Badge, Card, EmptyState, PageHeader, StatusBadge, Table, formatDateTime } from '@/components/ui';
import {
  approveAiExecutionRequestAndRefresh,
  cancelAiExecutionRequestAndRedirect,
  rejectAiExecutionRequestAndRefresh,
  requestAiExecutionInformationAndRefresh,
  revokeAiExecutionRequestAndRefresh,
} from '@/lib/ai-execution-authorization-actions';
import {
  canViewAiExecutionRequest,
  effectiveAiExecutionRequestStatus,
  expireAiExecutionRequestsOnRead,
  markAiExecutionNotificationRead,
} from '@/lib/ai-execution-authorization';
import { hasPermission, requireSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export default async function AiAuthorizationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await params;
  const loadRequest = () => prisma.aiExecutionRequest.findUnique({
    where: { id },
    include: {
      requester: { select: { name: true, email: true } },
      client: { select: { id: true, displayName: true } },
      company: { select: { id: true, name: true } },
      project: { select: { id: true, title: true } },
      clientService: { select: { id: true, operationalStatus: true } },
      agentConfig: { select: { name: true, code: true, promptVersion: true } },
      decisions: {
        include: { actor: { select: { name: true } } },
        orderBy: { sequence: 'asc' },
      },
      authorizationGrant: true,
      adminNotifications: {
        include: { recipientAdmin: { select: { name: true } } },
        orderBy: { createdAt: 'asc' },
      },
      runs: { select: { id: true, status: true, createdAt: true } },
    },
  });
  let request = await loadRequest();
  if (!request || !canViewAiExecutionRequest(session, request)) notFound();
  const expired = await expireAiExecutionRequestsOnRead(
    effectiveAiExecutionRequestStatus(request) === 'EXPIRED' ? [request.id] : [],
  );
  if (expired > 0) request = await loadRequest();
  if (!request || !canViewAiExecutionRequest(session, request)) notFound();
  await markAiExecutionNotificationRead(session, request.id);

  const status = effectiveAiExecutionRequestStatus(request);
  const isAdmin = session.role === 'admin';
  const isRequester = request.requesterUserId === session.userId;
  const canApprove = isAdmin
    && hasPermission(session, 'ai.execution.approve')
    && status === 'PENDING_ADMIN_APPROVAL';
  const canReject = isAdmin
    && hasPermission(session, 'ai.execution.reject')
    && status === 'PENDING_ADMIN_APPROVAL';
  const canRevoke = isAdmin
    && hasPermission(session, 'ai.execution.revoke')
    && status === 'APPROVED'
    && request.runs.length === 0;
  const canCancel = (isRequester || isAdmin)
    && ['PENDING_ADMIN_APPROVAL', 'NEEDS_INFORMATION'].includes(status);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dettaglio autorizzazione AI"
        description="Ledger persistente, binding del grant e decisione Admin separata dalla richiesta."
      />
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge status={status} />
        <Badge tone="purple">{request.origin}</Badge>
        <span className="font-mono text-xs text-slate-500">{request.id}</span>
      </div>

      <Card title="Richiesta">
        <dl className="grid gap-4 text-sm md:grid-cols-2 xl:grid-cols-3">
          <div><dt className="font-black text-slate-500">Richiedente</dt><dd>{request.requester?.name ?? request.requesterIdentity ?? 'Sistema'}</dd></div>
          <div><dt className="font-black text-slate-500">Funzione / finalità</dt><dd>{request.functionCode} · {request.purposeCode}</dd></div>
          <div><dt className="font-black text-slate-500">Agente</dt><dd>{request.agentConfig.name} · {request.agentConfig.promptVersion}</dd></div>
          <div><dt className="font-black text-slate-500">Provider / modello</dt><dd>{request.provider} · {request.model ?? 'non definito'}</dd></div>
          <div><dt className="font-black text-slate-500">Creata / scade</dt><dd>{formatDateTime(request.createdAt)} · {formatDateTime(request.expiresAt)}</dd></div>
          <div><dt className="font-black text-slate-500">Categorie dati</dt><dd>{Array.isArray(request.dataCategories) ? request.dataCategories.join(', ') : 'minimizzate'}</dd></div>
          <div className="md:col-span-2 xl:col-span-3"><dt className="font-black text-slate-500">Fingerprint input</dt><dd className="break-all font-mono text-xs">{request.inputFingerprint}</dd></div>
        </dl>
        <div className="mt-4 flex flex-wrap gap-3">
          {request.client ? <Link className="font-bold text-fai-blue underline" href={`/clients/${request.client.id}`}>Cliente: {request.client.displayName}</Link> : null}
          {request.project ? <Link className="font-bold text-fai-blue underline" href={`/projects/${request.project.id}`}>Progetto: {request.project.title}</Link> : null}
        </div>
      </Card>

      <Card title="Decisione separata">
        <p className="mb-4 rounded-2xl bg-fai-blue/5 p-4 text-sm font-bold leading-6 text-fai-blue">
          Anche l’Admin richiedente deve usare una seconda azione. Approvare crea soltanto un grant monouso: non avvia adapter, worker o provider.
        </p>
        <div className="flex flex-wrap gap-3">
          {canApprove ? <form action={approveAiExecutionRequestAndRefresh}><input type="hidden" name="id" value={request.id} /><PrimaryButton type="submit">Approva utilizzo AI</PrimaryButton></form> : null}
          {canReject ? <form action={requestAiExecutionInformationAndRefresh}><input type="hidden" name="id" value={request.id} /><PrimaryButton type="submit">Richiedi integrazione</PrimaryButton></form> : null}
          {canReject ? <form action={rejectAiExecutionRequestAndRefresh}><input type="hidden" name="id" value={request.id} /><PrimaryButton type="submit">Rifiuta</PrimaryButton></form> : null}
          {canRevoke ? <form action={revokeAiExecutionRequestAndRefresh}><input type="hidden" name="id" value={request.id} /><PrimaryButton type="submit">Revoca grant</PrimaryButton></form> : null}
          {canCancel ? <form action={cancelAiExecutionRequestAndRedirect}><input type="hidden" name="id" value={request.id} /><PrimaryButton type="submit">Annulla richiesta</PrimaryButton></form> : null}
          {!canApprove && !canReject && !canRevoke && !canCancel ? <EmptyState title="Nessuna azione disponibile" /> : null}
        </div>
      </Card>

      <Card title="Grant monouso">
        {request.authorizationGrant ? (
          <dl className="grid gap-4 text-sm md:grid-cols-2">
            <div><dt className="font-black text-slate-500">Grant</dt><dd className="break-all font-mono text-xs">{request.authorizationGrant.id}</dd></div>
            <div><dt className="font-black text-slate-500">Approvatore</dt><dd>{request.authorizationGrant.approvedById}</dd></div>
            <div><dt className="font-black text-slate-500">Scadenza / massimo tentativi</dt><dd>{formatDateTime(request.authorizationGrant.expiresAt)} · {request.authorizationGrant.maxAttempts}</dd></div>
            <div><dt className="font-black text-slate-500">Run collegati</dt><dd>{request.runs.length} / 1</dd></div>
          </dl>
        ) : <EmptyState title="Grant non emesso">Viene creato automaticamente soltanto dopo una decisione Admin valida.</EmptyState>}
      </Card>

      <Card title="Ledger append-only">
        <Table
          headers={['Seq.', 'Evento', 'Attore', 'Data', 'Hash']}
          rows={request.decisions.map((decision) => [
            decision.sequence,
            decision.decisionType,
            decision.actor?.name ?? 'Sistema',
            formatDateTime(decision.createdAt),
            <span key="hash" className="break-all font-mono text-[0.65rem]">{decision.decisionHash}</span>,
          ])}
        />
      </Card>

      {isAdmin ? (
        <Card title="Notifiche Admin persistenti">
          <Table
            headers={['Destinatario', 'Lettura', 'Decisione', 'Dedupe key']}
            rows={request.adminNotifications.map((notification) => [
              notification.recipientAdmin.name,
              notification.isRead ? formatDateTime(notification.readAt) : 'non letta',
              formatDateTime(notification.decidedAt),
              <span key="dedupe" className="font-mono text-xs">{notification.dedupeKey}</span>,
            ])}
          />
        </Card>
      ) : null}
    </div>
  );
}
