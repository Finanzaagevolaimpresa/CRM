import { createHash, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { syntheticPerson } from '../selective-sharing/fixtures';
import { leadProof, type Person } from '../selective-leads/fixtures';
import { readTechnicalAssignmentManagement } from '../../src/lib/technical-assignment-management';
import { previewTechnicalAssignment, confirmTechnicalAssignment } from '../../src/lib/technical-assignment-service';
import { readTechnicalWork } from '../../src/lib/technical-assignment-access';
import { technicalAssignmentSelection, type TechnicalAssignmentSelection } from '../../src/lib/technical-assignment-contract';
import { technicalWorkCommand } from '../../src/lib/technical-work-contract';
import type { TechnicalTargetReference } from '../../src/lib/technical-assignment-display';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import type { TechnicalWorkItemGrant } from '../../src/lib/technical-work-item-grant';

export async function technicalFixture(db: PrismaClient, admin: Person, passwordHash?: string, secondTechnicalRole: 'consulente' | 'backoffice' = 'backoffice') {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const salesA = await syntheticPerson(db, 'Commerciale A sintetico', 'commerciale', passwordHash);
  const salesB = await syntheticPerson(db, 'Commerciale B sintetico', 'commerciale', passwordHash);
  const techA = await syntheticPerson(db, 'Tecnico A sintetico', 'consulente', passwordHash);
  const techB = await syntheticPerson(db, 'Tecnico B sintetico', secondTechnicalRole, passwordHash);
  // Legacy ownership is deliberate: the explicit scope must close its broader
  // dossier/ordinary-route fallback without overwriting the commercial owner.
  const client = await db.client.create({ data: { type: 'societa', displayName: 'Cliente tecnico A sintetico',
    salesOwnerId: salesA.user.id, consultantId: techA.user.id } });
  const otherClient = await db.client.create({ data: { type: 'societa', displayName: 'Cliente commerciale B sintetico', salesOwnerId: salesB.user.id } });
  const lead = await db.lead.create({ data: { firstName: 'Lead', lastName: 'Tecnico sintetico', clientId: client.id, assignedToId: salesA.user.id } });
  const project = await db.project.create({ data: { clientId: client.id, consultantId: techA.user.id,
    title: 'Progetto tecnico multiplo sintetico', description: 'Descrizione tecnica selezionabile',
    scenarioA: 'SCENARIO_PRIVATO_NON_SELEZIONATO', totalInvestment: 123456, requestedAmount: 654321 } });
  const otherProject = await db.project.create({ data: { clientId: client.id, title: 'PROGETTO_ESTRANEO_NON_ASSEGNATO', consultantId: techA.user.id } });
  const practice = await db.technicalPractice.create({ data: { clientId: client.id, projectId: project.id,
    title: 'Pratica tecnica multipla sintetica', practiceType: 'Sintetica', targetEntity: 'Ente sintetico',
    commercialOwnerId: salesA.user.id, technicalOwnerId: techA.user.id, createdById: admin.user.id,
    internalNotes: 'NOTA_INTERNA_NON_SELEZIONATA', clientVisibleStatus: 'Prima analisi' } });
  const otherPractice = await db.technicalPractice.create({ data: { clientId: otherClient.id,
    title: 'Pratica commerciale B sintetica', practiceType: 'Sintetica', targetEntity: 'Ente sintetico',
    commercialOwnerId: salesB.user.id, technicalOwnerId: techB.user.id, createdById: admin.user.id } });
  const documents = [];
  for (let index = 0; index < 3; index++) {
    const bytes = Buffer.from(`DOCUMENTO_TECNICO_SINTETICO_${index}`), checksum = createHash('sha256').update(bytes).digest('hex');
    const doc = await db.document.create({ data: { clientId: client.id, projectId: project.id,
      title: `Documento tecnico sintetico ${index + 1}`, fileName: `tecnico-${index + 1}.txt`,
      type: 'text/plain', mimeType: 'text/plain', documentCategory: 'altro', serviceArea: 'progetto_investimento',
      storagePath: `technical-synthetic/${randomUUID()}.txt`, sizeBytes: bytes.length, checksum, uploadedById: admin.user.id } });
    const version = await db.documentVersion.create({ data: { documentId: doc.id, version: 1, checksum, storagePath: doc.storagePath } });
    documents.push({ doc, version, bytes });
  }
  const contract = await db.contract.create({ data: { clientId: client.id, contractNumber: `FINANZIARIO_${randomUUID()}`,
    serviceName: 'COMPENSO_PRIVATO', serviceDescription: 'CONTRATTO_PRIVATO', taxableAmount: 1000, vatAmount: 220,
    totalAmount: 1220, signedDocumentId: documents[2].doc.id } });
  const payment = await db.payment.create({ data: { contractId: contract.id, clientId: client.id,
    taxableAmount: 1000, vatAmount: 220, totalAmount: 1220, notes: 'PAGAMENTO_PRIVATO' } });
  return { admin, salesA, salesB, techA, techB, client, otherClient, lead, project, otherProject, practice, otherPractice, documents, contract, payment };
}
export type TechnicalFixture = Awaited<ReturnType<typeof technicalFixture>>;
export function technicalTarget(f: TechnicalFixture, kind: TechnicalTargetReference['kind'] = 'TechnicalPractice'): TechnicalTargetReference {
  return { kind, targetId: kind === 'Project' ? f.project.id : f.practice.id };
}
export async function assignmentInput(db: PrismaClient, admin: Person, target: TechnicalTargetReference, person: Person,
  options: { documents?: { fileId: string; allowDownload: boolean }[]; expiresAt?: string; statusOnly?: boolean; workItems?: TechnicalWorkItemGrant[] } = {}) {
  const setup = await readTechnicalAssignmentManagement(db, admin.session, target, person.user.id);
  const documents = (options.documents ?? []).map(choice => {
    const item = setup.documentOptions.find(row => row.fileId === choice.fileId);
    if (!item) throw new Error('SYNTHETIC_DOCUMENT_NOT_OFFERED');
    return { documentId: item.documentId, fileId: item.fileId, version: item.version,
      contentSha256: item.contentSha256, contextSha256: item.contextSha256, allowDownload: choice.allowDownload };
  });
  const selection: TechnicalAssignmentSelection = technicalAssignmentSelection.parse({ kind: target.kind,
    userId: person.user.id, responsibility: 'co_responsabile', actions: [...(options.statusOnly ? ['update_status'] : ['update_fields', 'update_status']),
      ...(options.workItems?.some(item => item.kind === 'Task') ? ['manage_deadlines'] : []),
      ...(options.workItems?.some(item => item.kind === 'ChecklistItem') ? ['manage_checklist'] : [])],
    readableFields: options.statusOnly ? ['status'] : target.kind === 'Project' ? ['title', 'description', 'status']
      : ['title', 'status', 'priority', 'clientVisibleStatus', 'targetEntity', 'targetPortal', 'protocolNumber', 'nextClientUpdateAt'],
    editableFields: options.statusOnly ? [] : target.kind === 'Project' ? ['description'] : ['clientVisibleStatus', 'priority', 'targetPortal', 'protocolNumber', 'nextClientUpdateAt'],
    expiresAt: options.expiresAt ?? new Date(Date.now() + 3600_000).toISOString(), documents,
    ...(options.workItems ? { workItems: options.workItems } : {}) });
  return { commandId: randomUUID(), targetId: target.targetId, expectedRevision: setup.revision,
    expectedContextSha256: setup.contextSha256, expectedRecipientEpoch: setup.recipient!.epoch, selection, reason: 'Decisione sintetica isolata' };
}
export async function assignTechnical(db: PrismaClient, admin: Person, target: TechnicalTargetReference, person: Person,
  options: Parameters<typeof assignmentInput>[4] = {}) {
  const input = await assignmentInput(db, admin, target, person, options), ref = { ...target, recipientId: person.user.id };
  const preview = await previewTechnicalAssignment(db, admin.session, ref, 'ASSIGN', input);
  const receipt = await confirmTechnicalAssignment(db, admin.session, leadProof(admin), ref, 'ASSIGN', input, preview.token, true);
  return { input, ref, preview, receipt };
}
export async function revokeTechnical(db: PrismaClient, admin: Person, target: TechnicalTargetReference, person: Person) {
  const setup = await readTechnicalAssignmentManagement(db, admin.session, target, person.user.id), ref = { ...target, recipientId: person.user.id };
  const input = { commandId: randomUUID(), assignmentId: setup.currentAssignmentId!, expectedRevision: setup.revision,
    expectedContextSha256: setup.contextSha256, reason: 'Revoca sintetica isolata' };
  const preview = await previewTechnicalAssignment(db, admin.session, ref, 'REVOKE', input);
  return confirmTechnicalAssignment(db, admin.session, leadProof(admin), ref, 'REVOKE', input, preview.token, true);
}
export async function workInput(db: PrismaClient, person: Person, target: TechnicalTargetReference,
  patch: Record<string, string | null> = { clientVisibleStatus: 'Istruttoria tecnica completata' }) {
  const view = await readTechnicalWork(db, person.session, target);
  return technicalWorkCommand.parse({ commandId: randomUUID(), assignmentId: view.assignmentId,
    assignmentRevision: view.assignmentRevision, expectedContextSha256: view.contextSha256, expectedTargetSha256: view.targetSha256,
    action: 'status' in patch ? 'update_status' : 'update_fields', patch });
}
