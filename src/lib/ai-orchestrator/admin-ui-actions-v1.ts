'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { hasPermission, requirePermission } from '../auth';
import { prisma } from '../prisma';
import { mutateAiOrchestratorAdminControlPolicy } from './admin-control-plane-v1';
import {
  buildAiOrchestratorAdminGlobalPolicyFromForm,
  buildAiOrchestratorAdminScopePolicyFromForm,
  parseAiOrchestratorAdminEmergencyStopForm,
  parseAiOrchestratorAdminGlobalPolicyForm,
  parseAiOrchestratorAdminScopePolicyForm,
  resolveAiOrchestratorAdminScopeSelection,
  type AiOrchestratorAdminUiResultCode,
} from './admin-ui-contract-v1';
import {
  getAiOrchestratorAdminControlTarget,
  type AiOrchestratorAdminControlTarget,
} from './admin-control-policy-v1';

const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function safeRequestId(formData: FormData) {
  const values = formData.getAll('requestId');
  return values.length === 1 && typeof values[0] === 'string' && uuidV4Pattern.test(values[0])
    ? values[0]
    : null;
}

function safeScopeTarget(formData: FormData) {
  const scopeTypes = formData.getAll('scopeType');
  const scopeCodes = formData.getAll('scopeCode');
  if (scopeTypes.length !== 1 || scopeCodes.length !== 1) return null;
  return resolveAiOrchestratorAdminScopeSelection({
    scopeType: scopeTypes[0],
    scopeCode: scopeCodes[0],
  });
}

async function auditUiBlocked(input: {
  actorUserId: string;
  code: AiOrchestratorAdminUiResultCode;
  requestId: string | null;
  target: AiOrchestratorAdminControlTarget | null;
}) {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: input.actorUserId,
        event: 'ai_orchestrator_admin_ui_request_blocked',
        entityType: 'AiOrchestratorAdminPolicyRevision',
        entityId: input.target ? `${input.target.scopeType}:${input.target.scopeCode}` : null,
        after: {
          code: input.code,
          requestId: input.requestId,
          source: 'ADMIN_UI_V1',
        },
      },
    });
  } catch {
    // The UI response remains minimized even if its secondary audit write fails.
  }
}

function resultLocation(
  code: AiOrchestratorAdminUiResultCode,
  target: AiOrchestratorAdminControlTarget | null = null,
) {
  const query = new URLSearchParams({ result: code });
  if (target && target.scopeType !== 'GLOBAL') {
    query.set('scopeType', target.scopeType);
    query.set('scopeCode', target.scopeCode);
  }
  return `/settings/ai-orchestrator?${query.toString()}`;
}

function mutationResultCode(
  result: Awaited<ReturnType<typeof mutateAiOrchestratorAdminControlPolicy>>,
): AiOrchestratorAdminUiResultCode {
  if (result.ok) return result.replayed ? 'REPLAYED' : 'UPDATED';
  return result.code;
}

export async function updateAiOrchestratorGlobalPolicyAction(formData: FormData) {
  const session = await requirePermission('ai.orchestrator.read');
  const requestId = safeRequestId(formData);
  const globalTarget = getAiOrchestratorAdminControlTarget('GLOBAL', 'global');

  if (!hasPermission(session, 'ai.orchestrator.configure')) {
    await auditUiBlocked({
      actorUserId: session.userId,
      code: 'ACTOR_NOT_AUTHORIZED',
      requestId,
      target: globalTarget,
    });
    redirect(resultLocation('ACTOR_NOT_AUTHORIZED'));
  }

  let form: ReturnType<typeof parseAiOrchestratorAdminGlobalPolicyForm>;
  let policy: ReturnType<typeof buildAiOrchestratorAdminGlobalPolicyFromForm>;
  try {
    form = parseAiOrchestratorAdminGlobalPolicyForm(formData);
    policy = buildAiOrchestratorAdminGlobalPolicyFromForm(form);
  } catch {
    await auditUiBlocked({
      actorUserId: session.userId,
      code: 'INVALID_INPUT',
      requestId,
      target: globalTarget,
    });
    redirect(resultLocation('INVALID_INPUT'));
  }

  let code: AiOrchestratorAdminUiResultCode;
  try {
    code = mutationResultCode(await mutateAiOrchestratorAdminControlPolicy(prisma, {
      actorUserId: session.userId,
      requestId: form.requestId,
      operationCode: 'SET_GLOBAL_POLICY',
      expectedVersion: form.expectedVersion,
      expectedRevisionHash: form.expectedRevisionHash,
      policy,
      reasonCode: form.reasonCode,
      reason: form.reason,
      confirmed: true,
    }));
  } catch {
    code = 'TECHNICAL_ERROR';
    await auditUiBlocked({
      actorUserId: session.userId,
      code,
      requestId,
      target: globalTarget,
    });
  }

  if (code === 'UPDATED' || code === 'REPLAYED') revalidatePath('/settings/ai-orchestrator');
  redirect(resultLocation(code));
}

