'use server';
import type { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { hasPermission, requirePermission } from './auth';
import { leadSchema, clientSchema, projectSchema, documentSchema, preAnalysisSchema, aiOutputApprovalSchema, companySchema, projectExpenseSchema, dossierSchema, contractSchema, paymentSchema, clientServiceSchema, serviceStatusSchema, documentServiceLinkSchema } from './validation';
import { prepareAiOutput, getAiAdapter } from './ai';
import { createSignedDocumentUrl } from './storage';
import { canViewDocument, isSensitiveDocument } from './access-control';

function clean(form: FormData) { return Object.fromEntries([...form.entries()].filter(([, v]) => v !== '')); }
async function audit(actorId: string, event: string, entityType: string, entityId?: string, after?: unknown) { await prisma.auditLog.create({ data: { actorId, event, entityType, entityId, after: after as Prisma.InputJsonValue } }); }
export async function createLead(form: FormData) { const s = await requirePermission('lead.write'); const data = leadSchema.parse(clean(form)); const lead = await prisma.lead.create({ data }); await audit(s.userId, 'lead_create', 'Lead', lead.id, lead); return lead; }
export async function createClient(form: FormData) { const s = await requirePermission('client.write'); const data = clientSchema.parse(clean(form)); const client = await prisma.client.create({ data: data as never }); await audit(s.userId, 'client_create', 'Client', client.id, client); return client; }
export async function createCompany(form: FormData) { const s = await requirePermission('company.write'); const data = companySchema.parse(clean(form)); const company = await prisma.company.create({ data: data as never }); await audit(s.userId, 'company_create', 'Company', company.id, company); return company; }
export async function createProject(form: FormData) { const s = await requirePermission('project.write'); const data = projectSchema.parse(clean(form)); const project = await prisma.project.create({ data: data as never }); await audit(s.userId, 'project_create', 'Project', project.id, project); return project; }
export async function createProjectExpense(form: FormData) { const s = await requirePermission('project.write'); const data = projectExpenseSchema.parse(clean(form)); const expense = await prisma.projectExpense.create({ data: data as never }); await audit(s.userId, 'project_expense_create', 'ProjectExpense', expense.id, expense); return expense; }
export async function registerDocument(form: FormData) { const s = await requirePermission('document.upload'); const data = documentSchema.parse(clean(form)); const document = await prisma.document.create({ data: { ...data, uploadedById: s.userId } as never }); await audit(s.userId, 'document_upload', 'Document', document.id, document); return document; }
export async function getDocumentDownloadUrl(id: string) {
  const s = await requirePermission('document.download');
  const document = await prisma.document.findFirstOrThrow({ where: { id, deletedAt: null } });
  const [client, project, clientService] = await Promise.all([
    document.clientId ? prisma.client.findFirst({ where: { id: document.clientId, deletedAt: null }, select: { salesOwnerId: true, consultantId: true } }) : null,
    document.projectId ? prisma.project.findFirst({ where: { id: document.projectId, deletedAt: null }, select: { consultantId: true, clientId: true } }) : null,
    document.clientServiceId ? prisma.clientService.findFirst({ where: { id: document.clientServiceId, deletedAt: null }, select: { assignedToId: true, clientId: true, projectId: true } }) : null,
  ]);
  const [projectClient, serviceClient, serviceProject] = await Promise.all([
    project?.clientId ? prisma.client.findFirst({ where: { id: project.clientId, deletedAt: null }, select: { salesOwnerId: true, consultantId: true } }) : null,
    clientService?.clientId ? prisma.client.findFirst({ where: { id: clientService.clientId, deletedAt: null }, select: { salesOwnerId: true, consultantId: true } }) : null,
    clientService?.projectId ? prisma.project.findFirst({ where: { id: clientService.projectId, deletedAt: null }, select: { consultantId: true, clientId: true } }) : null,
  ]);
  const serviceProjectClient = serviceProject?.clientId ? await prisma.client.findFirst({ where: { id: serviceProject.clientId, deletedAt: null }, select: { salesOwnerId: true, consultantId: true } }) : null;
  const authorizationContext = {
    ...document,
    client,
    project: project ? { consultantId: project.consultantId, client: projectClient } : null,
    clientService: clientService ? { assignedToId: clientService.assignedToId } : null,
  };
  const serviceAuthorizationContext = clientService ? {
    ...authorizationContext,
    client: authorizationContext.client ?? serviceClient,
    project: authorizationContext.project ?? (serviceProject ? { consultantId: serviceProject.consultantId, client: serviceProjectClient } : null),
  } : authorizationContext;
  const canReadSensitive = hasPermission(s, 'document.sensitive.read');
  if (!canViewDocument(s, serviceAuthorizationContext, canReadSensitive)) throw new Error('Documento non autorizzato');
  if (isSensitiveDocument(document)) await audit(s.userId, 'document_sensitive_access', 'Document', document.id, { category: document.documentCategory });
  await audit(s.userId, 'document_download', 'Document', document.id, { storagePath: document.storagePath });
  return createSignedDocumentUrl(document.storagePath);
}
export async function createPreAnalysis(form: FormData) { const s = await requirePermission('project.write'); const data = preAnalysisSchema.parse(clean(form)); const pre = await prisma.preAnalysis.create({ data: data as never }); await audit(s.userId, 'preanalysis_create', 'PreAnalysis', pre.id, pre); return pre; }
export async function createDossier(form: FormData) { const s = await requirePermission('project.write'); const data = dossierSchema.parse(clean(form)); const dossier = await prisma.dossier.create({ data: { ...data, modifiedById: s.userId } as never }); await audit(s.userId, 'dossier_modify', 'Dossier', dossier.id, dossier); return dossier; }
export async function createContract(form: FormData) { const s = await requirePermission('contract.write'); const data = contractSchema.parse(clean(form)); const contract = await prisma.contract.create({ data: data as never }); await audit(s.userId, 'contract_modify', 'Contract', contract.id, contract); return contract; }
export async function registerPayment(form: FormData) { const s = await requirePermission('payment.write'); const data = paymentSchema.parse(clean(form)); const payment = await prisma.payment.create({ data: data as never }); await audit(s.userId, 'payment_register', 'Payment', payment.id, payment); return payment; }

export async function createClientService(form: FormData) { const s = await requirePermission('service.write'); const data = clientServiceSchema.parse(clean(form)); const service = await prisma.clientService.create({ data: data as never }); await audit(s.userId, 'client_service_create', 'ClientService', service.id, service); return service; }
export async function updateClientServiceStatus(id: string, status: string) { const s = await requirePermission('service.write'); const next = serviceStatusSchema.parse(status); const before = await prisma.clientService.findUniqueOrThrow({ where: { id } }); const service = await prisma.clientService.update({ where: { id }, data: { status: next, completedAt: ['chiuso','archiviato','consegnato'].includes(next) ? new Date() : undefined } }); await audit(s.userId, 'client_service_status_change', 'ClientService', id, { before, after: service }); return service; }
export async function assignClientService(id: string, assignedToId: string) { const s = await requirePermission('service.assign'); const service = await prisma.clientService.update({ where: { id }, data: { assignedToId } }); await audit(s.userId, 'client_service_assign', 'ClientService', id, service); return service; }
export async function linkDocumentToService(form: FormData) { const s = await requirePermission('service.write'); const data = documentServiceLinkSchema.parse(clean(form)); const document = await prisma.document.update({ where: { id: data.documentId }, data: { clientServiceId: data.clientServiceId, serviceArea: data.serviceArea, documentCategory: data.documentCategory } }); await audit(s.userId, 'document_service_link', 'Document', document.id, document); return document; }
export async function updateDocumentSection(form: FormData) { const s = await requirePermission('document.upload'); const data = documentServiceLinkSchema.parse(clean(form)); const document = await prisma.document.update({ where: { id: data.documentId }, data: { serviceArea: data.serviceArea, documentCategory: data.documentCategory } }); await audit(s.userId, 'document_section_update', 'Document', document.id, document); return document; }

export async function runMockAgent(agentCode: string, input: unknown) { const s = await requirePermission('ai.run'); const agent = await prisma.aiAgent.findUniqueOrThrow({ where: { code: agentCode } }); const draft = await getAiAdapter().run(agentCode, input); const run = await prisma.aiRun.create({ data: { agentId: agent.id, input: input as object, output: draft as object, createdById: s.userId } }); const prepared = prepareAiOutput(draft); const output = await prisma.aiOutput.create({ data: { aiRunId: run.id, title: prepared.title, content: prepared.content, status: prepared.forbiddenPhrases.length ? 'flagged' : 'needs_review', requiresHumanReview: true, forbiddenPhrases: prepared.forbiddenPhrases } }); await audit(s.userId, 'ai_generation', 'AiOutput', output.id, output); return output; }
export async function approveAiOutput(id: string) { const s = await requirePermission('ai.approve'); const data = aiOutputApprovalSchema.parse({ id }); const current = await prisma.aiOutput.findUniqueOrThrow({ where: { id: data.id } }); if (!current.requiresHumanReview) throw new Error('AI output must require human review before approval'); const output = await prisma.aiOutput.update({ where: { id: data.id }, data: { status: 'approved', approvedById: s.userId, approvedAt: new Date(), reviewedById: s.userId, reviewedAt: new Date() } }); await audit(s.userId, 'ai_approval', 'AiOutput', id, output); return output; }
