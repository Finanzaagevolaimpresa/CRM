'use server';
import { Prisma, type AiAgentConfigVersion, type AiOutput } from '@prisma/client';
import { prisma } from './prisma';
import { clientServicePipelineSchema, clientDossierGenerateSchema, clientDossierUpdateSchema, clientDossierIdSchema, aiAgentConfigUpdateSchema, aiControlSettingUpdateSchema, clientAiRunSchema, aiRequestKeySchema, aiOutputDossierSchema, commercialOfferUpdateSchema } from './validation';
import { hasPermission, requirePermission, type AuthSession, type Permission } from './auth';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { leadSchema, leadCommercialUpdateSchema, leadConvertSchema, commercialOfferSchema, clientSchema, projectSchema, documentUploadSchema, preAnalysisSchema, aiOutputApprovalSchema, companySchema, projectExpenseSchema, dossierSchema, contractSchema, paymentSchema, clientServiceSchema, serviceStatusSchema, documentServiceLinkSchema, documentChecklistItemSchema, checklistItemStatusUpdateSchema, checklistItemDocumentLinkSchema, checklistItemIdSchema, clientTaskSchema, taskUpdateSchema, taskIdSchema, technicalPracticeSchema, technicalPracticeUpdateSchema, technicalPracticeStatusUpdateSchema, technicalPracticeAssignSchema, technicalPracticeIdSchema, practiceCommunicationDraftSchema, practiceCommunicationUpdateSchema, practiceCommunicationIdSchema } from './validation';
import {
  AiProviderCallError,
  aiProviderErrorMetadata,
  createExternalAiPayload,
  externalAiDataCategories,
  prepareAiOutput,
  MockAiAdapter,
  OpenAiAdapter,
  createOpenAiDiagnosticRequestBody,
  createOpenAiResponseRequestBody,
  getAiProviderDiagnostics,
  minimizeProviderRequestId,
  testAiProviderDiagnostic,
  type ExternalAiPayload,
} from './ai';
import { buildClientServiceLabel } from './client-service-label';
import { sanitizeFileName, savePrivateDocumentFile } from './storage';
import { canApproveAiOutput, canReviewAiOutput, canViewChecklistItem, canViewClient, canViewDocument, isSensitiveDocument, hasGlobalAccess } from './access-control';
import { UserFacingActionError } from './action-errors';
import { AI_AGENT_CODES } from './ai-agent-configs';
import { isPrimaryOperationalAiAgent } from './ai-agent-catalog';
import {
  AI_CONTROL_SETTING_ID,
  assertExternalAiRunAllowed,
  issueExternalAiPermit,
  isExternalModelAllowed,
  prepareExternalAiPermit,
  type ExternalAiPermit,
} from './ai-control-plane';
import {
  AI_RUN_RELIABILITY_VERSION,
  canonicalSha256,
  completeAiRunWithLease,
  createAiRequestFingerprint,
  createAiRunLeaseWithDbClock,
  failAiRunWithLease,
  reconcileExpiredAiRuns,
  resolveIdempotentAiRunState,
  type AiRunLease,
} from './ai-run-reliability';
import { scanForbiddenPhrases } from './compliance';
import {
  getClientDossierReadAccess,
  listAccessibleTasks,
  requireAiOutputReadAccess,
  requireClientContextReadAccess,
} from './read-access';
import {
  denyWriteAccess,
  requireActiveUser,
  requireChecklistEditAccess,
  requireClientContextWriteAccess,
  requireCommercialOfferEditAccess,
  requireCommercialOfferTargetAccess,
  requireDocumentEditAccess,
  requireLeadEditAccess,
  requireProjectEditAccess,
  requireServiceAssignAccess,
  requireServiceEditAccess,
  requireTaskEditAccess,
  requireTechnicalPracticeEditAccess,
  requireTechnicalPracticeViewAccess,
} from './write-access';

function clean(form: FormData) { return Object.fromEntries([...form.entries()].filter(([, v]) => v !== '')); }
async function audit(actorId: string, event: string, entityType: string, entityId?: string, after?: unknown) { await prisma.auditLog.create({ data: { actorId, event, entityType, entityId, after: after as Prisma.InputJsonValue } }); }

class ConcurrentLeadConversionError extends Error {}
type ReliableAiRunRecord = {
  id: string;
  reliabilityVersion: number | null;
  status: string;
  requestFingerprint: string | null;
};
const reliableAiRunSelect = {
  id: true,
  reliabilityVersion: true,
  status: true,
  requestFingerprint: true,
} satisfies Prisma.AiRunSelect;
class ExistingAiRunReservationError extends Error {
  constructor(readonly run: ReliableAiRunRecord) {
    super('AI run request already reserved');
  }
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function isSerializableConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
}

async function withSerializableAiTransaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await prisma.$transaction(operation, { isolationLevel: 'Serializable' });
    } catch (error) {
      if (!isSerializableConflict(error)) throw error;
      if (attempt === 3) {
        throw new UserFacingActionError('Conflitto temporaneo nel controllo AI. Riprova tra qualche istante.');
      }
    }
  }
  throw new UserFacingActionError('Controllo AI non completato. Riprova.');
}

function nextConcurrencyTimestamp(previous: Date) {
  return new Date(Math.max(Date.now(), previous.getTime() + 1));
}

function dossierAuditSnapshot(dossier: {
  id: string;
  clientId: string;
  clientServiceId?: string | null;
  projectId?: string | null;
  sourceAiOutputId?: string | null;
  title: string;
  type: unknown;
  status: unknown;
  content: string;
  reviewedById?: string | null;
  reviewedAt?: Date | null;
  updatedAt: Date;
}) {
  return {
    id: dossier.id,
    clientId: dossier.clientId,
    clientServiceId: dossier.clientServiceId ?? null,
    projectId: dossier.projectId ?? null,
    sourceAiOutputId: dossier.sourceAiOutputId ?? null,
    titleLength: dossier.title.length,
    type: String(dossier.type),
    status: String(dossier.status),
    contentLength: dossier.content.length,
    reviewedById: dossier.reviewedById ?? null,
    reviewedAt: dossier.reviewedAt ?? null,
    updatedAt: dossier.updatedAt,
  };
}

function minimizeAiInstructions(value?: string) {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email rimossa]')
    .replace(/\b[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]\b/gi, '[codice fiscale rimosso]')
    .replace(/\bIT\d{2}[A-Z]\d{10}[0-9A-Z]{12}\b/gi, '[IBAN rimosso]')
    .slice(0, 2000);
}

function resolveAiAgentRuntime(providerValue: string, configuredModel?: string | null) {
  const provider = providerValue.trim().toLowerCase();
  if (provider === 'mock') {
    return { provider, model: 'mock-template-v1', adapter: new MockAiAdapter() };
  }
  if (provider === 'openai') {
    const model = configuredModel?.trim();
    if (!model) throw new UserFacingActionError('Un agente OpenAI richiede un modello esplicito autorizzato.');
    return { provider, model, adapter: new OpenAiAdapter(model) };
  }
  throw new UserFacingActionError(`Provider AI non supportato per questo agente: ${providerValue}.`);
}

function aiRunOutputSummary(draft: { title: string; content: string; metadata?: Record<string, unknown> }) {
  const metadata = draft.metadata && typeof draft.metadata === 'object'
    ? {
        provider: typeof draft.metadata.provider === 'string' ? draft.metadata.provider : undefined,
        model: typeof draft.metadata.model === 'string' ? draft.metadata.model : undefined,
      }
    : undefined;
  return JSON.parse(JSON.stringify({
    titleLength: draft.title.length,
    contentLength: draft.content.length,
    metadata,
  })) as Prisma.InputJsonValue;
}

function safeAiTokenCount(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function aiProviderPersistenceMetadata(draft: { metadata?: Record<string, unknown> }) {
  const metadata = draft.metadata && typeof draft.metadata === 'object' ? draft.metadata : {};
  return {
    inputTokens: safeAiTokenCount(metadata.inputTokens),
    outputTokens: safeAiTokenCount(metadata.outputTokens),
    totalTokens: safeAiTokenCount(metadata.totalTokens),
    providerRequestId: typeof metadata.providerRequestId === 'string'
      ? minimizeProviderRequestId(metadata.providerRequestId)
      : undefined,
  };
}

function aiProviderFailureMetadata(error: unknown) {
  const metadata = aiProviderErrorMetadata(error);
  return {
    inputTokens: safeAiTokenCount(metadata.inputTokens),
    outputTokens: safeAiTokenCount(metadata.outputTokens),
    totalTokens: safeAiTokenCount(metadata.totalTokens),
    providerRequestId: minimizeProviderRequestId(metadata.providerRequestId),
  };
}

function aiAgentConfigFingerprint(snapshot: AiAgentConfigVersion) {
  return {
    agentId: snapshot.agentId,
    version: snapshot.version,
    code: snapshot.code,
    name: snapshot.name,
    description: snapshot.description,
    operationalScope: snapshot.operationalScope,
    systemPrompt: snapshot.systemPrompt,
    requiredDataChecklist: snapshot.requiredDataChecklist,
    expectedOutput: snapshot.expectedOutput,
    toneStyle: snapshot.toneStyle,
    active: snapshot.active,
    provider: snapshot.provider,
    model: snapshot.model,
    promptVersion: snapshot.promptVersion,
    inputSchema: snapshot.inputSchema,
    outputSchema: snapshot.outputSchema,
  };
}

function aiAgentSnapshotRuntime(snapshot: AiAgentConfigVersion) {
  return { code: snapshot.code, role: snapshot.name, systemPrompt: snapshot.systemPrompt };
}

async function currentAiAgentWithSnapshot(agentId: string) {
  const agent = await prisma.aiAgent.findUniqueOrThrow({ where: { id: agentId } });
  const snapshot = await prisma.aiAgentConfigVersion.findUnique({
    where: { agentId_version: { agentId: agent.id, version: agent.configVersion } },
  });
  if (!snapshot) {
    throw new UserFacingActionError('Snapshot immutabile della configurazione agente non disponibile. Esecuzione bloccata.');
  }
  return { agent, snapshot };
}

async function existingAiRunForRequest(userId: string, requestKey: string) {
  return prisma.aiRun.findUnique({
    where: { createdById_requestKey: { createdById: userId, requestKey } },
    select: reliableAiRunSelect,
  });
}

function assertReliableDuplicate(run: ReliableAiRunRecord, requestFingerprint: string) {
  if (run.reliabilityVersion !== AI_RUN_RELIABILITY_VERSION) {
    throw new UserFacingActionError('Chiave richiesta AI già utilizzata da un run non compatibile. Ricarica la pagina.');
  }
  return resolveIdempotentAiRunState(run, requestFingerprint);
}

async function resolveExistingAiOutput(
  session: AuthSession,
  run: ReliableAiRunRecord,
  requestFingerprint: string,
  permission: Permission,
): Promise<AiOutput> {
  assertReliableDuplicate(run, requestFingerprint);
  const currentSession = await requirePermission(permission);
  if (currentSession.userId !== session.userId) {
    throw new UserFacingActionError('Sessione AI modificata. Ricarica la pagina.');
  }
  const outputs = await prisma.aiOutput.findMany({
    where: { aiRunId: run.id },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: 2,
  });
  if (outputs.length !== 1) {
    throw new UserFacingActionError('Output del run AI completato non coerente. Contatta un amministratore.');
  }
  const access = await requireAiOutputReadAccess(currentSession, outputs[0].id);
  return access.output;
}

function externalNumericValue(value: unknown): string | number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value;
  const serialized = String(value);
  return serialized && serialized !== '[object Object]' ? serialized : null;
}

async function markAiRunFailedBestEffort(options: {
  runId: string;
  lease: AiRunLease;
  actorId: string;
  event: string;
  errorCode: string;
  trace: Record<string, unknown>;
  telemetry?: ReturnType<typeof aiProviderPersistenceMetadata>;
}) {
  const telemetry: ReturnType<typeof aiProviderPersistenceMetadata> = options.telemetry ?? {
    inputTokens: undefined,
    outputTokens: undefined,
    totalTokens: undefined,
    providerRequestId: undefined,
  };
  try {
    return await prisma.$transaction(async (tx) => {
      await failAiRunWithLease(tx, options.lease, {
        failureCode: options.errorCode,
        telemetry,
      });
      await tx.auditLog.create({ data: {
        actorId: options.actorId,
        event: options.event,
        entityType: 'AiRun',
        entityId: options.runId,
        after: JSON.parse(JSON.stringify({
          ...options.trace,
          status: 'failed',
          errorCode: options.errorCode,
          ...telemetry,
        })) as Prisma.InputJsonValue,
      } });
      return true;
    });
  } catch {
    return false;
  }
}

