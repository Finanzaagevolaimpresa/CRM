import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { syntheticPerson } from '../selective-sharing/fixtures';
import { assignmentInput } from '../technical-assignments/fixtures';
import { leadProof, type Person } from '../selective-leads/fixtures';
import { previewTechnicalAssignment, confirmTechnicalAssignment } from '../../src/lib/technical-assignment-service';
import { readSharedOperationalPanel } from '../../src/lib/shared-operational-updates';
import type { SharedUpdateCommand, SharedUpdateTarget } from '../../src/lib/shared-operational-update-contract';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';

export async function sharedFixture(db: PrismaClient, admin: Person, passwordHash?: string) {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const sales = await syntheticPerson(db, 'Commerciale referente sintetico', 'commerciale', passwordHash);
  const otherSales = await syntheticPerson(db, 'Commerciale estraneo sintetico', 'commerciale', passwordHash);
  const tech = await syntheticPerson(db, 'Tecnico sintetico A', 'consulente', passwordHash);
  const second = await syntheticPerson(db, 'Tecnico sintetico B', 'backoffice', passwordHash);
  const stranger = await syntheticPerson(db, 'Tecnico senza incarico', 'consulente', passwordHash);
  const client = await db.client.create({ data: { displayName: 'Cliente operativo ' + randomUUID(), type: 'societa',
    salesOwnerId: sales.user.id, consultantId: tech.user.id, notes: 'PRIVATE_CLIENT_NOTE' } });
  const lead = await db.lead.create({ data: { firstName: 'Origine', lastName: 'Sintetica', companyName: 'Impresa dichiarata sul Lead',
    contactPerson: 'Contatto da verificare', phone: '0000000000', email: 'source@invalid.test',
    clientId: client.id, assignedToId: sales.user.id, status: 'vinto', notes: 'PRIVATE_LEAD_NOTE' } });
  await db.client.update({ where: { id: client.id }, data: { leadId: lead.id } });
  const company = await db.company.create({ data: { clientId: client.id, name: 'Azienda collegata sintetica',
    vatNumber: '00000000000', taxCode: 'COMPANY-TAX-SYNTHETIC', pec: 'pec@invalid.test', sdiCode: 'SYN0001',
    legalStreet: 'Via sintetica', legalStreetNumber: '1/A', legalPostalCode: '00001', legalCity: 'Città sintetica',
    legalProvince: 'XX', operatingStreet: 'Piazza sintetica', operatingStreetNumber: '2', operatingPostalCode: '00002',
    operatingCity: 'Altra città sintetica', operatingProvince: 'YY', notes: 'PRIVATE_COMPANY_NOTE' } });
  const otherCompany = await db.company.create({ data: { clientId: client.id, name: 'Seconda azienda canonica' } });
  const administrator = await db.person.create({ data: { firstName: 'Amministratore', lastName: 'Sintetico',
    taxCode: 'PERSON-TAX-SYNTHETIC', notes: 'PRIVATE_PERSON_NOTE' } });
  const contact = await db.person.create({ data: { firstName: 'Referente', lastName: 'Diverso', phone: '0000000001', email: 'contact@invalid.test' } });
  const unclassified = await db.person.create({ data: { firstName: 'PRIVATE_OTHER_MEMBER', lastName: 'Non scelto', taxCode: 'PRIVATE_OTHER_CF' } });
  await db.companyPerson.createMany({ data: [
    { companyId: company.id, personId: administrator.id, role: 'Amministratore', isAdministrator: true },
    { companyId: company.id, personId: contact.id, role: 'Responsabile operativo', isOperationalContact: true },
    { companyId: company.id, personId: unclassified.id, role: 'Socio non classificato' },
  ] });
  const project = await db.project.create({ data: { clientId: client.id, companyId: company.id, consultantId: tech.user.id,
    title: 'Progetto operativo sintetico', scenarioA: 'PRIVATE_PROJECT_NOTE', totalInvestment: 998877 } });
  const practice = await db.technicalPractice.create({ data: { clientId: client.id, projectId: project.id,
    title: 'Pratica operativa A', practiceType: 'Sintetica', targetEntity: 'Ente sintetico',
    commercialOwnerId: sales.user.id, technicalOwnerId: tech.user.id, createdById: admin.user.id, internalNotes: 'PRIVATE_PRACTICE_NOTE' } });
  const sibling = await db.technicalPractice.create({ data: { clientId: client.id, projectId: project.id,
    title: 'Pratica operativa B non assegnata', practiceType: 'Sintetica', targetEntity: 'Ente sintetico',
    commercialOwnerId: sales.user.id, technicalOwnerId: stranger.user.id, createdById: admin.user.id } });
  const contract = await db.contract.create({ data: { clientId: client.id, contractNumber: randomUUID(),
    serviceName: 'PRIVATE_CONTRACT_NAME', taxableAmount: 100, vatAmount: 22, totalAmount: 122 } });
  const payment = await db.payment.create({ data: { contractId: contract.id, clientId: client.id, taxableAmount: 100,
    vatAmount: 22, totalAmount: 122, notes: 'PRIVATE_PAYMENT_NOTE' } });
  return { sales, otherSales, tech, second, stranger, client, lead, company, otherCompany, administrator, contact,
    project, practice, sibling, contract, payment };
}
export async function shareAssignment(db: PrismaClient, admin: Person, target: SharedUpdateTarget, recipient: Person,
  options: { status?: boolean; title?: boolean; readStatus?: boolean; expiresAt?: string } = {}) {
  if (target.kind === 'CLIENT') throw new Error('No client-wide technical assignment');
  const ref = { kind: target.kind === 'PROJECT' ? 'Project' as const : 'TechnicalPractice' as const, targetId: target.id, recipientId: recipient.user.id };
  const input = await assignmentInput(db, admin, { kind: ref.kind, targetId: ref.targetId }, recipient,
    { statusOnly: true, expiresAt: options.expiresAt });
  input.selection.actions = ['share_update', ...(options.status === false ? [] : ['update_status' as const])];
  input.selection.readableFields = [...(options.readStatus === false ? [] : ['status' as const]), ...(options.title === false ? [] : ['title' as const])];
  if (!input.selection.readableFields.length) input.selection.readableFields = ['priority'];
  const preview = await previewTechnicalAssignment(db, admin.session, ref, 'ASSIGN', input);
  return confirmTechnicalAssignment(db, admin.session, leadProof(admin), ref, 'ASSIGN', input, preview.token, true);
}
export async function sharedInput(db: PrismaClient, actor: Person, target: SharedUpdateTarget,
  overrides: Partial<SharedUpdateCommand> = {}): Promise<SharedUpdateCommand> {
  const panel = await readSharedOperationalPanel(db, actor.session, target);
  return { commandId: randomUUID(), target, expectedContext: panel.expectedContext, expectedVersion: panel.expectedVersion,
    text: 'Aggiornamento operativo sintetico', state: null, nextAction: 'Prossima attività sintetica', nextActionDueOn: '2027-02-03',
    correctionOfId: null, classification: 'SHARED_OPERATIONAL', ...overrides };
}
