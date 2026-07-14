'use server';
import type { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { clientServicePipelineSchema, clientDossierGenerateSchema, clientDossierUpdateSchema, clientDossierIdSchema, aiAgentConfigUpdateSchema, clientAiRunSchema, aiOutputDossierSchema, commercialOfferUpdateSchema } from './validation';
import { hasPermission, requirePermission, type AuthSession } from './auth';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { leadSchema, leadCommercialUpdateSchema, leadConvertSchema, commercialOfferSchema, clientSchema, projectSchema, documentUploadSchema, preAnalysisSchema, aiOutputApprovalSchema, companySchema, projectExpenseSchema, dossierSchema, contractSchema, paymentSchema, clientServiceSchema, serviceStatusSchema, documentServiceLinkSchema, documentChecklistItemSchema, checklistItemStatusUpdateSchema, checklistItemDocumentLinkSchema, checklistItemIdSchema, clientTaskSchema, taskUpdateSchema, taskIdSchema, technicalPracticeSchema, technicalPracticeUpdateSchema, technicalPracticeStatusUpdateSchema, technicalPracticeAssignSchema, technicalPracticeIdSchema, practiceCommunicationDraftSchema, practiceCommunicationUpdateSchema, practiceCommunicationIdSchema } from './validation';
import { prepareAiOutput, getAiAdapter, testAiProviderDiagnostic, normalizeAiProvider } from './ai';
import { buildClientServiceLabel } from './client-service-label';
import { sanitizeFileName, savePrivateDocumentFile } from './storage';
import { canViewClient, canViewDocument, isSensitiveDocument, hasGlobalAccess } from './access-control';
import { UserFacingActionError } from './action-errors';
import { AI_AGENT_CODES } from './ai-agent-configs';
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

export async function runAiProviderDiagnosticTest() {
  const s = await requirePermission('ai_agents.read');
  const result = await testAiProviderDiagnostic();
  await audit(s.userId, 'ai_provider_diagnostic_test', 'AiProvider', result.provider, {
    provider: result.provider,
    model: result.model,
    success: result.success,
    status: result.success ? 'ok' : 'failure',
  });
  const params = new URLSearchParams({ status: result.success ? 'ok' : 'error', message: result.message });
  redirect(`/settings/ai-diagnostics?${params.toString()}`);
}

export async function updateAiAgentConfig(form: FormData) {
  const s = await requirePermission('ai_agents.write');
  const raw = clean(form);
  const data = aiAgentConfigUpdateSchema.parse({ ...raw, active: form.has('active') });
  const before = await prisma.aiAgent.findUniqueOrThrow({ where: { id: data.id } });
  const agent = await prisma.aiAgent.update({ where: { id: data.id }, data: { systemPrompt: data.systemPrompt, active: data.active } });
  const promptChanged = before.systemPrompt !== agent.systemPrompt;
  const activeChanged = before.active !== agent.active;
  const events = ['ai_agent_config_update'];
  if (promptChanged) events.push('ai_agent_prompt_update');
  if (activeChanged) events.push(agent.active ? 'ai_agent_activate' : 'ai_agent_deactivate');
  await Promise.all(events.map((event) => audit(s.userId, event, 'AiAgent', agent.id, { before: { code: before.code, systemPrompt: before.systemPrompt, active: before.active }, after: { code: agent.code, systemPrompt: agent.systemPrompt, active: agent.active } })));
  revalidatePath('/settings/ai-agents');
  void agent;
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
  const client = await prisma.client.create({ data: { type: data.type, displayName, leadId: lead.id, salesOwnerId: lead.assignedToId ?? s.userId, notes: lead.notes } });
  const updated = await prisma.lead.update({ where: { id: lead.id }, data: { clientId: client.id, status: 'vinto' } });
  await audit(s.userId, 'lead_convert_to_client', 'Lead', lead.id, { before: lead, after: updated, client });
  return client;
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

async function assertClientDossierContext(session: Pick<AuthSession, 'userId' | 'role'>, clientId: string, clientServiceId?: string, projectId?: string) {
  const [client, service, project] = await Promise.all([
    prisma.client.findFirst({ where: { id: clientId, deletedAt: null }, select: { id: true, salesOwnerId: true, consultantId: true } }),
    clientServiceId ? prisma.clientService.findFirst({ where: { id: clientServiceId, clientId, deletedAt: null }, select: { id: true } }) : null,
    projectId ? prisma.project.findFirst({ where: { id: projectId, clientId, deletedAt: null }, select: { id: true } }) : null,
  ]);
  if (!client) throw new UserFacingActionError('Cliente non valido');
  if (!canViewClient(session, client)) throw new UserFacingActionError('Cliente non accessibile');
  if (clientServiceId && !service) throw new UserFacingActionError('Il servizio selezionato non appartiene al cliente scelto');
  if (projectId && !project) throw new UserFacingActionError('Il progetto selezionato non appartiene al cliente scelto');
}

async function buildClientDossierContent(clientId: string, clientServiceId?: string, projectId?: string) {
  const [agentConfig, client, companies, services, serviceCatalog, projects, checklist, documents, tasks] = await Promise.all([
    prisma.aiAgent.findUniqueOrThrow({ where: { code: AI_AGENT_CODES.dossierCliente } }),
    prisma.client.findUniqueOrThrow({ where: { id: clientId } }),
    prisma.company.findMany({ where: { clientId, deletedAt: null }, orderBy: { updatedAt: 'desc' } }),
    prisma.clientService.findMany({ where: { clientId, ...(clientServiceId ? { id: clientServiceId } : {}), deletedAt: null }, orderBy: { updatedAt: 'desc' } }),
    prisma.serviceCatalog.findMany(),
    prisma.project.findMany({ where: { clientId, ...(projectId ? { id: projectId } : {}), deletedAt: null }, orderBy: { updatedAt: 'desc' } }),
    prisma.documentChecklistItem.findMany({ where: { clientId, ...(clientServiceId ? { clientServiceId } : {}), ...(projectId ? { projectId } : {}), active: true, deletedAt: null }, orderBy: { createdAt: 'asc' } }),
    prisma.document.findMany({ where: { clientId, ...(clientServiceId ? { clientServiceId } : {}), ...(projectId ? { projectId } : {}), deletedAt: null }, select: { id: true, title: true, documentCategory: true, status: true, containsSensitiveData: true, createdAt: true }, orderBy: { createdAt: 'desc' } }),
    prisma.task.findMany({ where: { clientId, ...(clientServiceId ? { clientServiceId } : {}), ...(projectId ? { projectId } : {}), status: { in: ['aperta','in_lavorazione'] }, deletedAt: null }, orderBy: [{ dueAt: 'asc' }, { updatedAt: 'desc' }] }),
  ]);
  if (!agentConfig.active) throw new UserFacingActionError(`Agente ${AI_AGENT_CODES.dossierCliente} disattivato: riattivarlo da Impostazioni > Agenti AI per generare il dossier.`);
  const catalogName = (id: string) => serviceCatalog.find((s) => s.id === id)?.name ?? 'Servizio FAI';
  const mainCompany = companies[0];
  return [
    '# Dossier / Pre-analisi', '', '## Configurazione agente FAI', dossierLine('Agente', agentConfig?.name ?? 'dossier_cliente'), dossierLine('Provider', agentConfig?.provider ?? 'mock'), dossierLine('Stato agente', 'attivo'), '### Istruzioni operative agente', agentConfig?.systemPrompt || 'Generazione mock/template con revisione umana obbligatoria.', '',
    '## 1. Dati cliente', dossierLine('Cliente', client.displayName), dossierLine('Tipologia', client.type), dossierLine('Stato fascicolo', client.status), dossierLine('Note cliente', client.notes), mainCompany ? dossierLine('Azienda principale', `${mainCompany.name}${mainCompany.vatNumber ? ` · P.IVA ${mainCompany.vatNumber}` : ''}`) : '- Azienda principale: —', '',
    '## 2. Inquadramento attività', companies.length ? companies.map((c) => `- ${c.name}: ${[c.legalForm, c.atecoCode, c.atecoDescription, c.city, c.province].filter(Boolean).join(' · ') || 'dati da completare'}`).join('\n') : '- Dati aziendali non ancora completi.', '',
    '## 3. Obiettivo richiesto', services.length ? services.map((s) => `- ${catalogName(s.serviceCatalogId)} · pratica: ${s.practiceType ?? '—'} · importo richiesto: ${money(s.requestedAmount)} · investimento previsto: ${money(s.plannedInvestment)}`).join('\n') : '- Nessun servizio/pratica collegato.', projects.length ? projects.map((p) => `- Progetto ${p.title}: richiesto ${money(p.requestedAmount)}, investimento ${money(p.totalInvestment)}, stato ${p.status}.`).join('\n') : '- Nessun progetto di investimento collegato.', '',
    '## 4. Stato documentale', checklist.length ? checklist.map((i) => `- ${i.title}: ${i.status.replaceAll('_', ' ')}${i.documentId ? ' · documento collegato' : ''}${i.notes ? ` · ${i.notes}` : ''}`).join('\n') : '- Checklist documentale non ancora popolata.', documents.length ? documents.map((d) => `- Documento caricato: ${d.title} (${d.documentCategory}, stato ${d.status})`).join('\n') : '- Nessun documento caricato.', '',
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
  const output = await prisma.aiOutput.findUniqueOrThrow({ where: { id: data.id } });
  if (!output.clientId) throw new UserFacingActionError('Output AI non collegato a un cliente: impossibile creare la bozza dossier.');
  if (output.status !== 'approved') throw new UserFacingActionError('Solo output AI approvati/revisionati possono generare una bozza dossier.');

  const [run, client, service, project] = await Promise.all([
    prisma.aiRun.findUniqueOrThrow({ where: { id: output.aiRunId } }),
    prisma.client.findFirst({ where: { id: output.clientId, deletedAt: null } }),
    output.clientServiceId ? prisma.clientService.findFirst({ where: { id: output.clientServiceId, clientId: output.clientId, deletedAt: null } }) : null,
    output.projectId ? prisma.project.findFirst({ where: { id: output.projectId, clientId: output.clientId, deletedAt: null } }) : null,
  ]);
  if (!client) throw new UserFacingActionError('Cliente collegato all’output non valido.');
  if (!canViewClient(s, client)) throw new UserFacingActionError('Cliente non accessibile.');
  if (output.clientServiceId && !service) throw new UserFacingActionError('Servizio collegato all’output non valido o non accessibile.');
  if (output.projectId && !project) throw new UserFacingActionError('Progetto collegato all’output non valido o non accessibile.');

  const agent = await prisma.aiAgent.findUnique({ where: { id: run.agentId } });
  const agentName = agent?.name ?? run.agentId;
  const title = `Bozza da output AI - ${agentName} - ${new Date().toLocaleDateString('it-IT')}`;
  const dossier = await prisma.clientDossier.create({
    data: {
      clientId: output.clientId,
      clientServiceId: output.clientServiceId,
      projectId: output.projectId,
      type: dossierTypeForAgent(agent?.code),
      title,
      content: buildAiOutputDossierContent({
        clientName: client.displayName,
        agentName,
        agentCode: agent?.code,
        generatedAt: output.createdAt,
        serviceLabel: buildClientServiceLabel(service, service ? await prisma.serviceCatalog.findUnique({ where: { id: service.serviceCatalogId } }) : null),
        projectTitle: project?.title,
        outputContent: output.content,
      }),
      createdById: s.userId,
      updatedById: s.userId,
    } as never,
  });
  await audit(s.userId, 'client_dossier_create_from_ai_output', 'ClientDossier', dossier.id, { outputId: output.id, dossierId: dossier.id, clientId: output.clientId, clientServiceId: output.clientServiceId, projectId: output.projectId, aiRunId: output.aiRunId, agentId: run.agentId, userId: s.userId });
  await audit(s.userId, 'ai_output_to_client_dossier', 'AiOutput', output.id, { outputId: output.id, dossierId: dossier.id, clientId: output.clientId, clientServiceId: output.clientServiceId, projectId: output.projectId, userId: s.userId });
  return dossier;
}

export async function generateClientDossier(form: FormData) {
  const s = await requirePermission('dossier.write');
  const data = clientDossierGenerateSchema.parse(clean(form));
  await assertClientDossierContext(s, data.clientId, data.clientServiceId, data.projectId);
  const content = await buildClientDossierContent(data.clientId, data.clientServiceId, data.projectId);
  const dossier = await prisma.clientDossier.create({ data: { clientId: data.clientId, clientServiceId: data.clientServiceId, projectId: data.projectId, type: data.type, title: data.title ?? `${dossierTypeLabel[data.type]} — ${new Date().toLocaleDateString('it-IT')}`, content, createdById: s.userId, updatedById: s.userId } as never });
  await audit(s.userId, 'client_dossier_generate', 'ClientDossier', dossier.id, { dossierId: dossier.id, clientId: dossier.clientId, clientServiceId: dossier.clientServiceId, projectId: dossier.projectId, type: dossier.type, status: dossier.status });
  return dossier;
}

export async function updateClientDossier(form: FormData) {
  const s = await requirePermission('dossier.write');
  const data = clientDossierUpdateSchema.parse(clean(form));
  const before = await prisma.clientDossier.findUniqueOrThrow({ where: { id: data.id } });
  await assertClientDossierContext(s, before.clientId, before.clientServiceId ?? undefined, before.projectId ?? undefined);
  const dossier = await prisma.clientDossier.update({ where: { id: data.id }, data: { title: data.title, type: data.type, status: data.status, content: data.content, updatedById: s.userId, archivedAt: data.status === 'archiviata' ? (before.archivedAt ?? new Date()) : null, archivedById: data.status === 'archiviata' ? s.userId : null } });
  await audit(s.userId, before.status !== 'archiviata' && dossier.status === 'archiviata' ? 'client_dossier_archive' : 'client_dossier_update', 'ClientDossier', dossier.id, { before, after: dossier });
  return dossier;
}

export async function archiveClientDossier(form: FormData) {
  const s = await requirePermission('dossier.write');
  const data = clientDossierIdSchema.parse(clean(form));
  const before = await prisma.clientDossier.findUniqueOrThrow({ where: { id: data.id } });
  await assertClientDossierContext(s, before.clientId, before.clientServiceId ?? undefined, before.projectId ?? undefined);
  const dossier = await prisma.clientDossier.update({ where: { id: data.id }, data: { status: 'archiviata', archivedAt: before.archivedAt ?? new Date(), archivedById: s.userId, updatedById: s.userId } });
  await audit(s.userId, 'client_dossier_archive', 'ClientDossier', dossier.id, { before, after: dossier });
  return dossier;
}

export async function auditClientDossierExport(id: string, format: 'markdown' | 'docx' = 'markdown') {
  const s = await requirePermission('dossier.read');
  const dossier = await prisma.clientDossier.findUniqueOrThrow({ where: { id } });
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
  const data = clientAiRunSchema.parse(clean(form));
  const agent = await prisma.aiAgent.findUniqueOrThrow({ where: { id: data.agentId } });
  if (!agent.active) throw new UserFacingActionError('Agente AI disattivato: esecuzione non consentita.');

  const client = await prisma.client.findFirst({ where: { id: data.clientId, deletedAt: null } });
  if (!client || !canViewClient(s, client)) throw new UserFacingActionError('Cliente non accessibile');

  const [companies, clientService, project, checklist, tasks, documents, clientDossiers, legacyDossiers, serviceCatalog] = await Promise.all([
    prisma.company.findMany({ where: { clientId: data.clientId, deletedAt: null }, orderBy: { updatedAt: 'desc' } }),
    data.clientServiceId ? prisma.clientService.findFirst({ where: { id: data.clientServiceId, clientId: data.clientId, deletedAt: null } }) : null,
    data.projectId ? prisma.project.findFirst({ where: { id: data.projectId, clientId: data.clientId, deletedAt: null } }) : null,
    prisma.documentChecklistItem.findMany({ where: { clientId: data.clientId, clientServiceId: data.clientServiceId || undefined, projectId: data.projectId || undefined, deletedAt: null, active: true }, orderBy: { updatedAt: 'desc' } }),
    prisma.task.findMany({ where: { clientId: data.clientId, clientServiceId: data.clientServiceId || undefined, projectId: data.projectId || undefined, deletedAt: null }, orderBy: { dueAt: 'asc' }, take: 25 }),
    prisma.document.findMany({ where: { clientId: data.clientId, clientServiceId: data.clientServiceId || undefined, projectId: data.projectId || undefined, deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.clientDossier.findMany({ where: { clientId: data.clientId, clientServiceId: data.clientServiceId || undefined, projectId: data.projectId || undefined }, orderBy: { updatedAt: 'desc' }, take: 10 }),
    prisma.dossier.findMany({ where: { clientId: data.clientId, projectId: data.projectId || undefined }, orderBy: { updatedAt: 'desc' }, take: 10 }),
    prisma.serviceCatalog.findMany(),
  ]);
  if (data.clientServiceId && !clientService) throw new UserFacingActionError('La pratica selezionata non appartiene al cliente');
  if (data.projectId && !project) throw new UserFacingActionError('Il progetto selezionato non appartiene al cliente');

  const safeDocuments = documents.map(({ storagePath: _storagePath, checksum: _checksum, ...document }) => document);
  const input = JSON.parse(JSON.stringify({
    source: 'CRM interno FAI',
    humanReviewRequired: true,
    operationalInstructions: data.operationalInstructions,
    context: { client, companies, clientService, serviceCatalog, project, checklist, tasks, documents: safeDocuments, clientDossiers, legacyDossiers },
  }));
  let draft;
  try {
    draft = await getAiAdapter().run({ code: agent.code, role: agent.name, systemPrompt: agent.systemPrompt }, input);
  } catch (error) {
    await audit(s.userId, 'ai_agent_run_failed', 'AiAgent', agent.id, { agentId: agent.id, agentCode: agent.code, clientId: data.clientId, clientServiceId: data.clientServiceId, projectId: data.projectId, provider: normalizeAiProvider(), error: error instanceof Error ? error.message : 'Errore AI sconosciuto' });
    throw error;
  }
  const prepared = prepareAiOutput(draft);
  const run = await prisma.aiRun.create({ data: { agentId: agent.id, clientId: data.clientId, clientServiceId: data.clientServiceId, projectId: data.projectId, input: input as Prisma.InputJsonValue, output: draft as Prisma.InputJsonValue, operationalInstructions: data.operationalInstructions, createdById: s.userId } });
  const output = await prisma.aiOutput.create({ data: { aiRunId: run.id, clientId: data.clientId, clientServiceId: data.clientServiceId, projectId: data.projectId, title: prepared.title, content: prepared.content, status: prepared.forbiddenPhrases.length ? 'flagged' : 'needs_review', requiresHumanReview: true, forbiddenPhrases: prepared.forbiddenPhrases } });
  await audit(s.userId, 'ai_agent_run', 'AiRun', run.id, { agentId: agent.id, agentCode: agent.code, clientId: data.clientId, clientServiceId: data.clientServiceId, projectId: data.projectId });
  await audit(s.userId, 'ai_output_generation', 'AiOutput', output.id, { outputId: output.id, aiRunId: run.id, agentId: agent.id, clientId: data.clientId, clientServiceId: data.clientServiceId, projectId: data.projectId });
  return output;
}

export async function runMockAgent(agentCode: string, input: unknown) { const s = await requirePermission('ai.run'); const agent = await prisma.aiAgent.findUniqueOrThrow({ where: { code: agentCode } }); if (!agent.active) throw new UserFacingActionError('Agente AI disattivato: esecuzione non consentita.'); const draft = await getAiAdapter().run({ code: agentCode, role: agent.name, systemPrompt: agent.systemPrompt }, input); const run = await prisma.aiRun.create({ data: { agentId: agent.id, input: input as object, output: draft as object, createdById: s.userId } }); const prepared = prepareAiOutput(draft); const output = await prisma.aiOutput.create({ data: { aiRunId: run.id, title: prepared.title, content: prepared.content, status: prepared.forbiddenPhrases.length ? 'flagged' : 'needs_review', requiresHumanReview: true, forbiddenPhrases: prepared.forbiddenPhrases } }); await audit(s.userId, 'ai_generation', 'AiOutput', output.id, output); return output; }
export async function approveAiOutput(id: string) { const s = await requirePermission('ai.approve'); const data = aiOutputApprovalSchema.parse({ id }); const current = await prisma.aiOutput.findUniqueOrThrow({ where: { id: data.id } }); if (!current.requiresHumanReview) throw new Error('AI output must require human review before approval'); const output = await prisma.aiOutput.update({ where: { id: data.id }, data: { status: 'approved', approvedById: s.userId, approvedAt: new Date(), reviewedById: s.userId, reviewedAt: new Date() } }); await audit(s.userId, 'ai_output_status_change', 'AiOutput', id, { before: current, after: output });
  await audit(s.userId, 'ai_approval', 'AiOutput', id, output); return output; }

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