export async function runAiProviderDiagnosticTest(form: FormData) {
  const s = await requirePermission('ai_agents.read');
  await reconcileExpiredAiRuns({ actorId: s.userId });
  const diagnostics = getAiProviderDiagnostics();
  const requestKey = aiRequestKeySchema.parse(String(form.get('requestKey') ?? ''));
  const externalDiagnostic = diagnostics.provider === 'openai';
  const externalDiagnosticConfirmed = form.get('externalDiagnosticConfirmed') === 'on';
  const runtimeModel = externalDiagnostic ? diagnostics.model : 'mock-template-v1';
  const requestedAgent = await prisma.aiAgent.findFirst({
    where: {
      active: true,
      provider: diagnostics.provider,
      ...(externalDiagnostic ? { futureModel: diagnostics.model } : {}),
    },
    orderBy: { id: 'asc' },
  });
  if (!requestedAgent) {
    throw new UserFacingActionError(`Per il test ${diagnostics.provider} serve un agente attivo configurato con lo stesso provider.`);
  }
  const requestedSnapshot = await prisma.aiAgentConfigVersion.findUnique({
    where: { agentId_version: { agentId: requestedAgent.id, version: requestedAgent.configVersion } },
  });
  if (!requestedSnapshot) {
    throw new UserFacingActionError('Snapshot immutabile dell’agente diagnostico non disponibile. Test bloccato.');
  }
  if (
    !requestedSnapshot.active
    || requestedSnapshot.provider !== diagnostics.provider
    || (externalDiagnostic && requestedSnapshot.model !== runtimeModel)
  ) {
    throw new UserFacingActionError('Snapshot dell’agente diagnostico non coerente con provider e modello correnti. Test bloccato.');
  }

  const exactDiagnosticBody = externalDiagnostic
    ? createOpenAiDiagnosticRequestBody(runtimeModel)
    : {
        source: 'CRM interno FAI',
        humanReviewRequired: true,
        prompt: 'Test diagnostico interno minimale.',
        context: {},
      };
  const externalPayloadHash = externalDiagnostic ? canonicalSha256(exactDiagnosticBody) : null;
  const requestFingerprint = createAiRequestFingerprint({
    kind: 'ai_provider_diagnostic_v1',
    requestKey,
    provider: diagnostics.provider,
    model: runtimeModel,
    agentConfig: aiAgentConfigFingerprint(requestedSnapshot),
    body: exactDiagnosticBody,
    externalDiagnosticConfirmed,
  });
  const existing = await existingAiRunForRequest(s.userId, requestKey);
  if (existing) {
    assertReliableDuplicate(existing, requestFingerprint);
    const params = new URLSearchParams({ status: 'ok', message: 'Test provider già completato per questa richiesta.' });
    redirect(`/settings/ai-diagnostics?${params.toString()}`);
  }

  if (externalDiagnostic && (!hasPermission(s, 'ai.run') || !hasPermission(s, 'ai.external.run'))) {
    throw new UserFacingActionError('La diagnostica OpenAI richiede i permessi ai.run e ai.external.run.');
  }
  if (externalDiagnostic && !externalDiagnosticConfirmed) {
    throw new UserFacingActionError('Conferma esplicitamente il test OpenAI e il possibile costo della singola chiamata.');
  }
  let reservation;
  try {
    reservation = await withSerializableAiTransaction(async (tx) => {
      const duplicate = await tx.aiRun.findUnique({
        where: { createdById_requestKey: { createdById: s.userId, requestKey: requestKey } },
        select: reliableAiRunSelect,
      });
      if (duplicate) throw new ExistingAiRunReservationError(duplicate);
      const lease = await createAiRunLeaseWithDbClock(tx);
      const confirmedAt = lease.leaseStartedAt;

      const currentAgent = await tx.aiAgent.findUniqueOrThrow({ where: { id: requestedAgent.id } });
      const currentSnapshot = await tx.aiAgentConfigVersion.findUnique({
        where: { agentId_version: { agentId: currentAgent.id, version: currentAgent.configVersion } },
      });
      if (
        !currentAgent.active
        || currentAgent.configVersion !== requestedSnapshot.version
        || currentAgent.provider !== diagnostics.provider
        || (externalDiagnostic && currentAgent.futureModel !== runtimeModel)
        || !currentSnapshot
        || !currentSnapshot.active
        || currentSnapshot.provider !== diagnostics.provider
        || (externalDiagnostic && currentSnapshot.model !== runtimeModel)
        || canonicalSha256(aiAgentConfigFingerprint(currentSnapshot)) !== canonicalSha256(aiAgentConfigFingerprint(requestedSnapshot))
      ) {
        throw new UserFacingActionError('Configurazione diagnostica modificata prima della prenotazione. Ricarica la pagina.');
      }

      let authorizedCategories = [] as readonly string[];
      let permitMaterial: ReturnType<typeof prepareExternalAiPermit> | undefined;
      if (externalDiagnostic) {
        const authorization = await assertExternalAiRunAllowed({
          userId: s.userId,
          permissionGranted: hasPermission(s, 'ai.external.run'),
          model: runtimeModel,
          dataCategories: ['agent_configuration'],
          confirmedAt,
          db: tx,
        });
        authorizedCategories = authorization.dataCategories;
        permitMaterial = prepareExternalAiPermit();
      }
      const run = await tx.aiRun.create({ data: {
        id: lease.runId,
        reliabilityVersion: AI_RUN_RELIABILITY_VERSION,
        agentId: currentAgent.id,
        agentConfigVersion: currentSnapshot.version,
        status: 'running',
        provider: diagnostics.provider,
        model: runtimeModel,
        promptVersion: currentSnapshot.promptVersion,
        requestKey,
        requestFingerprint,
        leaseExpiresAt: lease.leaseExpiresAt,
        leaseTokenHash: lease.leaseTokenHash,
        egressPermitHash: permitMaterial?.egressPermitHash ?? null,
        externalPayloadHash,
        externalConfirmedAt: externalDiagnostic ? confirmedAt : null,
        externalDataCategories: externalDiagnostic ? [...authorizedCategories] : Prisma.DbNull,
        input: externalDiagnostic ? Prisma.DbNull : exactDiagnosticBody as Prisma.InputJsonValue,
        createdById: s.userId,
        createdAt: lease.leaseStartedAt,
      } });
      await tx.auditLog.create({ data: {
        actorId: s.userId,
        event: 'ai_provider_diagnostic_reserved',
        entityType: 'AiRun',
        entityId: run.id,
        after: {
          aiRunId: run.id,
          agentId: currentAgent.id,
          configVersion: currentSnapshot.version,
          provider: diagnostics.provider,
          model: runtimeModel,
          externalConfirmedAt: externalDiagnostic ? confirmedAt : null,
          dataCategories: authorizedCategories,
          reliabilityVersion: AI_RUN_RELIABILITY_VERSION,
          status: 'running',
        },
      } });
      const permit = permitMaterial && externalPayloadHash
        ? await issueExternalAiPermit({
            seed: permitMaterial.seed,
            lease: lease.lease,
            runId: run.id,
            userId: s.userId,
            requestKey,
            requestFingerprint,
            agentId: currentAgent.id,
            agentConfigVersion: currentSnapshot.version,
            model: runtimeModel,
            dataCategories: authorizedCategories,
            externalPayloadHash,
            db: tx,
          })
        : undefined;
      return { run, lease: lease.lease, permit, authorizedCategories };
    });
  } catch (error) {
    const duplicate = error instanceof ExistingAiRunReservationError
      ? error.run
      : isUniqueConstraintError(error) ? await existingAiRunForRequest(s.userId, requestKey) : null;
    if (duplicate) {
      assertReliableDuplicate(duplicate, requestFingerprint);
      const params = new URLSearchParams({ status: 'ok', message: 'Test provider già completato per questa richiesta.' });
      redirect(`/settings/ai-diagnostics?${params.toString()}`);
    }
    throw error;
  }

  try {
    const executionSession = await requirePermission('ai_agents.read');
    if (
      executionSession.userId !== s.userId
      || (externalDiagnostic && (
        !hasPermission(executionSession, 'ai.run')
        || !hasPermission(executionSession, 'ai.external.run')
      ))
    ) {
      throw new UserFacingActionError('Autorizzazioni diagnostica AI revocate prima dell’esecuzione.');
    }
  } catch (error) {
    await markAiRunFailedBestEffort({
      runId: reservation.run.id,
      lease: reservation.lease,
      actorId: s.userId,
      event: 'ai_provider_diagnostic_access_revoked',
      errorCode: 'AI_RUNTIME_PERMISSION_REVOKED',
      trace: { aiRunId: reservation.run.id, provider: diagnostics.provider, model: runtimeModel },
    });
    throw error;
  }

  let result;
  try {
    result = await testAiProviderDiagnostic(reservation.permit);
  } catch (error) {
    await markAiRunFailedBestEffort({
      runId: reservation.run.id,
      lease: reservation.lease,
      actorId: s.userId,
      event: 'ai_provider_diagnostic_failed',
      errorCode: 'AI_DIAGNOSTIC_PROVIDER_FAILURE',
      trace: { aiRunId: reservation.run.id, provider: diagnostics.provider, model: runtimeModel },
      telemetry: aiProviderFailureMetadata(error),
    });
    if (error instanceof UserFacingActionError) throw error;
    throw new UserFacingActionError('Errore controllato durante il test OpenAI. Nessun output AI salvato.');
  }
  const usage = result.usage ?? {};
  const diagnosticTelemetry = {
    inputTokens: safeAiTokenCount(usage.inputTokens),
    outputTokens: safeAiTokenCount(usage.outputTokens),
    totalTokens: safeAiTokenCount(usage.totalTokens),
    providerRequestId: minimizeProviderRequestId(usage.providerRequestId),
  };
  try {
    await prisma.$transaction(async (tx) => {
      if (result.success) {
        await completeAiRunWithLease(tx, reservation.lease, { telemetry: diagnosticTelemetry });
      } else {
        await failAiRunWithLease(tx, reservation.lease, {
          failureCode: 'AI_DIAGNOSTIC_FAILED',
          telemetry: diagnosticTelemetry,
        });
      }
      await tx.auditLog.create({ data: {
        actorId: s.userId,
        event: 'ai_provider_diagnostic_test',
        entityType: 'AiRun',
        entityId: reservation.run.id,
        after: {
          aiRunId: reservation.run.id,
          provider: result.provider,
          model: runtimeModel,
          success: result.success,
          status: result.success ? 'completed' : 'failed',
          failureCode: result.success ? null : 'AI_DIAGNOSTIC_FAILED',
          ...diagnosticTelemetry,
        },
      } });
    });
  } catch {
    await markAiRunFailedBestEffort({
      runId: reservation.run.id,
      lease: reservation.lease,
      actorId: s.userId,
      event: 'ai_provider_diagnostic_persistence_failed',
      errorCode: 'AI_DIAGNOSTIC_PERSISTENCE_FAILURE',
      trace: { aiRunId: reservation.run.id, provider: result.provider, model: runtimeModel },
      telemetry: diagnosticTelemetry,
    });
    throw new UserFacingActionError('Risposta diagnostica ricevuta ma salvataggio stato non completato. Riprova.');
  }
  const params = new URLSearchParams({ status: result.success ? 'ok' : 'error', message: result.message });
  redirect(`/settings/ai-diagnostics?${params.toString()}`);
}

export async function updateAiAgentConfig(form: FormData) {
  const s = await requirePermission('ai_agents.write');
  const raw = clean(form);
  const data = aiAgentConfigUpdateSchema.parse({ ...raw, active: form.has('active') });
  if (data.provider === 'openai' && !isExternalModelAllowed(data.futureModel)) {
    throw new UserFacingActionError('Il modello OpenAI selezionato non è presente nella allowlist server.');
  }
  const agent = await withSerializableAiTransaction(async (tx) => {
    const before = await tx.aiAgent.findUniqueOrThrow({ where: { id: data.id } });
    if (before.configVersion !== data.expectedConfigVersion) {
      throw new UserFacingActionError('Configurazione agente modificata da un altro operatore. Ricarica la pagina.');
    }
    if (data.provider === 'openai' && !isExternalModelAllowed(data.futureModel)) {
      throw new UserFacingActionError('Il modello OpenAI selezionato non è presente nella allowlist server.');
    }
    const nextConfigVersion = before.configVersion + 1;
    const promptVersion = `v${nextConfigVersion}`;
    const updatedAt = nextConcurrencyTimestamp(before.updatedAt);
    const updated = await tx.aiAgent.updateMany({
      where: { id: data.id, configVersion: data.expectedConfigVersion, updatedAt: before.updatedAt },
      data: {
        systemPrompt: data.systemPrompt,
        active: data.active,
        provider: data.provider,
        futureModel: data.provider === 'openai' ? data.futureModel : null,
        configVersion: nextConfigVersion,
        promptVersion,
        updatedAt,
      },
    });
    if (updated.count !== 1) {
      throw new UserFacingActionError('Configurazione agente modificata da un altro operatore. Ricarica la pagina.');
    }
    const next = await tx.aiAgent.findUniqueOrThrow({ where: { id: data.id } });
    await tx.aiAgentConfigVersion.create({ data: {
      agentId: next.id,
      version: next.configVersion,
      code: next.code,
      name: next.name,
      description: next.description,
      operationalScope: next.operationalScope,
      systemPrompt: next.systemPrompt,
      requiredDataChecklist: next.requiredDataChecklist as Prisma.InputJsonValue,
      expectedOutput: next.expectedOutput,
      toneStyle: next.toneStyle,
      active: next.active,
      provider: next.provider,
      model: next.futureModel,
      promptVersion: next.promptVersion,
      inputSchema: next.inputSchema as Prisma.InputJsonValue,
      outputSchema: next.outputSchema as Prisma.InputJsonValue,
      createdById: s.userId,
    } });
    const promptChanged = before.systemPrompt !== next.systemPrompt;
    const activeChanged = before.active !== next.active;
    const providerChanged = before.provider !== next.provider || before.futureModel !== next.futureModel;
    const events = ['ai_agent_config_update'];
    if (promptChanged) events.push('ai_agent_prompt_update');
    if (activeChanged) events.push(next.active ? 'ai_agent_activate' : 'ai_agent_deactivate');
    if (providerChanged) events.push('ai_agent_provider_update');
    const summary = {
      code: next.code,
      previousConfigVersion: before.configVersion,
      nextConfigVersion: next.configVersion,
      previousPromptVersion: before.promptVersion,
      nextPromptVersion: next.promptVersion,
      promptChanged,
      previousPromptLength: before.systemPrompt.length,
      nextPromptLength: next.systemPrompt.length,
      previousActive: before.active,
      nextActive: next.active,
      previousProvider: before.provider,
      nextProvider: next.provider,
      previousModel: before.futureModel,
      nextModel: next.futureModel,
    };
    await tx.auditLog.createMany({ data: events.map((event) => ({
      actorId: s.userId,
      event,
      entityType: 'AiAgent',
      entityId: next.id,
      after: summary,
    })) });
    return next;
  });
  revalidatePath('/settings/ai-agents');
  void agent;
}

export async function updateAiControlSetting(form: FormData) {
  const s = await requirePermission('settings.manage');
  const raw = clean(form);
  const data = aiControlSettingUpdateSchema.parse({
    ...raw,
    externalProvidersEnabled: form.has('externalProvidersEnabled'),
  });
  const setting = await withSerializableAiTransaction(async (tx) => {
    const before = await tx.aiControlSetting.findUnique({ where: { id: AI_CONTROL_SETTING_ID } });
    if (before) {
      if (!data.expectedUpdatedAt || before.updatedAt.getTime() !== data.expectedUpdatedAt.getTime()) {
        throw new UserFacingActionError('Impostazioni AI modificate da un altro operatore. Ricarica la pagina.');
      }
      const updatedAt = nextConcurrencyTimestamp(before.updatedAt);
      const updated = await tx.aiControlSetting.updateMany({
        where: { id: AI_CONTROL_SETTING_ID, updatedAt: before.updatedAt },
        data: {
          externalProvidersEnabled: data.externalProvidersEnabled,
          maxExternalRunsPerUserPerHour: data.maxExternalRunsPerUserPerHour,
          updatedById: s.userId,
          updatedAt,
        },
      });
      if (updated.count !== 1) {
        throw new UserFacingActionError('Impostazioni AI modificate da un altro operatore. Ricarica la pagina.');
      }
    } else {
      if (data.expectedUpdatedAt) {
        throw new UserFacingActionError('Impostazioni AI non coerenti. Ricarica la pagina.');
      }
      await tx.aiControlSetting.create({ data: {
        id: AI_CONTROL_SETTING_ID,
        externalProvidersEnabled: data.externalProvidersEnabled,
        maxExternalRunsPerUserPerHour: data.maxExternalRunsPerUserPerHour,
        updatedById: s.userId,
      } });
    }
    const next = await tx.aiControlSetting.findUniqueOrThrow({ where: { id: AI_CONTROL_SETTING_ID } });
    await tx.auditLog.create({ data: {
      actorId: s.userId,
      event: 'ai_control_setting_update',
      entityType: 'AiControlSetting',
      entityId: AI_CONTROL_SETTING_ID,
      after: {
        previousExternalProvidersEnabled: before?.externalProvidersEnabled ?? false,
        nextExternalProvidersEnabled: next.externalProvidersEnabled,
        previousMaxExternalRunsPerUserPerHour: before?.maxExternalRunsPerUserPerHour ?? null,
        nextMaxExternalRunsPerUserPerHour: next.maxExternalRunsPerUserPerHour,
        updatedById: s.userId,
      },
    } });
    return next;
  });
  revalidatePath('/settings/ai-agents');
  revalidatePath('/settings/ai-diagnostics');
  void setting;
}

export async function createLead(form: FormData) {
  const s = await requirePermission('lead.write');
  const data = leadSchema.parse(clean(form));
  if (data.clientId) denyWriteAccess();
  await requireActiveUser(data.assignedToId);
  if (!hasGlobalAccess(s) && data.assignedToId && data.assignedToId !== s.userId) denyWriteAccess();
  const lead = await prisma.lead.create({ data: { ...data, clientId: null, nextAction: data.nextActionDate } });
  await audit(s.userId, 'lead_create', 'Lead', lead.id, lead);
  return lead;
}

