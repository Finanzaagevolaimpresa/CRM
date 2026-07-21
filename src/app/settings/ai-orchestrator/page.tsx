export const dynamic = 'force-dynamic';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { AiOrchestratorAdminDashboard } from '@/components/ai-orchestrator-admin-dashboard';
import { Badge, Card, PageHeader } from '@/components/ui';
import { getEffectivePermissions, requirePermission } from '@/lib/auth';
import {
  getAiOrchestratorAdminControlSnapshot,
  listAiOrchestratorAdminPolicyRevisions,
} from '@/lib/ai-orchestrator/admin-control-plane-v1';
import {
  AiOrchestratorAdminGlobalPolicySchema,
  AiOrchestratorAdminScopePolicySchema,
} from '@/lib/ai-orchestrator/admin-control-policy-v1';
import {
  AI_ORCHESTRATOR_ADMIN_UI_RESULT_MESSAGES,
  getAiOrchestratorAdminUiPermissions,
  parseAiOrchestratorAdminHistoryMode,
  parseAiOrchestratorAdminUiResultCode,
  projectAiOrchestratorAdminAuditRevision,
  projectAiOrchestratorAdminReadRevision,
  resolveAiOrchestratorAdminScopeSelection,
} from '@/lib/ai-orchestrator/admin-ui-contract-v1';
import { prisma } from '@/lib/prisma';

type QueryValue = string | string[] | undefined;
type PageSearchParams = Promise<Record<string, QueryValue>>;

function scalar(value: QueryValue) {
  return typeof value === 'string' ? value : undefined;
}

function IntegrityFailure() {
  return (
    <div className="space-y-6">
      <PageHeader title="AI Orchestrator · Admin Control Center" description="Vista privata del Control Plane Foundation." />
      <Card title="Accesso fail-closed" action={<Badge tone="orange">modifiche bloccate</Badge>}>
        <p className="rounded-2xl bg-red-50 p-4 text-sm font-bold leading-6 text-red-800 ring-1 ring-red-200">La verifica di integrità del ledger o dei gate non è stata superata. Nessun modulo di modifica è disponibile e non viene eseguita alcuna query di fallback.</p>
      </Card>
    </div>
  );
}

export default async function Page({ searchParams }: { searchParams?: PageSearchParams }) {
  const session = await requirePermission('ai.orchestrator.read');
  const query = (await searchParams) ?? {};
  const snapshot = await getAiOrchestratorAdminControlSnapshot(prisma, { actorUserId: session.userId });

  if (!snapshot.ok) {
    if (snapshot.code === 'ACTOR_NOT_AUTHORIZED') redirect('/dashboard');
    return <IntegrityFailure />;
  }

  const globalProjection = projectAiOrchestratorAdminReadRevision(snapshot.desired.global);
  const global = Object.freeze({
    ...globalProjection,
    policy: AiOrchestratorAdminGlobalPolicySchema.parse(globalProjection.policy),
  });
  const scopes = Object.freeze(snapshot.desired.scopes.map((revision) => {
    const projection = projectAiOrchestratorAdminReadRevision(revision);
    return Object.freeze({
      ...projection,
      policy: AiOrchestratorAdminScopePolicySchema.parse(projection.policy),
    });
  }).sort((left, right) => (
    left.scopeType.localeCompare(right.scopeType) || left.scopeCode.localeCompare(right.scopeCode)
  )));

  const requestedTarget = resolveAiOrchestratorAdminScopeSelection({
    scopeType: scalar(query.scopeType),
    scopeCode: scalar(query.scopeCode),
  });
  const selectedScope = (
    requestedTarget
      ? scopes.find((scope) => scope.scopeType === requestedTarget.scopeType && scope.scopeCode === requestedTarget.scopeCode)
      : scopes.find((scope) => scope.scopeType === 'PROVIDER')
  ) ?? null;

  const permissions = getAiOrchestratorAdminUiPermissions(getEffectivePermissions(session));
  const historyMode = parseAiOrchestratorAdminHistoryMode(scalar(query.audit));
  let mutationIntegritySafe = true;
  let history: ReturnType<typeof projectAiOrchestratorAdminAuditRevision>[] | null = null;
  let historyNextHref: string | null = null;
  let historyMessage: string | null = null;

  if (permissions.canAudit) {
    const historyTarget = historyMode === 'global'
      ? { scopeType: 'GLOBAL' as const, scopeCode: 'global' }
      : historyMode === 'scope' && selectedScope
        ? { scopeType: selectedScope.scopeType, scopeCode: selectedScope.scopeCode }
        : null;
    const historyResult = await listAiOrchestratorAdminPolicyRevisions(prisma, {
      actorUserId: session.userId,
      scopeType: historyTarget?.scopeType,
      scopeCode: historyTarget?.scopeCode,
      cursor: scalar(query.cursor),
      limit: 50,
    });
    if (historyResult.ok) {
      history = historyResult.revisions.map(projectAiOrchestratorAdminAuditRevision);
      if (historyResult.nextCursor) {
        const nextQuery = new URLSearchParams({ cursor: historyResult.nextCursor });
        if (selectedScope) {
          nextQuery.set('scopeType', selectedScope.scopeType);
          nextQuery.set('scopeCode', selectedScope.scopeCode);
        }
        if (historyMode !== 'all') nextQuery.set('audit', historyMode);
        historyNextHref = `/settings/ai-orchestrator?${nextQuery.toString()}`;
      }
    } else {
      if (historyResult.code === 'LEDGER_INTEGRITY_ERROR') mutationIntegritySafe = false;
      historyMessage = historyResult.code === 'ACTOR_NOT_AUTHORIZED'
        ? 'Permesso audit non disponibile nella verifica database corrente.'
        : historyResult.code === 'LEDGER_INTEGRITY_ERROR'
          ? AI_ORCHESTRATOR_ADMIN_UI_RESULT_MESSAGES.LEDGER_INTEGRITY_ERROR
          : 'Filtro o cursore dello storico non valido. Tornare alla prima pagina.';
    }
  }

  return (
    <AiOrchestratorAdminDashboard
      global={global}
      scopes={scopes}
      selectedScope={selectedScope}
      effective={snapshot.effective}
      permissions={permissions}
      mutationIntegritySafe={mutationIntegritySafe}
      history={history}
      historyMode={historyMode}
      historyNextHref={historyNextHref}
      historyMessage={historyMessage}
      resultCode={parseAiOrchestratorAdminUiResultCode(scalar(query.result))}
      requestIds={{ global: randomUUID(), scope: randomUUID(), emergency: randomUUID() }}
    />
  );
}