export async function updateAiOrchestratorScopePolicyAction(formData: FormData) {
  const session = await requirePermission('ai.orchestrator.read');
  const requestId = safeRequestId(formData);
  const safeTarget = safeScopeTarget(formData);

  if (!hasPermission(session, 'ai.orchestrator.configure')) {
    await auditUiBlocked({
      actorUserId: session.userId,
      code: 'ACTOR_NOT_AUTHORIZED',
      requestId,
      target: safeTarget,
    });
    redirect(resultLocation('ACTOR_NOT_AUTHORIZED', safeTarget));
  }

  let form: ReturnType<typeof parseAiOrchestratorAdminScopePolicyForm>;
  let policy: ReturnType<typeof buildAiOrchestratorAdminScopePolicyFromForm>;
  let target: AiOrchestratorAdminControlTarget;
  try {
    form = parseAiOrchestratorAdminScopePolicyForm(formData);
    const resolvedTarget = resolveAiOrchestratorAdminScopeSelection(form);
    if (!resolvedTarget) throw new TypeError('AI_ORCHESTRATOR_ADMIN_SCOPE_TARGET_INVALID');
    target = resolvedTarget;
    policy = buildAiOrchestratorAdminScopePolicyFromForm(form);
  } catch {
    await auditUiBlocked({
      actorUserId: session.userId,
      code: 'INVALID_INPUT',
      requestId,
      target: safeTarget,
    });
    redirect(resultLocation('INVALID_INPUT', safeTarget));
  }

  let code: AiOrchestratorAdminUiResultCode;
  try {
    code = mutationResultCode(await mutateAiOrchestratorAdminControlPolicy(prisma, {
      actorUserId: session.userId,
      requestId: form.requestId,
      operationCode: 'SET_SCOPE_POLICY',
      expectedVersion: form.expectedVersion,
      expectedRevisionHash: form.expectedRevisionHash,
      policy,
      reasonCode: form.reasonCode,
      reason: form.reason,
      confirmed: true,
    }));
  } catch {
    code = 'TECHNICAL_ERROR';
    await auditUiBlocked({
      actorUserId: session.userId,
      code,
      requestId,
      target,
    });
  }

  if (code === 'UPDATED' || code === 'REPLAYED') revalidatePath('/settings/ai-orchestrator');
  redirect(resultLocation(code, target));
}

export async function engageAiOrchestratorEmergencyStopAction(formData: FormData) {
  const session = await requirePermission('ai.orchestrator.read');
  const requestId = safeRequestId(formData);

  if (!hasPermission(session, 'ai.orchestrator.kill')) {
    await auditUiBlocked({
      actorUserId: session.userId,
      code: 'ACTOR_NOT_AUTHORIZED',
      requestId,
      target: null,
    });
    redirect(resultLocation('ACTOR_NOT_AUTHORIZED'));
  }

  let form: ReturnType<typeof parseAiOrchestratorAdminEmergencyStopForm>;
  try {
    form = parseAiOrchestratorAdminEmergencyStopForm(formData);
  } catch {
    await auditUiBlocked({
      actorUserId: session.userId,
      code: 'INVALID_INPUT',
      requestId,
      target: null,
    });
    redirect(resultLocation('INVALID_INPUT'));
  }

  let code: AiOrchestratorAdminUiResultCode;
  try {
    code = mutationResultCode(await mutateAiOrchestratorAdminControlPolicy(prisma, {
      actorUserId: session.userId,
      requestId: form.requestId,
      operationCode: 'EMERGENCY_STOP',
      reasonCode: form.reasonCode,
      reason: form.reason,
      confirmed: true,
    }));
  } catch {
    code = 'TECHNICAL_ERROR';
    await auditUiBlocked({
      actorUserId: session.userId,
      code,
      requestId,
      target: null,
    });
  }

  if (code === 'UPDATED' || code === 'REPLAYED') revalidatePath('/settings/ai-orchestrator');
  redirect(resultLocation(code));
}