export async function updateLeadCommercial(form: FormData) {
  const s = await requirePermission('lead.write');
  const data = leadCommercialUpdateSchema.parse(clean(form));
  const before = await requireLeadEditAccess(s, data.id);
  const nextAssignedToId = data.assignedToId ?? null;
  await requireActiveUser(nextAssignedToId);
  if (before.assignedToId !== nextAssignedToId && !hasGlobalAccess(s) && nextAssignedToId && nextAssignedToId !== s.userId) denyWriteAccess();
  const lead = await prisma.lead.update({ where: { id: data.id }, data: { status: data.status, priority: data.priority, assignedToId: nextAssignedToId, nextActionNote: data.nextActionNote, nextActionDate: data.nextActionDate ?? null, nextAction: data.nextActionDate ?? null, notes: data.notes, commercialProposal: data.commercialProposal } });
  const events = ['lead_update'];
  if (before.status !== lead.status) events.push('lead_status_change');
  if (before.assignedToId !== lead.assignedToId) events.push('lead_assign');
  await Promise.all(events.map((event) => audit(s.userId, event, 'Lead', lead.id, { before, after: lead })));
  return lead;
}

export async function convertLeadToClient(form: FormData) {
  const s = await requirePermission('client.write');
  if (!hasPermission(s, 'lead.write')) denyWriteAccess();
  const data = leadConvertSchema.parse(clean(form));
  const lead = await requireLeadEditAccess(s, data.id);
  if (lead.clientId) {
    await requireCommercialOfferTargetAccess(s, { clientId: lead.clientId });
    const existingClient = await prisma.client.findFirst({ where: { id: lead.clientId, deletedAt: null } });
    if (!existingClient) denyWriteAccess();
    return existingClient;
  }
  const displayName = lead.companyName || `${lead.firstName} ${lead.lastName}`.trim();
  try {
    return await prisma.$transaction(async (tx) => {
      const client = await tx.client.create({ data: { type: data.type, displayName, leadId: lead.id, salesOwnerId: lead.assignedToId ?? s.userId, notes: lead.notes } });
      const claimed = await tx.lead.updateMany({
        where: { id: lead.id, clientId: null, updatedAt: lead.updatedAt },
        data: { clientId: client.id, status: 'vinto', updatedAt: nextConcurrencyTimestamp(lead.updatedAt) },
      });
      if (claimed.count !== 1) throw new ConcurrentLeadConversionError();
      await tx.auditLog.create({ data: {
        actorId: s.userId,
        event: 'lead_convert_to_client',
        entityType: 'Lead',
        entityId: lead.id,
        after: { leadId: lead.id, clientId: client.id, fromStatus: lead.status, toStatus: 'vinto', salesOwnerId: client.salesOwnerId },
      } });
      return client;
    });
  } catch (error) {
    if (!isUniqueConstraintError(error) && !(error instanceof ConcurrentLeadConversionError)) throw error;

    const currentLead = await requireLeadEditAccess(s, data.id);
    const existingClient = currentLead.clientId
      ? await prisma.client.findFirst({ where: { id: currentLead.clientId, deletedAt: null } })
      : await prisma.client.findFirst({ where: { leadId: currentLead.id, deletedAt: null } });
    if (!existingClient) throw new UserFacingActionError('Il lead è stato modificato durante la conversione. Riprova.');
    await requireCommercialOfferTargetAccess(s, { clientId: existingClient.id });

    if (!currentLead.clientId) {
      const reconciled = await prisma.lead.updateMany({
        where: { id: currentLead.id, clientId: null, updatedAt: currentLead.updatedAt },
        data: { clientId: existingClient.id, status: 'vinto', updatedAt: nextConcurrencyTimestamp(currentLead.updatedAt) },
      });
      if (reconciled.count !== 1) throw new UserFacingActionError('Il lead è stato modificato durante la conversione. Ricarica la pagina.');
    }
    return existingClient;
  }
}

export async function createCommercialOffer(form: FormData) {
  const s = await requirePermission('lead.write');
  const data = commercialOfferSchema.parse(clean(form));
  await requireCommercialOfferTargetAccess(s, data);
  const { commercialAction: _commercialAction, ...offerData } = data;
  void _commercialAction;
  const offer = await prisma.commercialOffer.create({ data: { ...offerData, createdById: s.userId } });
  await audit(s.userId, 'commercial_offer_create', 'CommercialOffer', offer.id, offer);
  return offer;
}
export async function updateCommercialOffer(form: FormData) {
  const s = await requirePermission('lead.write');
  const data = commercialOfferUpdateSchema.parse(clean(form));
  const { offer: before } = await requireCommercialOfferEditAccess(s, data.id);
  await requireCommercialOfferTargetAccess(s, data);
  const now = new Date();
  const updateData: Prisma.CommercialOfferUpdateInput = {
    leadId: data.leadId ?? null,
    clientId: data.clientId ?? null,
    title: data.title,
    description: data.description,
    services: data.services,
    includedActivities: data.includedActivities,
    taxableAmount: data.taxableAmount,
    vatAmount: data.vatAmount,
    totalAmount: data.totalAmount,
    validUntil: data.validUntil ?? null,
    operationalConditions: data.operationalConditions,
    commercialProposal: data.commercialProposal,
    status: data.status,
    notes: data.notes,
    sentAt: data.sentAt ?? null,
    followUpAt: data.followUpAt ?? null,
    followUpNote: data.followUpNote,
    outcomeNote: data.outcomeNote,
    acceptedAt: data.acceptedAt ?? null,
    rejectedAt: data.rejectedAt ?? null,
    rejectionReason: data.rejectionReason,
  };
  if (data.commercialAction === 'mark_sent') {
    updateData.status = 'inviata';
    updateData.sentAt = now;
    updateData.acceptedAt = before.acceptedAt;
    updateData.rejectedAt = before.rejectedAt;
    updateData.rejectionReason = before.rejectionReason;
  } else if (data.commercialAction === 'mark_accepted') {
    updateData.status = 'accettata';
    updateData.acceptedAt = now;
    updateData.rejectedAt = null;
    updateData.rejectionReason = null;
    updateData.sentAt = before.sentAt;
  } else if (data.commercialAction === 'mark_rejected') {
    updateData.status = 'rifiutata';
    updateData.rejectedAt = now;
    updateData.acceptedAt = null;
    updateData.sentAt = before.sentAt;
  } else if (data.commercialAction === 'update_followup') {
    updateData.status = before.status;
    updateData.sentAt = before.sentAt;
    updateData.acceptedAt = before.acceptedAt;
    updateData.rejectedAt = before.rejectedAt;
    updateData.rejectionReason = before.rejectionReason;
  }
  if (updateData.status === 'accettata') {
    updateData.rejectedAt = null;
    updateData.rejectionReason = null;
    updateData.acceptedAt = updateData.acceptedAt ?? (before.status !== 'accettata' ? now : before.acceptedAt);
  } else if (updateData.status === 'rifiutata') {
    updateData.acceptedAt = null;
    updateData.rejectedAt = updateData.rejectedAt ?? (before.status !== 'rifiutata' ? now : before.rejectedAt);
  } else if (updateData.status === 'inviata' && !updateData.sentAt) {
    updateData.sentAt = now;
  }
  const offer = await prisma.commercialOffer.update({ where: { id: data.id }, data: updateData });
  const events = ['commercial_offer_update'];
  if (before.status !== offer.status) events.push('commercial_offer_status_change');
  if (before.sentAt?.getTime() !== offer.sentAt?.getTime() && offer.sentAt) events.push('commercial_offer_sent');
  if (before.followUpAt?.getTime() !== offer.followUpAt?.getTime() || before.followUpNote !== offer.followUpNote) events.push('commercial_offer_followup_update');
  if (offer.status === 'accettata' && (before.status !== offer.status || before.acceptedAt?.getTime() !== offer.acceptedAt?.getTime())) events.push('commercial_offer_accepted');
  if (offer.status === 'rifiutata' && (before.status !== offer.status || before.rejectedAt?.getTime() !== offer.rejectedAt?.getTime())) events.push('commercial_offer_rejected');
  if (before.outcomeNote !== offer.outcomeNote || before.acceptedAt?.getTime() !== offer.acceptedAt?.getTime() || before.rejectedAt?.getTime() !== offer.rejectedAt?.getTime() || before.rejectionReason !== offer.rejectionReason) events.push('commercial_offer_outcome_update');
  await Promise.all([...new Set(events)].map((event) => audit(s.userId, event, 'CommercialOffer', offer.id, { before, after: offer })));
  return offer;
}
export async function auditCommercialOfferExport(offerId: string, format: 'docx') {
  const s = await requirePermission('lead.read');
  await requireCommercialOfferEditAccess(s, offerId);
  await audit(s.userId, 'commercial_offer_export_word', 'CommercialOffer', offerId, { format });
}

export async function createClient(form: FormData) {
  const s = await requirePermission('client.write');
  const data = clientSchema.parse(clean(form));
  if (data.leadId) await requireLeadEditAccess(s, data.leadId);
  const client = await prisma.client.create({ data: { ...data, salesOwnerId: s.role === 'commerciale' ? s.userId : undefined } });
  await audit(s.userId, 'client_create', 'Client', client.id, client);
  return client;
}

export async function createCompany(form: FormData) {
  const s = await requirePermission('company.write');
  const data = companySchema.parse(clean(form));
  await requireClientContextWriteAccess(s, { clientId: data.clientId });
  const company = await prisma.company.create({ data: data as never });
  await audit(s.userId, 'company_create', 'Company', company.id, company);
  return company;
}

export async function createProject(form: FormData) {
  const s = await requirePermission('project.write');
  const data = projectSchema.parse(clean(form));
  await requireClientContextWriteAccess(s, { clientId: data.clientId, companyId: data.companyId });
  const project = await prisma.project.create({ data: { ...data, consultantId: s.role === 'consulente' ? s.userId : undefined } as never });
  await audit(s.userId, 'project_create', 'Project', project.id, project);
  return project;
}

export async function createProjectExpense(form: FormData) {
  const s = await requirePermission('project.write');
  const data = projectExpenseSchema.parse(clean(form));
  await requireProjectEditAccess(s, data.projectId);
  const expense = await prisma.projectExpense.create({ data: data as never });
  await audit(s.userId, 'project_expense_create', 'ProjectExpense', expense.id, expense);
  return expense;
}

export async function uploadDocument(form: FormData) {
  const s = await requirePermission('document.upload');
  const file = form.get('file');
  if (!(file instanceof File) || file.size <= 0) throw new UserFacingActionError('File obbligatorio');
  const parsed = documentUploadSchema.safeParse(clean(form));
  if (!parsed.success) throw new UserFacingActionError('Controlla i dati del documento: cliente, progetto e servizio devono essere coerenti.');
  const data = parsed.data;
  await requireClientContextWriteAccess(s, data, { allowBackofficeClient: true });
  const fileName = sanitizeFileName(file.name);
  const saved = await savePrivateDocumentFile({ file, clientId: data.clientId, clientServiceId: data.clientServiceId, fileName });
  const document = await prisma.document.create({ data: {
    ...data,
    title: data.title,
    type: file.type || 'application/octet-stream',
    fileName,
    mimeType: file.type || 'application/octet-stream',
    sizeBytes: saved.sizeBytes,
    storagePath: saved.storagePath,
    checksum: saved.checksum,
    uploadedById: s.userId,
  } as never });
  await audit(s.userId, 'document_upload', 'Document', document.id, { documentId: document.id, fileName, sizeBytes: saved.sizeBytes, checksum: saved.checksum });
  return document;
}


const standardChecklistTitles = ['Visura aggiornata','Documento identità','Codice fiscale','DURC','Ultimo bilancio depositato','Situazione contabile aggiornata','Ultima dichiarazione redditi','Estratti conto ultimi 3 mesi','Centrale Rischi Banca d’Italia','CRIF / report creditizio','Preventivi investimento','Business plan / relazione progetto'];

async function assertChecklistContext(session: AuthSession, clientId: string, clientServiceId?: string, projectId?: string, documentId?: string) {
  await requireClientContextWriteAccess(session, { clientId, clientServiceId, projectId }, { allowBackofficeClient: true });
  if (documentId) {
    const document = await requireDocumentEditAccess(session, documentId);
    if (document.clientId !== clientId) denyWriteAccess();
  }
}

export async function createDocumentChecklistItem(form: FormData) {
  const s = await requirePermission('service.write');
  const data = documentChecklistItemSchema.parse(clean(form));
  await assertChecklistContext(s, data.clientId, data.clientServiceId, data.projectId, data.documentId);
  const item = await prisma.documentChecklistItem.create({ data: { ...data, createdById: s.userId, updatedById: s.userId } as never });
  await audit(s.userId, 'document_checklist_item_create', 'DocumentChecklistItem', item.id, item);
  return item;
}

export async function createStandardDocumentChecklist(form: FormData) {
  const s = await requirePermission('service.write');
  const clientId = String(form.get('clientId') || '');
  const clientServiceId = String(form.get('clientServiceId') || '') || undefined;
  const projectId = String(form.get('projectId') || '') || undefined;
  await assertChecklistContext(s, clientId, clientServiceId, projectId);
  const existing = await prisma.documentChecklistItem.findMany({ where: { clientId, clientServiceId: clientServiceId ?? null, deletedAt: null }, select: { title: true } });
  const existingTitles = new Set(existing.map((item) => item.title.toLowerCase()));
  const toCreate = standardChecklistTitles.filter((title) => !existingTitles.has(title.toLowerCase()));
  if (toCreate.length === 0) return [];
  const created = await prisma.$transaction(toCreate.map((title) => prisma.documentChecklistItem.create({ data: { clientId, clientServiceId, projectId, title, createdById: s.userId, updatedById: s.userId } as never })));
  await Promise.all(created.map((item) => audit(s.userId, 'document_checklist_item_create', 'DocumentChecklistItem', item.id, item)));
  return created;
}

export async function updateDocumentChecklistItemStatus(form: FormData) {
  const s = await requirePermission('service.write');
  const data = checklistItemStatusUpdateSchema.parse(clean(form));
  const before = await requireChecklistEditAccess(s, data.id);
  const item = await prisma.documentChecklistItem.update({ where: { id: data.id }, data: { status: data.status, updatedById: s.userId } });
  await audit(s.userId, 'document_checklist_status_change', 'DocumentChecklistItem', item.id, { before, after: item });
  return item;
}

export async function linkDocumentToChecklistItem(form: FormData) {
  const s = await requirePermission('service.write');
  const data = checklistItemDocumentLinkSchema.parse(clean(form));
  const before = await requireChecklistEditAccess(s, data.id);
  await assertChecklistContext(s, before.clientId, before.clientServiceId ?? undefined, before.projectId ?? undefined, data.documentId);
  const item = await prisma.documentChecklistItem.update({ where: { id: data.id }, data: { documentId: data.documentId, updatedById: s.userId } });
  await audit(s.userId, 'document_checklist_document_link', 'DocumentChecklistItem', item.id, { before, after: item });
  return item;
}

