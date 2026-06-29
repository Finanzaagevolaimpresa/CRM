'use server';
import type { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { clientServicePipelineSchema } from './validation';
import { hasPermission, requirePermission } from './auth';
import { leadSchema, clientSchema, projectSchema, documentSchema, documentUploadSchema, preAnalysisSchema, aiOutputApprovalSchema, companySchema, projectExpenseSchema, dossierSchema, contractSchema, paymentSchema, clientServiceSchema, serviceStatusSchema, documentServiceLinkSchema, documentChecklistItemSchema, checklistItemStatusUpdateSchema, checklistItemDocumentLinkSchema, checklistItemIdSchema, clientTaskSchema, taskUpdateSchema, taskIdSchema } from './validation';
import { prepareAiOutput, getAiAdapter } from './ai';
import { sanitizeFileName, savePrivateDocumentFile } from './storage';
import { canViewDocument, isSensitiveDocument } from './access-control';
import { UserFacingActionError } from './action-errors';

function clean(form: FormData) { return Object.fromEntries([...form.entries()].filter(([, v]) => v !== '')); }
async function audit(actorId: string, event: string, entityType: string, entityId?: string, after?: unknown) { await prisma.auditLog.create({ data: { actorId, event, entityType, entityId, after: after as Prisma.InputJsonValue } }); }
export async function createLead(form: FormData) { const s = await requirePermission('lead.write'); const data = leadSchema.parse(clean(form)); const lead = await prisma.lead.create({ data }); await audit(s.userId, 'lead_create', 'Lead', lead.id, lead); return lead; }
export async function createClient(form: FormData) { const s = await requirePermission('client.write'); const data = clientSchema.parse(clean(form)); const client = await prisma.client.create({ data: data as never }); await audit(s.userId, 'client_create', 'Client', client.id, client); return client; }
export async function createCompany(form: FormData) { const s = await requirePermission('company.write'); const data = companySchema.parse(clean(form)); const company = await prisma.company.create({ data: data as never }); await audit(s.userId, 'company_create', 'Company', company.id, company); return company; }
export async function createProject(form: FormData) { const s = await requirePermission('project.write'); const data = projectSchema.parse(clean(form)); const project = await prisma.project.create({ data: data as never }); await audit(s.userId, 'project_create', 'Project', project.id, project); return project; }
export async function createProjectExpense(form: FormData) { const s = await requirePermission('project.write'); const data = projectExpenseSchema.parse(clean(form)); const expense = await prisma.projectExpense.create({ data: data as never }); await audit(s.userId, 'project_expense_create', 'ProjectExpense', expense.id, expense); return expense; }

export async function uploadDocument(form: FormData) {
  const s = await requirePermission('document.upload');
  const file = form.get('file');
  if (!(file instanceof File) || file.size <= 0) throw new UserFacingActionError('File obbligatorio');
  const parsed = documentUploadSchema.safeParse(clean(form));
  if (!parsed.success) throw new UserFacingActionError('Controlla i dati del documento: cliente, progetto e servizio devono essere coerenti.');
  const data = parsed.data;
  const [client, company, project, clientService] = await Promise.all([
    prisma.client.findFirst({ where: { id: data.clientId, deletedAt: null }, select: { id: true } }),
    data.companyId ? prisma.company.findFirst({ where: { id: data.companyId, clientId: data.clientId, deletedAt: null }, select: { id: true } }) : null,
    data.projectId ? prisma.project.findFirst({ where: { id: data.projectId, clientId: data.clientId, deletedAt: null }, select: { id: true } }) : null,
    data.clientServiceId ? prisma.clientService.findFirst({ where: { id: data.clientServiceId, clientId: data.clientId, deletedAt: null }, select: { id: true } }) : null,
  ]);
  if (!client) throw new UserFacingActionError('Cliente non valido');
  if (data.companyId && !company) throw new UserFacingActionError('L’azienda selezionata non appartiene al cliente scelto');
  if (data.projectId && !project) throw new UserFacingActionError('Il progetto selezionato non appartiene al cliente scelto');
  if (data.clientServiceId && !clientService) throw new UserFacingActionError('Il servizio selezionato non appartiene al cliente scelto');
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

async function assertChecklistContext(clientId: string, clientServiceId?: string, projectId?: string, documentId?: string) {
  const [client, service, project, document] = await Promise.all([
    prisma.client.findFirst({ where: { id: clientId, deletedAt: null }, select: { id: true } }),
    clientServiceId ? prisma.clientService.findFirst({ where: { id: clientServiceId, clientId, deletedAt: null }, select: { id: true } }) : null,
    projectId ? prisma.project.findFirst({ where: { id: projectId, clientId, deletedAt: null }, select: { id: true } }) : null,
    documentId ? prisma.document.findFirst({ where: { id: documentId, clientId, deletedAt: null }, select: { id: true } }) : null,
  ]);
  if (!client) throw new UserFacingActionError('Cliente non valido');
  if (clientServiceId && !service) throw new UserFacingActionError('Il servizio selezionato non appartiene al cliente scelto');
  if (projectId && !project) throw new UserFacingActionError('Il progetto selezionato non appartiene al cliente scelto');
  if (documentId && !document) throw new UserFacingActionError('Il documento selezionato non appartiene al cliente scelto');
}

export async function createDocumentChecklistItem(form: FormData) {
  const s = await requirePermission('service.write');
  const data = documentChecklistItemSchema.parse(clean(form));
  await assertChecklistContext(data.clientId, data.clientServiceId, data.projectId, data.documentId);
  const item = await prisma.documentChecklistItem.create({ data: { ...data, createdById: s.userId, updatedById: s.userId } as never });
  await audit(s.userId, 'document_checklist_item_create', 'DocumentChecklistItem', item.id, item);
  return item;
}

export async function createStandardDocumentChecklist(form: FormData) {
  const s = await requirePermission('service.write');
  const clientId = String(form.get('clientId') || '');
  const clientServiceId = String(form.get('clientServiceId') || '') || undefined;
  const projectId = String(form.get('projectId') || '') || undefined;
  await assertChecklistContext(clientId, clientServiceId, projectId);
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
  const before = await prisma.documentChecklistItem.findUniqueOrThrow({ where: { id: data.id } });
  const item = await prisma.documentChecklistItem.update({ where: { id: data.id }, data: { status: data.status, updatedById: s.userId } });
  await audit(s.userId, 'document_checklist_status_change', 'DocumentChecklistItem', item.id, { before, after: item });
  return item;
}

export async function linkDocumentToChecklistItem(form: FormData) {
  const s = await requirePermission('service.write');
  const data = checklistItemDocumentLinkSchema.parse(clean(form));
  const before = await prisma.documentChecklistItem.findUniqueOrThrow({ where: { id: data.id } });
  await assertChecklistContext(before.clientId, before.clientServiceId ?? undefined, before.projectId ?? undefined, data.documentId);
  const item = await prisma.documentChecklistItem.update({ where: { id: data.id }, data: { documentId: data.documentId, updatedById: s.userId } });
  await audit(s.userId, 'document_checklist_document_link', 'DocumentChecklistItem', item.id, { before, after: item });
  return item;
}

export async function unlinkDocumentFromChecklistItem(form: FormData) {
  const s = await requirePermission('service.write');
  const data = checklistItemIdSchema.parse(clean(form));
  const before = await prisma.documentChecklistItem.findUniqueOrThrow({ where: { id: data.id } });
  const item = await prisma.documentChecklistItem.update({ where: { id: data.id }, data: { documentId: null, updatedById: s.userId } });
  await audit(s.userId, 'document_checklist_document_unlink', 'DocumentChecklistItem', item.id, { before, after: item });
  return item;
}

export async function deactivateDocumentChecklistItem(form: FormData) {
  const s = await requirePermission('service.write');
  const data = checklistItemIdSchema.parse(clean(form));
  const before = await prisma.documentChecklistItem.findUniqueOrThrow({ where: { id: data.id } });
  const item = await prisma.documentChecklistItem.update({ where: { id: data.id }, data: { active: false, deletedAt: new Date(), updatedById: s.userId } });
  await audit(s.userId, 'document_checklist_item_deactivate', 'DocumentChecklistItem', item.id, { before, after: item });
  return item;
}

async function assertTaskContext(clientId: string, clientServiceId?: string, projectId?: string, assignedToId?: string) {
  const [client, service, project, assignee] = await Promise.all([
    prisma.client.findFirst({ where: { id: clientId, deletedAt: null }, select: { id: true } }),
    clientServiceId ? prisma.clientService.findFirst({ where: { id: clientServiceId, clientId, deletedAt: null }, select: { id: true } }) : null,
    projectId ? prisma.project.findFirst({ where: { id: projectId, clientId, deletedAt: null }, select: { id: true } }) : null,
    assignedToId ? prisma.user.findFirst({ where: { id: assignedToId, active: true }, select: { id: true } }) : null,
  ]);
  if (!client) throw new UserFacingActionError('Cliente non valido');
  if (clientServiceId && !service) throw new UserFacingActionError('Il servizio selezionato non appartiene al cliente scelto');
  if (projectId && !project) throw new UserFacingActionError('Il progetto selezionato non appartiene al cliente scelto');
  if (assignedToId && !assignee) throw new UserFacingActionError('Assegnatario non valido o non attivo');
}

export async function createClientTask(form: FormData) {
  const s = await requirePermission('service.write');
  const data = clientTaskSchema.parse(clean(form));
  await assertTaskContext(data.clientId, data.clientServiceId, data.projectId, data.assignedToId);
  const task = await prisma.task.create({ data: { ...data, createdById: s.userId } as never });
  await audit(s.userId, 'client_task_create', 'Task', task.id, task);
  return task;
}

export async function updateClientTask(form: FormData) {
  const s = await requirePermission('service.write');
  const data = taskUpdateSchema.parse(clean(form));
  const before = await prisma.task.findUniqueOrThrow({ where: { id: data.id } });
  await assertTaskContext(before.clientId ?? '', before.clientServiceId ?? undefined, before.projectId ?? undefined, data.assignedToId);
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
  const before = await prisma.task.findUniqueOrThrow({ where: { id: data.id } });
  const task = await prisma.task.update({ where: { id: data.id }, data: { status: 'completata', completedAt: new Date() } });
  await audit(s.userId, 'client_task_complete', 'Task', task.id, { before, after: task });
  return task;
}

export async function registerDocument(form: FormData) { const s = await requirePermission('document.upload'); const data = documentSchema.parse(clean(form)); const document = await prisma.document.create({ data: { ...data, uploadedById: s.userId } as never }); await audit(s.userId, 'document_upload', 'Document', document.id, document); return document; }
export async function createPreAnalysis(form: FormData) { const s = await requirePermission('project.write'); const data = preAnalysisSchema.parse(clean(form)); const pre = await prisma.preAnalysis.create({ data: data as never }); await audit(s.userId, 'preanalysis_create', 'PreAnalysis', pre.id, pre); return pre; }
export async function createDossier(form: FormData) { const s = await requirePermission('project.write'); const data = dossierSchema.parse(clean(form)); const dossier = await prisma.dossier.create({ data: { ...data, modifiedById: s.userId } as never }); await audit(s.userId, 'dossier_modify', 'Dossier', dossier.id, dossier); return dossier; }
export async function createContract(form: FormData) { const s = await requirePermission('contract.write'); const data = contractSchema.parse(clean(form)); const contract = await prisma.contract.create({ data: data as never }); await audit(s.userId, 'contract_modify', 'Contract', contract.id, contract); return contract; }
export async function registerPayment(form: FormData) { const s = await requirePermission('payment.write'); const data = paymentSchema.parse(clean(form)); const payment = await prisma.payment.create({ data: data as never }); await audit(s.userId, 'payment_register', 'Payment', payment.id, payment); return payment; }

export async function createClientService(form: FormData) { const s = await requirePermission('service.write'); const data = clientServiceSchema.parse(clean(form)); const service = await prisma.clientService.create({ data: data as never }); await audit(s.userId, 'client_service_create', 'ClientService', service.id, service); return service; }
export async function updateClientServiceStatus(id: string, status: string) { const s = await requirePermission('service.write'); const next = serviceStatusSchema.parse(status); const before = await prisma.clientService.findUniqueOrThrow({ where: { id } }); const service = await prisma.clientService.update({ where: { id }, data: { status: next, completedAt: ['chiuso','archiviato','consegnato'].includes(next) ? new Date() : undefined } }); await audit(s.userId, 'client_service_status_change', 'ClientService', id, { before, after: service }); return service; }
export async function assignClientService(id: string, assignedToId: string) { const s = await requirePermission('service.assign'); const before = await prisma.clientService.findUniqueOrThrow({ where: { id } }); const service = await prisma.clientService.update({ where: { id }, data: { assignedToId: assignedToId || null } }); await audit(s.userId, 'client_service_assign', 'ClientService', id, { before, after: service }); return service; }
export async function updateClientServicePipeline(form: FormData) { const s = await requirePermission('service.write'); const data = clientServicePipelineSchema.parse(clean(form)); const before = await prisma.clientService.findUniqueOrThrow({ where: { id: data.id } }); const service = await prisma.clientService.update({ where: { id: data.id }, data: { operationalStatus: data.operationalStatus, statusUpdatedAt: before.operationalStatus === data.operationalStatus ? before.statusUpdatedAt : new Date(), practiceType: data.practiceType ?? null, requestedAmount: data.requestedAmount ?? null, plannedInvestment: data.plannedInvestment ?? null, assignedToId: data.assignedToId ?? null, operationalNotes: data.operationalNotes ?? null } }); const events = ['client_service_pipeline_update']; if (before.operationalStatus !== service.operationalStatus) events.push('client_service_operational_status_change'); if (String(before.requestedAmount ?? '') !== String(service.requestedAmount ?? '') || String(before.plannedInvestment ?? '') !== String(service.plannedInvestment ?? '')) events.push('client_service_amounts_change'); if (before.assignedToId !== service.assignedToId) events.push('client_service_assign'); await Promise.all(events.map((event) => audit(s.userId, event, 'ClientService', service.id, { before, after: service }))); return service; }
export async function linkDocumentToService(form: FormData) { const s = await requirePermission('service.write'); const data = documentServiceLinkSchema.parse(clean(form)); const document = await prisma.document.update({ where: { id: data.documentId }, data: { clientServiceId: data.clientServiceId, serviceArea: data.serviceArea, documentCategory: data.documentCategory } }); await audit(s.userId, 'document_service_link', 'Document', document.id, document); return document; }
export async function updateDocumentSection(form: FormData) { const s = await requirePermission('document.upload'); const data = documentServiceLinkSchema.parse(clean(form)); const document = await prisma.document.update({ where: { id: data.documentId }, data: { serviceArea: data.serviceArea, documentCategory: data.documentCategory } }); await audit(s.userId, 'document_section_update', 'Document', document.id, document); return document; }

export async function runMockAgent(agentCode: string, input: unknown) { const s = await requirePermission('ai.run'); const agent = await prisma.aiAgent.findUniqueOrThrow({ where: { code: agentCode } }); const draft = await getAiAdapter().run(agentCode, input); const run = await prisma.aiRun.create({ data: { agentId: agent.id, input: input as object, output: draft as object, createdById: s.userId } }); const prepared = prepareAiOutput(draft); const output = await prisma.aiOutput.create({ data: { aiRunId: run.id, title: prepared.title, content: prepared.content, status: prepared.forbiddenPhrases.length ? 'flagged' : 'needs_review', requiresHumanReview: true, forbiddenPhrases: prepared.forbiddenPhrases } }); await audit(s.userId, 'ai_generation', 'AiOutput', output.id, output); return output; }
export async function approveAiOutput(id: string) { const s = await requirePermission('ai.approve'); const data = aiOutputApprovalSchema.parse({ id }); const current = await prisma.aiOutput.findUniqueOrThrow({ where: { id: data.id } }); if (!current.requiresHumanReview) throw new Error('AI output must require human review before approval'); const output = await prisma.aiOutput.update({ where: { id: data.id }, data: { status: 'approved', approvedById: s.userId, approvedAt: new Date(), reviewedById: s.userId, reviewedAt: new Date() } }); await audit(s.userId, 'ai_approval', 'AiOutput', id, output); return output; }