export async function unlinkDocumentFromChecklistItem(form: FormData) {
  const s = await requirePermission('service.write');
  const data = checklistItemIdSchema.parse(clean(form));
  const before = await requireChecklistEditAccess(s, data.id);
  const item = await prisma.documentChecklistItem.update({ where: { id: data.id }, data: { documentId: null, updatedById: s.userId } });
  await audit(s.userId, 'document_checklist_document_unlink', 'DocumentChecklistItem', item.id, { before, after: item });
  return item;
}

export async function deactivateDocumentChecklistItem(form: FormData) {
  const s = await requirePermission('service.write');
  const data = checklistItemIdSchema.parse(clean(form));
  const before = await requireChecklistEditAccess(s, data.id);
  const item = await prisma.documentChecklistItem.update({ where: { id: data.id }, data: { active: false, deletedAt: new Date(), updatedById: s.userId } });
  await audit(s.userId, 'document_checklist_item_deactivate', 'DocumentChecklistItem', item.id, { before, after: item });
  return item;
}

async function assertTaskContext(session: AuthSession, clientId: string, clientServiceId?: string, projectId?: string, assignedToId?: string) {
  await requireClientContextWriteAccess(session, { clientId, clientServiceId, projectId }, { allowBackofficeClient: true });
  await requireActiveUser(assignedToId);
}

export async function createClientTask(form: FormData) {
  const s = await requirePermission('service.write');
  const data = clientTaskSchema.parse(clean(form));
  await assertTaskContext(s, data.clientId, data.clientServiceId, data.projectId, data.assignedToId);
  if (data.assignedToId && data.assignedToId !== s.userId && !hasPermission(s, 'service.assign')) denyWriteAccess();
  const task = await prisma.task.create({ data: { ...data, createdById: s.userId } as never });
  await audit(s.userId, 'client_task_create', 'Task', task.id, task);
  return task;
}

export async function updateClientTask(form: FormData) {
  const s = await requirePermission('service.write');
  const data = taskUpdateSchema.parse(clean(form));
  const before = await requireTaskEditAccess(s, data.id);
  await requireActiveUser(data.assignedToId);
  const nextAssignedToId = data.assignedToId ?? null;
  if (before.assignedToId !== nextAssignedToId && nextAssignedToId !== s.userId && !hasPermission(s, 'service.assign')) denyWriteAccess();
  const nextCompletedAt = data.status === 'completata' ? (before.completedAt ?? new Date()) : null;
  const task = await prisma.task.update({ where: { id: data.id }, data: { status: data.status, priority: data.priority, assignedToId: data.assignedToId ?? null, dueAt: data.dueAt ?? null, completedAt: nextCompletedAt } });
  const events = ['client_task_update'];
  if (before.status !== task.status) events.push(task.status === 'completata' ? 'client_task_complete' : task.status === 'annullata' ? 'client_task_cancel' : 'client_task_status_change');
  if (before.assignedToId !== task.assignedToId) events.push('client_task_assign');
  if ((before.dueAt?.toISOString() ?? null) !== (task.dueAt?.toISOString() ?? null)) events.push('client_task_due_date_change');
  await Promise.all(events.map((event) => audit(s.userId, event, 'Task', task.id, { before, after: task })));
  return task;
}

export async function completeClientTask(form: FormData) {
  const s = await requirePermission('service.write');
  const data = taskIdSchema.parse(clean(form));
  const before = await requireTaskEditAccess(s, data.id);
  if (before.status === 'annullata') denyWriteAccess();
  const task = await prisma.task.update({ where: { id: data.id }, data: { status: 'completata', completedAt: new Date() } });
  await audit(s.userId, 'client_task_complete', 'Task', task.id, { before, after: task });
  return task;
}


const dossierTypeLabel: Record<string, string> = { pre_analisi: 'Pre-analisi', dossier_cliente: 'Dossier cliente', nota_interna: 'Nota interna' };
function dossierLine(label: string, value: unknown) { return `- ${label}: ${value === null || value === undefined || value === '' ? '—' : String(value)}`; }
function money(value: unknown) { return value ? `€ ${Number(value).toLocaleString('it-IT')}` : '—'; }
function dateLabel(value?: Date | null) { return value ? value.toLocaleDateString('it-IT') : '—'; }

async function assertClientDossierContext(session: AuthSession, clientId: string, clientServiceId?: string, projectId?: string) {
  const access = await requireClientContextReadAccess(session, { clientId, clientServiceId, projectId });
  if (!canViewClient(session, access.client)) denyWriteAccess();
  return access;
}

async function buildClientDossierContent(session: AuthSession, clientId: string, clientServiceId?: string, projectId?: string) {
  const [agentConfig, client, companies, services, serviceCatalog, projects, checklist, documents, tasks] = await Promise.all([
    prisma.aiAgent.findUniqueOrThrow({ where: { code: AI_AGENT_CODES.dossierCliente } }),
    prisma.client.findUniqueOrThrow({ where: { id: clientId } }),
    prisma.company.findMany({ where: { clientId, deletedAt: null }, orderBy: { updatedAt: 'desc' } }),
    prisma.clientService.findMany({ where: { clientId, ...(clientServiceId ? { id: clientServiceId } : {}), deletedAt: null }, orderBy: { updatedAt: 'desc' } }),
    prisma.serviceCatalog.findMany(),
    prisma.project.findMany({ where: { clientId, ...(projectId ? { id: projectId } : {}), deletedAt: null }, orderBy: { updatedAt: 'desc' } }),
    prisma.documentChecklistItem.findMany({ where: { clientId, ...(clientServiceId ? { clientServiceId } : {}), ...(projectId ? { projectId } : {}), active: true, deletedAt: null }, orderBy: { createdAt: 'asc' } }),
    prisma.document.findMany({ where: { clientId, ...(clientServiceId ? { clientServiceId } : {}), ...(projectId ? { projectId } : {}), deletedAt: null }, select: { id: true, clientId: true, projectId: true, clientServiceId: true, uploadedById: true, title: true, documentCategory: true, type: true, status: true, containsSensitiveData: true, createdAt: true }, orderBy: { createdAt: 'desc' } }),
    listAccessibleTasks(session, { where: { clientId, ...(clientServiceId ? { clientServiceId } : {}), ...(projectId ? { projectId } : {}), status: { in: ['aperta','in_lavorazione'] }, deletedAt: null }, orderBy: [{ dueAt: 'asc' }, { updatedAt: 'desc' }] }),
  ]);
  if (!agentConfig.active) throw new UserFacingActionError(`Agente ${AI_AGENT_CODES.dossierCliente} disattivato: riattivarlo da Impostazioni > Agenti AI per generare il dossier.`);
  const canReadSensitive = hasPermission(session, 'document.sensitive.read');
  const projectById = new Map(projects.map((project) => [project.id, { ...project, client }]));
  const serviceById = new Map(services.map((service) => [service.id, {
    ...service,
    client,
    project: service.projectId ? projectById.get(service.projectId) ?? null : null,
  }]));
  const visibleDocuments = documents.filter((document) => canViewDocument(session, {
    ...document,
    client,
    project: document.projectId ? projectById.get(document.projectId) ?? null : null,
    clientService: document.clientServiceId ? serviceById.get(document.clientServiceId) ?? null : null,
  }, canReadSensitive));
  const visibleDocumentIds = new Set(visibleDocuments.map((document) => document.id));
  const visibleChecklist = checklist.filter((item) => {
    if (!canViewChecklistItem(session, {
      ...item,
      client,
      project: item.projectId ? projectById.get(item.projectId) ?? null : null,
      clientService: item.clientServiceId ? serviceById.get(item.clientServiceId) ?? null : null,
    })) return false;
    if (isSensitiveDocument({ containsSensitiveData: false, documentCategory: item.title, type: item.title })) return canReadSensitive;
    return !item.documentId || visibleDocumentIds.has(item.documentId);
  });
  const catalogName = (id: string) => serviceCatalog.find((s) => s.id === id)?.name ?? 'Servizio FAI';
  const mainCompany = companies[0];
  return [
    '# Dossier / Pre-analisi', '', '## Configurazione agente FAI', dossierLine('Agente', agentConfig?.name ?? 'dossier_cliente'), dossierLine('Provider', agentConfig?.provider ?? 'mock'), dossierLine('Versione prompt', agentConfig?.promptVersion ?? 'non disponibile'), dossierLine('Stato agente', 'attivo'), '',
    '## 1. Dati cliente', dossierLine('Cliente', client.displayName), dossierLine('Tipologia', client.type), dossierLine('Stato fascicolo', client.status), dossierLine('Note cliente', client.notes), mainCompany ? dossierLine('Azienda principale', `${mainCompany.name}${mainCompany.vatNumber ? ` · P.IVA ${mainCompany.vatNumber}` : ''}`) : '- Azienda principale: —', '',
    '## 2. Inquadramento attività', companies.length ? companies.map((c) => `- ${c.name}: ${[c.legalForm, c.atecoCode, c.atecoDescription, c.city, c.province].filter(Boolean).join(' · ') || 'dati da completare'}`).join('\n') : '- Dati aziendali non ancora completi.', '',
    '## 3. Obiettivo richiesto', services.length ? services.map((s) => `- ${catalogName(s.serviceCatalogId)} · pratica: ${s.practiceType ?? '—'} · importo richiesto: ${money(s.requestedAmount)} · investimento previsto: ${money(s.plannedInvestment)}`).join('\n') : '- Nessun servizio/pratica collegato.', projects.length ? projects.map((p) => `- Progetto ${p.title}: richiesto ${money(p.requestedAmount)}, investimento ${money(p.totalInvestment)}, stato ${p.status}.`).join('\n') : '- Nessun progetto di investimento collegato.', '',
    '## 4. Stato documentale', visibleChecklist.length ? visibleChecklist.map((i) => `- ${i.title}: ${i.status.replaceAll('_', ' ')}${i.documentId ? ' · documento collegato' : ''}${i.notes ? ` · ${i.notes}` : ''}`).join('\n') : '- Checklist documentale non disponibile o non ancora popolata.', visibleDocuments.length ? visibleDocuments.map((d) => `- Documento caricato: ${d.title} (${d.documentCategory}, stato ${d.status})`).join('\n') : '- Nessun documento visibile per il ruolo corrente.', '',
    '## 5. Stato operativo pratica', services.length ? services.map((s) => `- ${catalogName(s.serviceCatalogId)}: pipeline ${String(s.operationalStatus).replaceAll('_', ' ')}, servizio ${String(s.status).replaceAll('_', ' ')}. Note: ${s.operationalNotes ?? s.internalNotes ?? '—'}`).join('\n') : '- Nessuna pipeline servizio presente.', '',
    '## 6. Attività/scadenze aperte', tasks.length ? tasks.map((t) => `- ${t.title}: ${t.status.replaceAll('_', ' ')} · priorità ${t.priority} · scadenza ${dateLabel(t.dueAt)}${t.description ? ` · ${t.description}` : ''}`).join('\n') : '- Nessuna attività aperta rilevante.', '',
    '## 7. Prime criticità emerse', '- Verificare completezza documentale, coerenza importi richiesti/investimento e condizioni operative prima della revisione.', '',
    '## 8. Scenario A - obiettivo massimo realistico', projects.map((p) => p.scenarioA).filter(Boolean).join('\n') || '- Da completare dopo revisione consulente.', '',
    '## 9. Scenario B - alternativa/ponte', projects.map((p) => p.scenarioB).filter(Boolean).join('\n') || '- Da definire come opzione alternativa o ponte.', '',
    '## 10. Prossime azioni operative', '- Completare o validare la checklist documentale.', '- Aggiornare note operative e importi della pratica.', '- Revisionare manualmente questa bozza prima di condividerne sintesi interne.', '',
    '_Bozza generata con provider mock/template server-side. Nessuna AI reale è stata invocata._',
  ].join('\n');
}

function dossierTypeForAgent(agentCode?: string | null) {
  if (agentCode === 'dossier_cliente') return 'dossier_cliente';
  if (agentCode && ['pre_analisi_agevolata', 'bancabilita', 'finanza_ordinaria'].includes(agentCode)) return 'pre_analisi';
  return 'nota_interna';
}

function buildAiOutputDossierContent(input: {
  clientName: string;
  agentName: string;
  agentCode?: string | null;
  generatedAt: Date;
  serviceLabel?: string | null;
  projectTitle?: string | null;
  outputContent: string;
}) {
  return [
    '# Bozza dossier da output AI', '',
    '## Intestazione cliente',
    dossierLine('Cliente', input.clientName), '',
    '## Origine AI interna',
    dossierLine('Agente usato', `${input.agentName}${input.agentCode ? ` (${input.agentCode})` : ''}`),
    dossierLine('Data generazione output', input.generatedAt.toLocaleString('it-IT')), '',
    '## Contesto pratica/progetto',
    dossierLine('Pratica/servizio', input.serviceLabel ?? 'Fascicolo cliente generale'),
    dossierLine('Progetto', input.projectTitle ?? '—'), '',
    '## Contenuto output AI',
    input.outputContent, '',
    '## Nota interna di revisione',
    '- Bozza creata dopo revisione umana interna dell’output AI approvato/revisionato. Verificare manualmente contenuti, dati cliente, condizioni operative e completezza documentale prima di ogni uso successivo.', '',
    '## Disclaimer FAI',
    'Documento interno di lavoro. Finanza Agevola Impresa S.r.l. non eroga finanziamenti, non promette contributi e non garantisce esiti o erogazioni. Offre consulenza tecnica, strategica e di orientamento.',
  ].join('\n');
}

export async function createClientDossierFromAiOutput(form: FormData) {
  const s = await requirePermission('dossier.write');
  if (!hasPermission(s, 'ai.review')) throw new UserFacingActionError('Permesso ai.review richiesto per trasformare un output AI in bozza dossier.');
  const data = aiOutputDossierSchema.parse(clean(form));
  const outputContext = await requireAiOutputReadAccess(s, data.id);
  const { output, run, clientService: service, project } = outputContext;
  if (!output.clientId) throw new UserFacingActionError('Output AI non collegato a un cliente: impossibile creare la bozza dossier.');
  const hasValidHumanApproval = output.status === 'approved'
    && output.requiresHumanReview === true
    && Boolean(output.reviewedById && output.reviewedAt && output.approvedById && output.approvedAt)
    && Boolean(run.createdById)
    && run.createdById !== output.reviewedById
    && run.createdById !== output.approvedById
    && output.reviewedById !== output.approvedById;
  if (!hasValidHumanApproval) throw new UserFacingActionError('L’output non contiene una revisione e approvazione umana valide e indipendenti dal generatore.');
  if (scanForbiddenPhrases(`${output.title}\n${output.content}`).length) throw new UserFacingActionError('Output AI non conforme: rigenerare e sottoporre a nuova revisione.');

  const [client, previousConversion] = await Promise.all([
    prisma.client.findFirst({ where: { id: output.clientId, deletedAt: null } }),
    prisma.clientDossier.findUnique({ where: { sourceAiOutputId: output.id } }),
  ]);
  if (!client) throw new UserFacingActionError('Cliente collegato all’output non valido.');
  if (previousConversion) {
    const existingContext = await getClientDossierReadAccess(s, previousConversion.id);
    if (!existingContext
      || previousConversion.clientId !== output.clientId
      || (previousConversion.clientServiceId ?? null) !== (output.clientServiceId ?? null)
      || (previousConversion.projectId ?? null) !== (output.projectId ?? null)) denyWriteAccess();
    return previousConversion;
  }

  const agent = await prisma.aiAgent.findUnique({ where: { id: run.agentId } });
  const agentName = agent?.name ?? run.agentId;
  const title = `Bozza da output AI - ${agentName} - ${new Date().toLocaleDateString('it-IT')}`;
  const serviceCatalog = service ? await prisma.serviceCatalog.findUnique({ where: { id: service.serviceCatalogId } }) : null;
  const content = buildAiOutputDossierContent({
    clientName: client.displayName,
    agentName,
    agentCode: agent?.code,
    generatedAt: output.createdAt,
    serviceLabel: buildClientServiceLabel(service, serviceCatalog),
    projectTitle: project?.title,
    outputContent: output.content,
  });

  try {
    return await prisma.$transaction(async (tx) => {
      const dossier = await tx.clientDossier.create({ data: {
        clientId: output.clientId!,
        clientServiceId: output.clientServiceId,
        projectId: output.projectId,
        sourceAiOutputId: output.id,
        type: dossierTypeForAgent(agent?.code),
        title,
        content,
        createdById: s.userId,
        updatedById: s.userId,
      } as never });
      const trace = { outputId: output.id, dossierId: dossier.id, clientId: output.clientId, clientServiceId: output.clientServiceId, projectId: output.projectId, aiRunId: output.aiRunId, agentId: run.agentId };
      await tx.auditLog.createMany({ data: [
        { actorId: s.userId, event: 'client_dossier_create_from_ai_output', entityType: 'ClientDossier', entityId: dossier.id, after: trace },
        { actorId: s.userId, event: 'ai_output_to_client_dossier', entityType: 'AiOutput', entityId: output.id, after: trace },
      ] });
      return dossier;
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const existing = await prisma.clientDossier.findUnique({ where: { sourceAiOutputId: output.id } });
    if (!existing) throw new UserFacingActionError('La conversione è stata completata da un altro operatore. Ricarica la pagina.');
    const existingContext = await getClientDossierReadAccess(s, existing.id);
    if (!existingContext
      || existing.clientId !== output.clientId
      || (existing.clientServiceId ?? null) !== (output.clientServiceId ?? null)
      || (existing.projectId ?? null) !== (output.projectId ?? null)) denyWriteAccess();
    return existing;
  }
}

export async function generateClientDossier(form: FormData) {
  const s = await requirePermission('dossier.write');
  const data = clientDossierGenerateSchema.parse(clean(form));
  await assertClientDossierContext(s, data.clientId, data.clientServiceId, data.projectId);
  const content = await buildClientDossierContent(s, data.clientId, data.clientServiceId, data.projectId);
  const dossier = await prisma.clientDossier.create({ data: { clientId: data.clientId, clientServiceId: data.clientServiceId, projectId: data.projectId, type: data.type, title: data.title ?? `${dossierTypeLabel[data.type]} — ${new Date().toLocaleDateString('it-IT')}`, content, createdById: s.userId, updatedById: s.userId } as never });
  await audit(s.userId, 'client_dossier_generate', 'ClientDossier', dossier.id, { dossierId: dossier.id, clientId: dossier.clientId, clientServiceId: dossier.clientServiceId, projectId: dossier.projectId, type: dossier.type, status: dossier.status });
  return dossier;
}

export async function updateClientDossier(form: FormData) {
  const s = await requirePermission('dossier.write');
  const data = clientDossierUpdateSchema.parse(clean(form));
  const before = await prisma.clientDossier.findUniqueOrThrow({ where: { id: data.id } });
  await assertClientDossierContext(s, before.clientId, before.clientServiceId ?? undefined, before.projectId ?? undefined);
  if (before.status === 'archiviata' && data.status !== 'archiviata') throw new UserFacingActionError('Un dossier archiviato non può essere riaperto dalla modifica generica.');
  const substantiveChange = before.title !== data.title || before.type !== data.type || before.content !== data.content;
  if (data.status === 'revisionata' && (before.status !== 'revisionata' || substantiveChange)) {
    throw new UserFacingActionError('Per confermare un dossier come revisionato usa l’azione di approvazione separata. Ogni modifica sostanziale deve tornare in bozza.');
  }
  const now = nextConcurrencyTimestamp(before.updatedAt);
  return prisma.$transaction(async (tx) => {
    const result = await tx.clientDossier.updateMany({
      where: { id: data.id, status: before.status, updatedAt: before.updatedAt },
      data: {
        title: data.title,
        type: data.type,
        status: data.status,
        content: data.content,
        updatedById: s.userId,
        reviewedById: data.status === 'bozza' ? null : before.reviewedById,
        reviewedAt: data.status === 'bozza' ? null : before.reviewedAt,
        archivedAt: data.status === 'archiviata' ? (before.archivedAt ?? now) : null,
        archivedById: data.status === 'archiviata' ? s.userId : null,
        updatedAt: now,
      },
    });
    if (result.count !== 1) throw new UserFacingActionError('Il dossier è stato modificato da un altro operatore. Ricarica la pagina.');
    const dossier = await tx.clientDossier.findUniqueOrThrow({ where: { id: data.id } });
    await tx.auditLog.create({ data: {
      actorId: s.userId,
      event: before.status !== 'archiviata' && dossier.status === 'archiviata' ? 'client_dossier_archive' : 'client_dossier_update',
      entityType: 'ClientDossier',
      entityId: dossier.id,
      after: { before: dossierAuditSnapshot(before), after: dossierAuditSnapshot(dossier), contentChanged: before.content !== dossier.content },
    } });
    return dossier;
  });
}

export async function approveClientDossier(form: FormData) {
  const s = await requirePermission('dossier.approve');
  const data = clientDossierIdSchema.parse(clean(form));
  const context = await getClientDossierReadAccess(s, data.id);
  if (!context) denyWriteAccess();
  const before = context.dossier;
  if (before.status === 'archiviata') throw new UserFacingActionError('Un dossier archiviato non può essere approvato.');
  if (before.reviewedById && before.reviewedAt && before.status === 'revisionata') return before;
  if (before.createdById === s.userId || before.updatedById === s.userId) {
    throw new UserFacingActionError('Il revisore del dossier deve essere diverso da chi lo ha creato o modificato per ultimo.');
  }
  const now = nextConcurrencyTimestamp(before.updatedAt);
  return prisma.$transaction(async (tx) => {
    const result = await tx.clientDossier.updateMany({
      where: {
        id: before.id,
        status: { in: ['bozza', 'revisionata'] },
        reviewedById: null,
        reviewedAt: null,
        updatedAt: before.updatedAt,
        createdById: { not: s.userId },
        OR: [{ updatedById: null }, { updatedById: { not: s.userId } }],
      },
      data: { status: 'revisionata', reviewedById: s.userId, reviewedAt: now, updatedById: s.userId, updatedAt: now },
    });
    if (result.count !== 1) throw new UserFacingActionError('Dossier già revisionato o modificato da un altro operatore.');
    const dossier = await tx.clientDossier.findUniqueOrThrow({ where: { id: before.id } });
    await tx.auditLog.create({ data: {
      actorId: s.userId,
      event: 'client_dossier_review',
      entityType: 'ClientDossier',
      entityId: dossier.id,
      after: { before: dossierAuditSnapshot(before), after: dossierAuditSnapshot(dossier) },
    } });
    return dossier;
  });
}

export async function archiveClientDossier(form: FormData) {
  const s = await requirePermission('dossier.write');
  const data = clientDossierIdSchema.parse(clean(form));
  const before = await prisma.clientDossier.findUniqueOrThrow({ where: { id: data.id } });
  await assertClientDossierContext(s, before.clientId, before.clientServiceId ?? undefined, before.projectId ?? undefined);
  if (before.status === 'archiviata') return before;
  const now = nextConcurrencyTimestamp(before.updatedAt);
  return prisma.$transaction(async (tx) => {
    const result = await tx.clientDossier.updateMany({
      where: { id: data.id, status: before.status, updatedAt: before.updatedAt },
      data: { status: 'archiviata', archivedAt: before.archivedAt ?? now, archivedById: s.userId, updatedById: s.userId, updatedAt: now },
    });
    if (result.count !== 1) throw new UserFacingActionError('Il dossier è stato modificato da un altro operatore. Ricarica la pagina.');
    const dossier = await tx.clientDossier.findUniqueOrThrow({ where: { id: data.id } });
    await tx.auditLog.create({ data: {
      actorId: s.userId,
      event: 'client_dossier_archive',
      entityType: 'ClientDossier',
      entityId: dossier.id,
      after: { before: dossierAuditSnapshot(before), after: dossierAuditSnapshot(dossier) },
    } });
    return dossier;
  });
}

export async function auditClientDossierExport(id: string, format: 'markdown' | 'docx' = 'markdown') {
  const s = await requirePermission('dossier.read');
  const dossier = await prisma.clientDossier.findUniqueOrThrow({ where: { id } });
  await requireClientContextReadAccess(s, { clientId: dossier.clientId, clientServiceId: dossier.clientServiceId, projectId: dossier.projectId });
  await audit(s.userId, 'client_dossier_export', 'ClientDossier', dossier.id, { dossierId: dossier.id, clientId: dossier.clientId, format });
  return dossier;
}

export async function registerDocument(form: FormData) {
  await requirePermission('document.upload');
  void form;
  throw new UserFacingActionError('Registrazione documentale legacy disabilitata: usa il caricamento protetto del CRM.');
}
export async function createPreAnalysis(form: FormData) {
  const s = await requirePermission('project.write');
  const data = preAnalysisSchema.parse(clean(form));
  await requireClientContextWriteAccess(s, { clientId: data.clientId, companyId: data.companyId, projectId: data.projectId });
  const pre = await prisma.preAnalysis.create({ data: data as never });
  await audit(s.userId, 'preanalysis_create', 'PreAnalysis', pre.id, pre);
  return pre;
}

export async function createDossier(form: FormData) {
  const s = await requirePermission('project.write');
  const data = dossierSchema.parse(clean(form));
  const project = await requireProjectEditAccess(s, data.projectId);
  if (project.clientId !== data.clientId) denyWriteAccess();
  if (data.preAnalysisId) {
    const preAnalysis = await prisma.preAnalysis.findFirst({ where: { id: data.preAnalysisId, projectId: data.projectId, clientId: data.clientId }, select: { id: true } });
    if (!preAnalysis) denyWriteAccess();
  }
  const dossier = await prisma.dossier.create({ data: { ...data, modifiedById: s.userId } as never });
  await audit(s.userId, 'dossier_modify', 'Dossier', dossier.id, dossier);
  return dossier;
}

export async function createContract(form: FormData) {
  const s = await requirePermission('contract.write');
  const data = contractSchema.parse(clean(form));
  const [client, project] = await Promise.all([
    prisma.client.findFirst({ where: { id: data.clientId, deletedAt: null }, select: { id: true } }),
    data.projectId ? prisma.project.findFirst({ where: { id: data.projectId, clientId: data.clientId, deletedAt: null }, select: { id: true } }) : null,
  ]);
  if (!client || (data.projectId && !project)) denyWriteAccess();
  const contract = await prisma.contract.create({ data: data as never });
  await audit(s.userId, 'contract_modify', 'Contract', contract.id, contract);
  return contract;
}

export async function registerPayment(form: FormData) {
  const s = await requirePermission('payment.write');
  const data = paymentSchema.parse(clean(form));
  const contract = await prisma.contract.findFirst({ where: { id: data.contractId, clientId: data.clientId }, select: { id: true } });
  if (!contract) denyWriteAccess();
  const payment = await prisma.payment.create({ data: data as never });
  await audit(s.userId, 'payment_register', 'Payment', payment.id, payment);
  return payment;
}

export async function createClientService(form: FormData) {
  const s = await requirePermission('service.write');
  const data = clientServiceSchema.parse(clean(form));
  await requireClientContextWriteAccess(s, data, { allowBackofficeClient: true });
  const [catalog, contract, payment] = await Promise.all([
    prisma.serviceCatalog.findFirst({ where: { id: data.serviceCatalogId, active: true }, select: { id: true } }),
    data.contractId ? prisma.contract.findFirst({ where: { id: data.contractId, clientId: data.clientId }, select: { id: true, clientId: true, projectId: true } }) : null,
    data.paymentId ? prisma.payment.findFirst({ where: { id: data.paymentId, clientId: data.clientId }, select: { id: true, clientId: true, contractId: true } }) : null,
  ]);
  if (!catalog || (data.contractId && !contract) || (data.paymentId && !payment)) denyWriteAccess();
  if (contract?.projectId && data.projectId && contract.projectId !== data.projectId) denyWriteAccess();
  if (payment && data.contractId && payment.contractId !== data.contractId) denyWriteAccess();
  if (data.status && ['chiuso', 'archiviato', 'consegnato'].includes(data.status) && !hasPermission(s, 'service.close')) denyWriteAccess();
  await requireActiveUser(data.assignedToId);
  if (data.assignedToId && data.assignedToId !== s.userId && !hasPermission(s, 'service.assign')) denyWriteAccess();
  const service = await prisma.clientService.create({ data: data as never });
  await audit(s.userId, 'client_service_create', 'ClientService', service.id, service);
  return service;
}

export async function updateClientServiceStatus(id: string, status: string) {
  const s = await requirePermission('service.write');
  const next = serviceStatusSchema.parse(status);
  const before = await requireServiceEditAccess(s, id);
  const finalStatuses = ['chiuso', 'archiviato', 'consegnato'];
  if (before.status !== next && (finalStatuses.includes(before.status) || finalStatuses.includes(next)) && !hasPermission(s, 'service.close')) denyWriteAccess();
  const service = await prisma.clientService.update({ where: { id }, data: { status: next, completedAt: ['chiuso','archiviato','consegnato'].includes(next) ? new Date() : undefined } });
  await audit(s.userId, 'client_service_status_change', 'ClientService', id, { before, after: service });
  return service;
}

export async function assignClientService(id: string, assignedToId: string) {
  const s = await requirePermission('service.assign');
  const before = await requireServiceAssignAccess(s, id);
  await requireActiveUser(assignedToId || null);
  const service = await prisma.clientService.update({ where: { id }, data: { assignedToId: assignedToId || null } });
  await audit(s.userId, 'client_service_assign', 'ClientService', id, { before, after: service });
  return service;
}
export async function updateClientServicePipeline(form: FormData) {
  const s = await requirePermission('service.write');
  const assignmentSubmitted = form.has('assignedToId');
  const data = clientServicePipelineSchema.parse(clean(form));
  const before = await requireServiceEditAccess(s, data.id);
  const nextAssignedToId = assignmentSubmitted ? (data.assignedToId ?? null) : before.assignedToId;
  const assigneeChanged = before.assignedToId !== nextAssignedToId;
  const finalOperationalStatuses = ['chiusa', 'archiviata'];
  if (before.operationalStatus !== data.operationalStatus && (finalOperationalStatuses.includes(before.operationalStatus) || finalOperationalStatuses.includes(data.operationalStatus)) && !hasPermission(s, 'service.close')) denyWriteAccess();
  if (assigneeChanged && !hasPermission(s, 'service.assign')) denyWriteAccess();
  if (assigneeChanged) await requireActiveUser(nextAssignedToId);
  const service = await prisma.clientService.update({
    where: { id: data.id },
    data: {
      operationalStatus: data.operationalStatus,
      statusUpdatedAt: before.operationalStatus === data.operationalStatus ? before.statusUpdatedAt : new Date(),
      practiceType: data.practiceType ?? null,
      requestedAmount: data.requestedAmount ?? null,
      plannedInvestment: data.plannedInvestment ?? null,
      assignedToId: nextAssignedToId,
      operationalNotes: data.operationalNotes ?? null,
    },
  });
  const events = ['client_service_pipeline_update'];
  if (before.operationalStatus !== service.operationalStatus) events.push('client_service_operational_status_change');
  if (String(before.requestedAmount ?? '') !== String(service.requestedAmount ?? '') || String(before.plannedInvestment ?? '') !== String(service.plannedInvestment ?? '')) events.push('client_service_amounts_change');
  if (assigneeChanged) events.push('client_service_assign');
  await Promise.all(events.map((event) => audit(s.userId, event, 'ClientService', service.id, { before, after: service })));
  return service;
}
export async function linkDocumentToService(form: FormData) {
  const s = await requirePermission('service.write');
  const data = documentServiceLinkSchema.parse(clean(form));
  const currentDocument = await requireDocumentEditAccess(s, data.documentId);
  if (currentDocument.clientServiceId && currentDocument.clientServiceId !== data.clientServiceId) {
    await requireServiceEditAccess(s, currentDocument.clientServiceId);
  }
  if (data.clientServiceId) {
    const service = await requireServiceEditAccess(s, data.clientServiceId);
    if (!currentDocument.clientId || currentDocument.clientId !== service.clientId) denyWriteAccess();
  }
  const document = await prisma.document.update({ where: { id: data.documentId }, data: { clientServiceId: data.clientServiceId ?? null, serviceArea: data.serviceArea, documentCategory: data.documentCategory } });
  await audit(s.userId, 'document_service_link', 'Document', document.id, { before: currentDocument, after: document });
  return document;
}

export async function updateDocumentSection(form: FormData) {
  const s = await requirePermission('document.upload');
  const data = documentServiceLinkSchema.parse(clean(form));
  const before = await requireDocumentEditAccess(s, data.documentId);
  const document = await prisma.document.update({ where: { id: data.documentId }, data: { serviceArea: data.serviceArea, documentCategory: data.documentCategory } });
  await audit(s.userId, 'document_section_update', 'Document', document.id, { before, after: document });
  return document;
}


export async function runClientAiAgent(form: FormData) {
  const s = await requirePermission('ai.run');
  await reconcileExpiredAiRuns({ actorId: s.userId });
  const data = clientAiRunSchema.parse(clean(form));
  const { agent: requestedAgent, snapshot: requestedSnapshot } = await currentAiAgentWithSnapshot(data.agentId);
  if (!requestedAgent.active) throw new UserFacingActionError('Agente AI disattivato: esecuzione non consentita.');
  if (!requestedSnapshot.active || !isPrimaryOperationalAiAgent(requestedSnapshot.code)) throw new UserFacingActionError('Agente AI non abilitato al workflow operativo cliente.');
  const requestedRuntime = resolveAiAgentRuntime(requestedSnapshot.provider, requestedSnapshot.model);
  const externalProviderRequested = requestedRuntime.provider === 'openai';

  const access = await requireClientContextReadAccess(s, data);
  const client = await prisma.client.findFirst({ where: { id: data.clientId, deletedAt: null } });
  if (!client) throw new UserFacingActionError('Cliente non accessibile');
  const { clientService, project } = access;
  const linkedCompanyId = clientService?.companyId ?? project?.companyId ?? undefined;
  const canViewWholeClient = canViewClient(s, access.client);

  const [companies, checklist, tasks, documents, allProjects, allServices, serviceCatalog] = await Promise.all([
    linkedCompanyId || canViewWholeClient
      ? prisma.company.findMany({
          where: { clientId: data.clientId, ...(linkedCompanyId ? { id: linkedCompanyId } : {}), deletedAt: null },
          select: { annualRevenue: true, legalForm: true, atecoCode: true, region: true, employees: true, durcStatus: true },
          orderBy: { updatedAt: 'desc' },
          take: linkedCompanyId ? 1 : 3,
        })
      : Promise.resolve([]),
    prisma.documentChecklistItem.findMany({
      where: { clientId: data.clientId, clientServiceId: data.clientServiceId || undefined, projectId: data.projectId || undefined, deletedAt: null, active: true },
      select: { clientId: true, projectId: true, clientServiceId: true, createdById: true, updatedById: true, title: true, status: true, documentId: true },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    }),
    listAccessibleTasks(s, {
      where: { clientId: data.clientId, clientServiceId: data.clientServiceId || undefined, projectId: data.projectId || undefined, deletedAt: null },
      orderBy: { dueAt: 'asc' },
      take: 25,
    }),
    prisma.document.findMany({
      where: { clientId: data.clientId, clientServiceId: data.clientServiceId || undefined, projectId: data.projectId || undefined, deletedAt: null },
      select: { id: true, clientId: true, projectId: true, clientServiceId: true, uploadedById: true, containsSensitiveData: true, documentCategory: true, type: true, status: true, serviceArea: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
    prisma.project.findMany({ where: { clientId: data.clientId, deletedAt: null } }),
    prisma.clientService.findMany({ where: { clientId: data.clientId, deletedAt: null } }),
    clientService
      ? prisma.serviceCatalog.findMany({ where: { id: clientService.serviceCatalogId }, select: { id: true, name: true } })
      : Promise.resolve([]),
  ]);
  const projectById = new Map(allProjects.map((item) => [item.id, { ...item, client: access.client }]));
  const serviceById = new Map(allServices.map((item) => [item.id, {
    ...item,
    client: access.client,
    project: item.projectId ? projectById.get(item.projectId) ?? null : null,
  }]));
  const canReadSensitive = hasPermission(s, 'document.sensitive.read');
  const visibleDocuments = documents.filter((document) => canViewDocument(s, {
    ...document,
    client: access.client,
    project: document.projectId ? projectById.get(document.projectId) ?? null : null,
    clientService: document.clientServiceId ? serviceById.get(document.clientServiceId) ?? null : null,
  }, canReadSensitive));
  const aiEligibleDocuments = visibleDocuments.filter((document) => !isSensitiveDocument(document));
  const aiEligibleDocumentIds = new Set(aiEligibleDocuments.map((document) => document.id));
  const safeChecklist = checklist.filter((item) => {
    if (!canViewChecklistItem(s, {
      ...item,
      client: access.client,
      project: item.projectId ? projectById.get(item.projectId) ?? null : null,
      clientService: item.clientServiceId ? serviceById.get(item.clientServiceId) ?? null : null,
    })) return false;
    if (isSensitiveDocument({ containsSensitiveData: false, documentCategory: item.title, type: item.title })) return false;
    return !item.documentId || aiEligibleDocumentIds.has(item.documentId);
  });
  const safeDocuments = aiEligibleDocuments.map((document) => ({
    documentCategory: document.documentCategory,
    status: document.status,
    serviceArea: document.serviceArea,
  }));
  const operationalInstructions = minimizeAiInstructions(data.operationalInstructions);
  const input = JSON.parse(JSON.stringify({
    source: 'CRM interno FAI',
    humanReviewRequired: true,
    context: {
      client: { type: client.type, status: client.status },
      companies: companies.map((company) => ({
        annualRevenue: company.annualRevenue,
        legalForm: company.legalForm,
        atecoCode: company.atecoCode,
        region: company.region,
        employees: company.employees,
        durcStatus: company.durcStatus,
      })),
      clientService: clientService ? {
        serviceCatalogId: clientService.serviceCatalogId,
        practiceType: clientService.practiceType,
        status: clientService.status,
        operationalStatus: clientService.operationalStatus,
        requestedAmount: clientService.requestedAmount,
        plannedInvestment: clientService.plannedInvestment,
      } : null,
      serviceCatalog: serviceCatalog.map((item) => ({ id: item.id, name: item.name })),
      project: project ? {
        requestedAmount: project.requestedAmount,
        totalInvestment: project.totalInvestment,
        status: project.status,
        priority: project.priority,
        startTiming: project.startTiming,
        region: project.region,
        sector: project.sector,
      } : null,
      checklist: safeChecklist.map((item) => ({ title: item.title, status: item.status, hasLinkedDocument: Boolean(item.documentId) })),
      tasks: tasks.map((task) => ({ status: task.status, priority: task.priority })),
      documents: safeDocuments,
    },
  }));
  const mockProviderInput = operationalInstructions ? { ...input, operationalInstructions } : input;
  const externalPayload: ExternalAiPayload = createExternalAiPayload({
    source: 'CRM interno FAI',
    humanReviewRequired: true,
    ...(operationalInstructions ? { operationalInstructions } : {}),
    context: {
      client: { type: client.type, status: client.status },
      companies: companies.map((company) => ({
        annualRevenue: externalNumericValue(company.annualRevenue),
        legalForm: company.legalForm,
        atecoCode: company.atecoCode,
        region: company.region,
        employees: company.employees,
        durcStatus: company.durcStatus,
      })),
      service: clientService ? {
        label: buildClientServiceLabel(clientService, serviceCatalog[0], 'Pratica cliente'),
        practiceType: clientService.practiceType,
        status: clientService.status,
        operationalStatus: clientService.operationalStatus,
        requestedAmount: externalNumericValue(clientService.requestedAmount),
        plannedInvestment: externalNumericValue(clientService.plannedInvestment),
      } : null,
      project: project ? {
        requestedAmount: externalNumericValue(project.requestedAmount),
        totalInvestment: externalNumericValue(project.totalInvestment),
        status: project.status,
        priority: project.priority,
        startTiming: project.startTiming,
        region: project.region,
        sector: project.sector,
      } : null,
      checklist: safeChecklist.map((item) => ({
        title: item.title,
        status: item.status,
        hasLinkedDocument: Boolean(item.documentId),
      })),
      documents: safeDocuments,
      tasks: tasks.map((task) => ({ status: task.status, priority: task.priority })),
    },
  });
  const externalDataCategories = externalAiDataCategories(externalPayload);
  const snapshotRuntime = aiAgentSnapshotRuntime(requestedSnapshot);
  const providerInput = requestedRuntime.provider === 'openai' ? externalPayload : mockProviderInput;
  const exactProviderBody = requestedRuntime.provider === 'openai'
    ? createOpenAiResponseRequestBody(snapshotRuntime, externalPayload, requestedRuntime.model)
    : { agent: snapshotRuntime, input: mockProviderInput };
  const externalPayloadHash = requestedRuntime.provider === 'openai'
    ? canonicalSha256(exactProviderBody)
    : null;
  const requestFingerprint = createAiRequestFingerprint({
    kind: 'client_ai_agent_run_v1',
    requestKey: data.requestKey,
    agentId: data.agentId,
    clientId: data.clientId,
    clientServiceId: data.clientServiceId ?? null,
    projectId: data.projectId ?? null,
    externalDataConfirmed: data.externalDataConfirmed,
    provider: requestedRuntime.provider,
    model: requestedRuntime.model,
    agentConfig: aiAgentConfigFingerprint(requestedSnapshot),
    body: exactProviderBody,
  });
  const existing = await existingAiRunForRequest(s.userId, data.requestKey);
  if (existing) return resolveExistingAiOutput(s, existing, requestFingerprint, 'ai.run');
  if (externalProviderRequested && !hasPermission(s, 'ai.external.run')) {
    throw new UserFacingActionError('Il provider OpenAI richiede anche il permesso ai.external.run.');
  }
  if (externalProviderRequested && !data.externalDataConfirmed) {
    throw new UserFacingActionError('Conferma esplicitamente l’invio dei dati minimizzati al provider OpenAI.');
  }

  // Access is evaluated again after the DTO has been assembled, immediately
  // before a durable reservation can authorize execution.
  await requireClientContextReadAccess(s, data);
  let reservation;
  try {
    reservation = await withSerializableAiTransaction(async (tx) => {
      const duplicate = await tx.aiRun.findUnique({
        where: { createdById_requestKey: { createdById: s.userId, requestKey: data.requestKey } },
        select: reliableAiRunSelect,
      });
      if (duplicate) throw new ExistingAiRunReservationError(duplicate);
      const lease = await createAiRunLeaseWithDbClock(tx);
      const externalConfirmedAt = requestedRuntime.provider === 'openai' ? lease.leaseStartedAt : null;

      const currentAgent = await tx.aiAgent.findUniqueOrThrow({ where: { id: data.agentId } });
      const currentSnapshot = await tx.aiAgentConfigVersion.findUnique({
        where: { agentId_version: { agentId: currentAgent.id, version: currentAgent.configVersion } },
      });
      if (
        !currentAgent.active
        || currentAgent.configVersion !== requestedSnapshot.version
        || currentAgent.promptVersion !== currentSnapshot?.promptVersion
        || !currentSnapshot
        || !currentSnapshot.active
        || !isPrimaryOperationalAiAgent(currentSnapshot.code)
        || canonicalSha256(aiAgentConfigFingerprint(currentSnapshot)) !== canonicalSha256(aiAgentConfigFingerprint(requestedSnapshot))
      ) {
        throw new UserFacingActionError('Configurazione agente modificata prima dell’esecuzione. Ricarica la pagina.');
      }
      const liveRuntime = resolveAiAgentRuntime(currentAgent.provider, currentAgent.futureModel);
      const currentRuntime = resolveAiAgentRuntime(currentSnapshot.provider, currentSnapshot.model);
      if (
        liveRuntime.provider !== currentRuntime.provider
        || liveRuntime.model !== currentRuntime.model
        || currentRuntime.provider !== requestedRuntime.provider
        || currentRuntime.model !== requestedRuntime.model
      ) {
        throw new UserFacingActionError('Provider o modello agente modificato prima dell’esecuzione. Ricarica la pagina.');
      }

      let authorizedCategories = [] as readonly (typeof externalDataCategories)[number][];
      let permitMaterial: ReturnType<typeof prepareExternalAiPermit> | undefined;
      if (currentRuntime.provider === 'openai') {
        if (!hasPermission(s, 'ai.external.run') || !data.externalDataConfirmed) {
          throw new UserFacingActionError('Permesso e conferma esplicita sono obbligatori per OpenAI.');
        }
        const authorization = await assertExternalAiRunAllowed({
          userId: s.userId,
          permissionGranted: hasPermission(s, 'ai.external.run'),
          model: currentRuntime.model,
          dataCategories: externalDataCategories,
          confirmedAt: externalConfirmedAt,
          db: tx,
        });
        authorizedCategories = authorization.dataCategories;
        permitMaterial = prepareExternalAiPermit();
      }
      const run = await tx.aiRun.create({ data: {
        id: lease.runId,
        reliabilityVersion: AI_RUN_RELIABILITY_VERSION,
        agentId: currentSnapshot.agentId,
        agentConfigVersion: currentSnapshot.version,
        clientId: data.clientId,
        clientServiceId: data.clientServiceId,
        projectId: data.projectId,
        status: 'running',
        provider: currentRuntime.provider,
        model: currentRuntime.model,
        promptVersion: currentSnapshot.promptVersion,
        requestKey: data.requestKey,
        requestFingerprint,
        leaseExpiresAt: lease.leaseExpiresAt,
        leaseTokenHash: lease.leaseTokenHash,
        egressPermitHash: permitMaterial?.egressPermitHash ?? null,
        externalPayloadHash,
        externalConfirmedAt: currentRuntime.provider === 'openai' ? externalConfirmedAt : null,
        externalDataCategories: currentRuntime.provider === 'openai' ? [...authorizedCategories] : Prisma.DbNull,
        input: currentRuntime.provider === 'openai' ? Prisma.DbNull : input as Prisma.InputJsonValue,
        operationalInstructions: currentRuntime.provider === 'openai' ? null : operationalInstructions,
        createdById: s.userId,
        createdAt: lease.leaseStartedAt,
      } });
      await tx.auditLog.create({ data: {
        actorId: s.userId,
        event: 'ai_agent_run_reserved',
        entityType: 'AiRun',
        entityId: run.id,
        after: {
          aiRunId: run.id,
          agentId: currentSnapshot.agentId,
          agentCode: currentSnapshot.code,
          clientId: data.clientId,
          clientServiceId: data.clientServiceId ?? null,
          projectId: data.projectId ?? null,
          provider: currentRuntime.provider,
          model: currentRuntime.model,
          promptVersion: currentSnapshot.promptVersion,
          configVersion: currentSnapshot.version,
          externalConfirmedAt: currentRuntime.provider === 'openai' ? externalConfirmedAt : null,
          externalDataCategories: currentRuntime.provider === 'openai' ? authorizedCategories : [],
          reliabilityVersion: AI_RUN_RELIABILITY_VERSION,
          status: 'running',
        },
      } });
      const externalPermit = permitMaterial && externalPayloadHash
        ? await issueExternalAiPermit({
            seed: permitMaterial.seed,
            lease: lease.lease,
            runId: run.id,
            userId: s.userId,
            requestKey: data.requestKey,
            requestFingerprint,
            agentId: currentSnapshot.agentId,
            agentConfigVersion: currentSnapshot.version,
            model: currentRuntime.model,
            dataCategories: authorizedCategories,
            externalPayloadHash,
            db: tx,
          })
        : undefined;
      return { run, agent: currentSnapshot, runtime: currentRuntime, authorizedCategories, externalPermit, lease: lease.lease };
    });
  } catch (error) {
    const duplicate = error instanceof ExistingAiRunReservationError
      ? error.run
      : isUniqueConstraintError(error) ? await existingAiRunForRequest(s.userId, data.requestKey) : null;
    if (duplicate) return resolveExistingAiOutput(s, duplicate, requestFingerprint, 'ai.run');
    throw error;
  }
  const { run, agent, runtime: agentRuntime } = reservation;

  try {
    // A reservation is not authority to egress forever: permissions and the
    // client relationship are checked once more immediately before execution.
    const executionSession = await requirePermission('ai.run');
    if (
      executionSession.userId !== s.userId
      || (agentRuntime.provider === 'openai' && !hasPermission(executionSession, 'ai.external.run'))
    ) {
      throw new UserFacingActionError('Autorizzazioni AI revocate prima dell’esecuzione.');
    }
    await requireClientContextReadAccess(executionSession, data);
  } catch (error) {
    await markAiRunFailedBestEffort({
      runId: run.id,
      lease: reservation.lease,
      actorId: s.userId,
      event: 'ai_agent_run_access_revoked',
      errorCode: 'AI_CLIENT_ACCESS_REVOKED',
      trace: {
        aiRunId: run.id,
        agentId: agent.agentId,
        clientId: data.clientId,
        clientServiceId: data.clientServiceId ?? null,
        projectId: data.projectId ?? null,
      },
    });
    throw error;
  }

  let draft;
  try {
    draft = await agentRuntime.adapter.run(
      aiAgentSnapshotRuntime(agent),
      providerInput,
      reservation.externalPermit,
    );
  } catch (error) {
    await markAiRunFailedBestEffort({
      runId: run.id,
      lease: reservation.lease,
      actorId: s.userId,
      event: 'ai_agent_run_failed',
      errorCode: error instanceof AiProviderCallError
        ? error.errorCode
        : error instanceof UserFacingActionError ? 'AI_PROVIDER_REJECTED' : 'AI_PROVIDER_FAILURE',
      trace: {
        aiRunId: run.id,
        agentId: agent.agentId,
        agentCode: agent.code,
        clientId: data.clientId,
        clientServiceId: data.clientServiceId ?? null,
        projectId: data.projectId ?? null,
        provider: agentRuntime.provider,
        model: agentRuntime.model,
        promptVersion: agent.promptVersion,
        configVersion: agent.version,
        externalConfirmedAt: run.externalConfirmedAt,
        externalDataCategories: reservation.authorizedCategories,
      },
      telemetry: aiProviderFailureMetadata(error),
    });
    if (error instanceof UserFacingActionError) throw error;
    throw new UserFacingActionError('Errore operativo durante l’esecuzione AI. Nessun output è stato salvato.');
  }
  const providerMetadata = aiProviderPersistenceMetadata(draft);
  try {
    const prepared = prepareAiOutput(draft);
    return await prisma.$transaction(async (tx) => {
      await completeAiRunWithLease(tx, reservation.lease, {
        output: aiRunOutputSummary(draft),
        telemetry: providerMetadata,
      });
      const output = await tx.aiOutput.create({ data: { aiRunId: run.id, clientId: data.clientId, clientServiceId: data.clientServiceId, projectId: data.projectId, title: prepared.title, content: prepared.content, status: prepared.forbiddenPhrases.length ? 'flagged' : 'needs_review', requiresHumanReview: true, forbiddenPhrases: prepared.forbiddenPhrases } });
      const trace = {
        aiRunId: run.id,
        outputId: output.id,
        agentId: agent.agentId,
        agentCode: agent.code,
        clientId: data.clientId,
        clientServiceId: data.clientServiceId ?? null,
        projectId: data.projectId ?? null,
        provider: agentRuntime.provider,
        model: agentRuntime.model,
        promptVersion: agent.promptVersion,
        configVersion: agent.version,
        externalConfirmedAt: run.externalConfirmedAt,
        externalDataCategories: reservation.authorizedCategories,
        inputTokens: providerMetadata.inputTokens,
        outputTokens: providerMetadata.outputTokens,
        totalTokens: providerMetadata.totalTokens,
        providerRequestId: providerMetadata.providerRequestId,
        status: 'completed',
        outputStatus: output.status,
      };
      await tx.auditLog.createMany({ data: [
        { actorId: s.userId, event: 'ai_agent_run', entityType: 'AiRun', entityId: run.id, after: trace },
        { actorId: s.userId, event: 'ai_output_generation', entityType: 'AiOutput', entityId: output.id, after: trace },
      ] });
      return output;
    });
  } catch {
    await markAiRunFailedBestEffort({
      runId: run.id,
      lease: reservation.lease,
      actorId: s.userId,
      event: 'ai_output_persistence_failed',
      errorCode: 'AI_OUTPUT_PERSISTENCE_FAILURE',
      trace: {
        aiRunId: run.id,
        agentId: agent.agentId,
        agentCode: agent.code,
        clientId: data.clientId,
        clientServiceId: data.clientServiceId ?? null,
        projectId: data.projectId ?? null,
        provider: agentRuntime.provider,
        model: agentRuntime.model,
        promptVersion: agent.promptVersion,
        configVersion: agent.version,
        externalConfirmedAt: run.externalConfirmedAt,
        externalDataCategories: reservation.authorizedCategories,
      },
      telemetry: providerMetadata,
    });
    throw new UserFacingActionError('Risposta AI ricevuta ma output non salvato correttamente. Riprova.');
  }
}

export async function runMockAgent(agentCode: string, input: unknown, requestKeyValue: string) {
  const s = await requirePermission('ai_agents.write');
  if (!hasGlobalAccess(s)) denyWriteAccess();
  await reconcileExpiredAiRuns({ actorId: s.userId });
  const requestKey = aiRequestKeySchema.parse(requestKeyValue);
  const prompt = typeof input === 'object' && input && typeof (input as { prompt?: unknown }).prompt === 'string'
    ? (input as { prompt: string }).prompt.trim()
    : '';
  if (!prompt || prompt.length > 2000) throw new UserFacingActionError('Il prompt mock deve contenere da 1 a 2000 caratteri.');
  const agent = await prisma.aiAgent.findUniqueOrThrow({ where: { code: agentCode } });
  if (!agent.active || !isPrimaryOperationalAiAgent(agent.code)) throw new UserFacingActionError('Agente AI non disponibile per il quick-run mock.');
  const snapshot = await prisma.aiAgentConfigVersion.findUnique({
    where: { agentId_version: { agentId: agent.id, version: agent.configVersion } },
  });
  if (!snapshot || !snapshot.active || snapshot.code !== agent.code || !isPrimaryOperationalAiAgent(snapshot.code)) {
    throw new UserFacingActionError('Snapshot immutabile dell’agente mock non disponibile. Esecuzione bloccata.');
  }
  const safeInput = { prompt: minimizeAiInstructions(prompt), source: 'CRM interno FAI', humanReviewRequired: true, context: {} };
  const snapshotRuntime = aiAgentSnapshotRuntime(snapshot);
  const exactMockBody = { agent: snapshotRuntime, input: safeInput };
  const requestFingerprint = createAiRequestFingerprint({
    kind: 'administrative_mock_quick_run_v1',
    requestKey,
    agentCode,
    provider: 'mock',
    model: 'mock-template-v1',
    agentConfig: aiAgentConfigFingerprint(snapshot),
    body: exactMockBody,
  });
  const existing = await existingAiRunForRequest(s.userId, requestKey);
  if (existing) return resolveExistingAiOutput(s, existing, requestFingerprint, 'ai_agents.write');

  let reservation;
  try {
    reservation = await withSerializableAiTransaction(async (tx) => {
      const duplicate = await tx.aiRun.findUnique({
        where: { createdById_requestKey: { createdById: s.userId, requestKey: requestKey } },
        select: reliableAiRunSelect,
      });
      if (duplicate) throw new ExistingAiRunReservationError(duplicate);
      const lease = await createAiRunLeaseWithDbClock(tx);

      const currentAgent = await tx.aiAgent.findUniqueOrThrow({ where: { id: agent.id } });
      const currentSnapshot = await tx.aiAgentConfigVersion.findUnique({
        where: { agentId_version: { agentId: currentAgent.id, version: currentAgent.configVersion } },
      });
      if (
        !currentAgent.active
        || currentAgent.configVersion !== snapshot.version
        || !currentSnapshot
        || !currentSnapshot.active
        || currentAgent.code !== currentSnapshot.code
        || !isPrimaryOperationalAiAgent(currentSnapshot.code)
        || canonicalSha256(aiAgentConfigFingerprint(currentSnapshot)) !== canonicalSha256(aiAgentConfigFingerprint(snapshot))
      ) {
        throw new UserFacingActionError('Configurazione agente modificata prima del quick-run. Ricarica la pagina.');
      }
      const run = await tx.aiRun.create({ data: {
        id: lease.runId,
        reliabilityVersion: AI_RUN_RELIABILITY_VERSION,
        agentId: currentSnapshot.agentId,
        agentConfigVersion: currentSnapshot.version,
        status: 'running',
        provider: 'mock',
        model: 'mock-template-v1',
        promptVersion: currentSnapshot.promptVersion,
        requestKey,
        requestFingerprint,
        leaseExpiresAt: lease.leaseExpiresAt,
        leaseTokenHash: lease.leaseTokenHash,
        input: safeInput,
        createdById: s.userId,
        createdAt: lease.leaseStartedAt,
      } });
      await tx.auditLog.create({ data: {
        actorId: s.userId,
        event: 'ai_mock_run_reserved',
        entityType: 'AiRun',
        entityId: run.id,
        after: {
          aiRunId: run.id,
          agentId: currentSnapshot.agentId,
          provider: 'mock',
          model: 'mock-template-v1',
          promptVersion: currentSnapshot.promptVersion,
          configVersion: currentSnapshot.version,
          reliabilityVersion: AI_RUN_RELIABILITY_VERSION,
          status: 'running',
        },
      } });
      return { run, snapshot: currentSnapshot, lease: lease.lease };
    });
  } catch (error) {
    const duplicate = error instanceof ExistingAiRunReservationError
      ? error.run
      : isUniqueConstraintError(error) ? await existingAiRunForRequest(s.userId, requestKey) : null;
    if (duplicate) return resolveExistingAiOutput(s, duplicate, requestFingerprint, 'ai_agents.write');
    throw error;
  }

  try {
    const executionSession = await requirePermission('ai_agents.write');
    if (executionSession.userId !== s.userId || !hasGlobalAccess(executionSession)) {
      throw new UserFacingActionError('Autorizzazioni quick-run revocate prima dell’esecuzione.');
    }
  } catch (error) {
    await markAiRunFailedBestEffort({
      runId: reservation.run.id,
      lease: reservation.lease,
      actorId: s.userId,
      event: 'ai_mock_run_access_revoked',
      errorCode: 'AI_RUNTIME_PERMISSION_REVOKED',
      trace: {
        aiRunId: reservation.run.id,
        agentId: reservation.snapshot.agentId,
        configVersion: reservation.snapshot.version,
      },
    });
    throw error;
  }

  let draft;
  try {
    draft = await new MockAiAdapter().run(aiAgentSnapshotRuntime(reservation.snapshot), safeInput);
  } catch (error) {
    await markAiRunFailedBestEffort({
      runId: reservation.run.id,
      lease: reservation.lease,
      actorId: s.userId,
      event: 'ai_mock_run_failed',
      errorCode: error instanceof UserFacingActionError ? 'AI_MOCK_REJECTED' : 'AI_MOCK_FAILURE',
      trace: {
        aiRunId: reservation.run.id,
        agentId: reservation.snapshot.agentId,
        configVersion: reservation.snapshot.version,
        provider: 'mock',
        model: 'mock-template-v1',
      },
    });
    if (error instanceof UserFacingActionError) throw error;
    throw new UserFacingActionError('Errore operativo durante il quick-run mock. Nessun output è stato salvato.');
  }

  const prepared = prepareAiOutput(draft);
  try {
    return await prisma.$transaction(async (tx) => {
      await completeAiRunWithLease(tx, reservation.lease, {
        output: aiRunOutputSummary(draft),
      });
      const createdOutput = await tx.aiOutput.create({ data: {
        aiRunId: reservation.run.id,
        title: prepared.title,
        content: prepared.content,
        status: prepared.forbiddenPhrases.length ? 'flagged' : 'needs_review',
        requiresHumanReview: true,
        forbiddenPhrases: prepared.forbiddenPhrases,
      } });
      await tx.auditLog.create({ data: {
        actorId: s.userId,
        event: 'ai_mock_generation',
        entityType: 'AiOutput',
        entityId: createdOutput.id,
        after: {
          outputId: createdOutput.id,
          aiRunId: reservation.run.id,
          agentId: reservation.snapshot.agentId,
          provider: 'mock',
          model: 'mock-template-v1',
          promptVersion: reservation.snapshot.promptVersion,
          configVersion: reservation.snapshot.version,
          status: createdOutput.status,
        },
      } });
      return createdOutput;
    });
  } catch (error) {
    await markAiRunFailedBestEffort({
      runId: reservation.run.id,
      lease: reservation.lease,
      actorId: s.userId,
      event: 'ai_mock_output_persistence_failed',
      errorCode: 'AI_OUTPUT_PERSISTENCE_FAILURE',
      trace: {
        aiRunId: reservation.run.id,
        agentId: reservation.snapshot.agentId,
        configVersion: reservation.snapshot.version,
        provider: 'mock',
        model: 'mock-template-v1',
      },
    });
    if (error instanceof UserFacingActionError) throw error;
    throw new UserFacingActionError('Bozza mock ricevuta ma output non salvato correttamente. Ricarica la pagina.');
  }
}

function hydratedAiPolicyContext(context: Awaited<ReturnType<typeof requireAiOutputReadAccess>>) {
  return {
    ...context.output,
    run: context.run,
    client: context.client,
    project: context.project,
    clientService: context.clientService,
  };
}

export async function reviewAiOutput(id: string) {
  const s = await requirePermission('ai.review');
  const data = aiOutputApprovalSchema.parse({ id });
  const context = await requireAiOutputReadAccess(s, data.id);
  const current = context.output;
  if (!canReviewAiOutput(s, hydratedAiPolicyContext(context))) throw new UserFacingActionError('Output non revisionabile: verifica stato, contesto e separazione dal generatore.');
  if (scanForbiddenPhrases(`${current.title}\n${current.content}`).length) throw new UserFacingActionError('Output non conforme: non può superare la revisione.');
  const now = nextConcurrencyTimestamp(current.updatedAt);
  return prisma.$transaction(async (tx) => {
    const result = await tx.aiOutput.updateMany({
      where: { id: data.id, aiRunId: current.aiRunId, status: 'needs_review', requiresHumanReview: true, reviewedById: null, reviewedAt: null, approvedById: null, approvedAt: null, updatedAt: current.updatedAt },
      data: { reviewedById: s.userId, reviewedAt: now, updatedAt: now },
    });
    if (result.count !== 1) throw new UserFacingActionError('Output già revisionato o modificato da un altro operatore.');
    const output = await tx.aiOutput.findUniqueOrThrow({ where: { id: data.id } });
    await tx.auditLog.create({ data: {
      actorId: s.userId,
      event: 'ai_output_review',
      entityType: 'AiOutput',
      entityId: output.id,
      after: { outputId: output.id, aiRunId: output.aiRunId, fromStatus: current.status, toStatus: output.status, reviewedById: s.userId },
    } });
    return output;
  });
}

export async function approveAiOutput(id: string) {
  const s = await requirePermission('ai.approve');
  const data = aiOutputApprovalSchema.parse({ id });
  const context = await requireAiOutputReadAccess(s, data.id);
  const current = context.output;
  if (!canApproveAiOutput(s, hydratedAiPolicyContext(context))) throw new UserFacingActionError('Output non approvabile: serve una revisione valida, indipendente dal generatore.');
  if (scanForbiddenPhrases(`${current.title}\n${current.content}`).length) throw new UserFacingActionError('Output non conforme: non può essere approvato.');
  if (!current.reviewedById || !current.reviewedAt) throw new UserFacingActionError('Output non approvabile: revisione non valida.');
  const now = nextConcurrencyTimestamp(current.updatedAt);
  return prisma.$transaction(async (tx) => {
    const result = await tx.aiOutput.updateMany({
      where: {
        id: data.id,
        aiRunId: current.aiRunId,
        status: 'needs_review',
        requiresHumanReview: true,
        reviewedById: current.reviewedById,
        reviewedAt: current.reviewedAt,
        approvedById: null,
        approvedAt: null,
        updatedAt: current.updatedAt,
        NOT: { reviewedById: s.userId },
      },
      data: { status: 'approved', approvedById: s.userId, approvedAt: now, updatedAt: now },
    });
    if (result.count !== 1) throw new UserFacingActionError('Output già approvato o modificato da un altro operatore.');
    const output = await tx.aiOutput.findUniqueOrThrow({ where: { id: data.id } });
    const trace = { outputId: output.id, aiRunId: output.aiRunId, fromStatus: current.status, toStatus: output.status, reviewedById: current.reviewedById, approvedById: s.userId };
    await tx.auditLog.createMany({ data: [
      { actorId: s.userId, event: 'ai_output_status_change', entityType: 'AiOutput', entityId: output.id, after: trace },
      { actorId: s.userId, event: 'ai_approval', entityType: 'AiOutput', entityId: output.id, after: trace },
    ] });
    return output;
  });
}

export async function createTechnicalPractice(form: FormData) {
  const s = await requirePermission('technical.write');
  const raw = clean(form);
  const data = technicalPracticeSchema.parse(raw);
  const statusFieldsSubmitted = ['status', 'submittedAt', 'protocolNumber', 'integrationRequestNote', 'clientVisibleStatus', 'nextClientUpdateAt', 'lastClientUpdateAt']
    .some((field) => Object.hasOwn(raw, field));
  if (statusFieldsSubmitted && !hasPermission(s, 'technical.status')) denyWriteAccess();
  await requireClientContextWriteAccess(s, data, { allowBackofficeClient: true });
  await Promise.all([
    requireActiveUser(data.commercialOwnerId, ['admin', 'direzione', 'commerciale']),
    requireActiveUser(data.technicalOwnerId, ['admin', 'direzione', 'consulente', 'backoffice']),
  ]);
  if (!hasPermission(s, 'technical.assign')) {
    if (data.commercialOwnerId || (data.technicalOwnerId && data.technicalOwnerId !== s.userId)) denyWriteAccess();
  }
  const technicalOwnerId = data.technicalOwnerId ?? (s.role === 'consulente' ? s.userId : undefined);
  const practice = await prisma.technicalPractice.create({ data: { ...data, technicalOwnerId, createdById: s.userId } as never });
  await audit(s.userId, 'technical_practice_create', 'TechnicalPractice', practice.id, practice);
  return practice;
}

const technicalPracticeComparableFields = [
  'clientId',
  'projectId',
  'clientServiceId',
  'commercialOwnerId',
  'technicalOwnerId',
  'title',
  'practiceType',
  'targetEntity',
  'targetPortal',
  'status',
  'priority',
  'dueDate',
  'submittedAt',
  'protocolNumber',
  'integrationRequestNote',
  'internalNotes',
  'clientVisibleStatus',
  'nextClientUpdateAt',
  'lastClientUpdateAt',
] as const;

type TechnicalPracticeComparableField = (typeof technicalPracticeComparableFields)[number];
const technicalStatusControlledFields = [
  'status',
  'submittedAt',
  'protocolNumber',
  'integrationRequestNote',
  'clientVisibleStatus',
  'nextClientUpdateAt',
  'lastClientUpdateAt',
] as const satisfies readonly TechnicalPracticeComparableField[];

function comparableValue(value: unknown) {
  return value instanceof Date ? value.getTime() : value ?? null;
}

function hasTechnicalPracticeChanges(before: Record<TechnicalPracticeComparableField, unknown>, after: Record<TechnicalPracticeComparableField, unknown>) {
  return technicalPracticeComparableFields.some((field) => comparableValue(before[field]) !== comparableValue(after[field]));
}

export async function updateTechnicalPractice(form: FormData) {
  const s = await requirePermission('technical.write');
  const raw = clean(form);
  const data = technicalPracticeUpdateSchema.parse(raw);
  const before = await requireTechnicalPracticeEditAccess(s, data.id);
  const nextProjectId = data.projectId ?? before.projectId;
  const nextClientServiceId = data.clientServiceId ?? before.clientServiceId;
  await requireClientContextWriteAccess(s, { clientId: data.clientId, projectId: nextProjectId, clientServiceId: nextClientServiceId }, { allowBackofficeClient: true });
  const ownerChanged = (data.commercialOwnerId !== undefined && data.commercialOwnerId !== before.commercialOwnerId)
    || (data.technicalOwnerId !== undefined && data.technicalOwnerId !== before.technicalOwnerId);
  if (ownerChanged && !hasPermission(s, 'technical.assign')) denyWriteAccess();
  if (ownerChanged) {
    await Promise.all([
      requireActiveUser(data.commercialOwnerId, ['admin', 'direzione', 'commerciale']),
      requireActiveUser(data.technicalOwnerId, ['admin', 'direzione', 'consulente', 'backoffice']),
    ]);
  }
  const parsedFields = data as unknown as Record<TechnicalPracticeComparableField, unknown>;
  const statusControlledChange = technicalStatusControlledFields.some((field) =>
    Object.hasOwn(raw, field) && comparableValue(parsedFields[field]) !== comparableValue(before[field]),
  );
  if (statusControlledChange && !hasPermission(s, 'technical.status')) denyWriteAccess();
  const updateData = { ...data, id: undefined, createdById: before.createdById, status: Object.hasOwn(raw, 'status') ? data.status : before.status };
  if (!hasTechnicalPracticeChanges(before, { ...before, ...updateData })) return before;
  const practice = await prisma.technicalPractice.update({ where: { id: data.id }, data: updateData as never });
  await audit(s.userId, 'technical_practice_update', 'TechnicalPractice', practice.id, { before, after: practice });
  if (before.status !== practice.status) await audit(s.userId, 'technical_practice_status_change', 'TechnicalPractice', practice.id, { before, after: practice });
  return practice;
}

export async function updateTechnicalPracticeStatus(form: FormData) {
  const s = await requirePermission('technical.status');
  const data = technicalPracticeStatusUpdateSchema.parse(clean(form));
  const before = await requireTechnicalPracticeEditAccess(s, data.id);
  const updateData = { status: data.status, clientVisibleStatus: data.clientVisibleStatus, submittedAt: data.submittedAt ?? before.submittedAt, protocolNumber: data.protocolNumber, integrationRequestNote: data.integrationRequestNote, lastClientUpdateAt: data.lastClientUpdateAt, nextClientUpdateAt: data.nextClientUpdateAt };
  if (!hasTechnicalPracticeChanges(before, { ...before, ...updateData })) return before;
  const practice = await prisma.technicalPractice.update({ where: { id: data.id }, data: updateData });
  if (before.status !== practice.status) {
    await audit(s.userId, 'technical_practice_status_change', 'TechnicalPractice', practice.id, { before, after: practice });
  } else {
    await audit(s.userId, 'technical_practice_update', 'TechnicalPractice', practice.id, { before, after: practice });
  }
  return practice;
}

export async function assignTechnicalPractice(form: FormData) {
  const s = await requirePermission('technical.assign');
  const data = technicalPracticeAssignSchema.parse(clean(form));
  const before = await requireTechnicalPracticeEditAccess(s, data.id);
  await Promise.all([
    requireActiveUser(data.commercialOwnerId, ['admin', 'direzione', 'commerciale']),
    requireActiveUser(data.technicalOwnerId, ['admin', 'direzione', 'consulente', 'backoffice']),
  ]);
  const practice = await prisma.technicalPractice.update({ where: { id: data.id }, data: { commercialOwnerId: data.commercialOwnerId ?? null, technicalOwnerId: data.technicalOwnerId ?? null } });
  await audit(s.userId, 'technical_practice_assign', 'TechnicalPractice', practice.id, { before, after: practice });
  return practice;
}

export async function archiveTechnicalPractice(form: FormData) {
  const s = await requirePermission('technical.write');
  if (!hasPermission(s, 'technical.status')) denyWriteAccess();
  const data = technicalPracticeIdSchema.parse(clean(form));
  const before = await requireTechnicalPracticeEditAccess(s, data.id);
  const practice = await prisma.technicalPractice.update({ where: { id: data.id }, data: { status: 'archiviata', deletedAt: new Date() } });
  await audit(s.userId, 'technical_practice_archive', 'TechnicalPractice', practice.id, { before, after: practice });
  return practice;
}


async function getPracticeForCommunication(technicalPracticeId: string, session: AuthSession) {
  const { practice, client } = await requireTechnicalPracticeViewAccess(session, technicalPracticeId);
  return { practice, client };
}

async function getActivePracticeCommunication(id: string) {
  const communication = await prisma.practiceCommunication.findFirst({ where: { id, deletedAt: null } });
  if (!communication) denyWriteAccess();
  return communication;
}

export async function createPracticeCommunicationDraft(form: FormData) {
  const s = await requirePermission('practice_communications.write');
  const data = practiceCommunicationDraftSchema.parse(clean(form));
  const practice = await requireTechnicalPracticeEditAccess(s, data.technicalPracticeId);
  const communication = await prisma.practiceCommunication.create({ data: {
    technicalPracticeId: practice.id, clientId: practice.clientId, projectId: practice.projectId, clientServiceId: practice.clientServiceId,
    commercialOwnerId: practice.commercialOwnerId, technicalOwnerId: practice.technicalOwnerId, type: data.type, channel: data.channel, status: data.status,
    title: data.title, content: data.content, internalNote: data.internalNote, createdById: s.userId,
  } });
  await audit(s.userId, 'practice_communication_draft_create', 'PracticeCommunication', communication.id, communication);
  return communication;
}

export async function updatePracticeCommunicationDraft(form: FormData) {
  const s = await requirePermission('practice_communications.write');
  const data = practiceCommunicationUpdateSchema.parse(clean(form));
  const before = await getActivePracticeCommunication(data.id);
  if (!['bozza','da_revisionare'].includes(before.status)) throw new UserFacingActionError('Solo bozze o comunicazioni da revisionare possono essere modificate.');
  await requireTechnicalPracticeEditAccess(s, before.technicalPracticeId);
  const communication = await prisma.practiceCommunication.update({ where: { id: data.id }, data: { type: data.type, channel: data.channel, status: data.status, title: data.title, content: data.content, internalNote: data.internalNote } });
  await audit(s.userId, 'practice_communication_draft_update', 'PracticeCommunication', communication.id, { before, after: communication });
  return communication;
}

export async function approvePracticeCommunicationDraft(form: FormData) {
  const s = await requirePermission('practice_communications.review');
  const data = practiceCommunicationIdSchema.parse(clean(form));
  const before = await getActivePracticeCommunication(data.id);
  await getPracticeForCommunication(before.technicalPracticeId, s);
  if (before.status !== 'da_revisionare' || before.createdById === s.userId) denyWriteAccess();
  const communication = await prisma.practiceCommunication.update({ where: { id: data.id }, data: { status: 'approvata', reviewedById: s.userId, reviewedAt: new Date() } });
  await audit(s.userId, 'practice_communication_approve', 'PracticeCommunication', communication.id, { before, after: communication });
  return communication;
}

export async function markPracticeCommunicationAsUsed(form: FormData) {
  const s = await requirePermission('practice_communications.mark_used');
  const data = practiceCommunicationIdSchema.parse(clean(form));
  const before = await getActivePracticeCommunication(data.id);
  if (before.status !== 'approvata') throw new UserFacingActionError('Solo comunicazioni approvate possono essere segnate come usate/inviate manualmente.');
  const practice = await requireTechnicalPracticeEditAccess(s, before.technicalPracticeId);
  const now = new Date();
  const communication = await prisma.practiceCommunication.update({ where: { id: data.id }, data: { status: 'usata_inviata', usedAt: now } });
  if (communication.type === 'cliente') await prisma.technicalPractice.update({ where: { id: practice.id }, data: { lastClientUpdateAt: now } });
  await audit(s.userId, 'practice_communication_used', 'PracticeCommunication', communication.id, { before, after: communication });
  return communication;
}

export async function archivePracticeCommunication(form: FormData) {
  const s = await requirePermission('practice_communications.write');
  const data = practiceCommunicationIdSchema.parse(clean(form));
  const before = await getActivePracticeCommunication(data.id);
  if (hasPermission(s, 'practice_communications.review')) {
    await getPracticeForCommunication(before.technicalPracticeId, s);
  } else {
    await requireTechnicalPracticeEditAccess(s, before.technicalPracticeId);
  }
  const communication = await prisma.practiceCommunication.update({ where: { id: data.id }, data: { status: 'archiviata', deletedAt: new Date() } });
  await audit(s.userId, 'practice_communication_archive', 'PracticeCommunication', communication.id, { before, after: communication });
  return communication;
}
