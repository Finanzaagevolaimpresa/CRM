import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RoleCode } from '@prisma/client';
import {
  canApproveAiOutput,
  canAssignService,
  canEditChecklistItem,
  canEditClient,
  canEditCommercialOffer,
  canEditDocument,
  canEditLead,
  canEditProject,
  canEditService,
  canEditTask,
  canEditTechnicalPractice,
  canReviewAiOutput,
  canViewAiOutput,
  canViewChecklistItem,
  canViewClientContext,
  canViewCommercialOffer,
  canViewDocument,
  canViewLead,
  canViewProject,
  canViewService,
  canViewTask,
  hasConsistentClientContext,
} from '../src/lib/access-control';

const actor = (role: RoleCode, userId = 'user-1') => ({ role, userId });
const client = (id = 'client-1', salesOwnerId: string | null = null, consultantId: string | null = null) => ({
  id,
  salesOwnerId,
  consultantId,
});
const project = (clientId = 'client-1', consultantId: string | null = null, linkedClient = client(clientId), id = 'project-1') => ({
  id,
  clientId,
  consultantId,
  client: linkedClient,
});
const service = (clientId = 'client-1', assignedToId: string | null = null, linkedClient = client(clientId), linkedProject = project(clientId, null, linkedClient)) => ({
  id: 'service-1',
  clientId,
  projectId: linkedProject.id,
  assignedToId,
  client: linkedClient,
  project: linkedProject,
});
const document = (overrides: Record<string, unknown> = {}) => ({
  clientId: 'client-1',
  projectId: null,
  clientServiceId: null,
  uploadedById: 'uploader',
  containsSensitiveData: false,
  documentCategory: 'altro',
  type: 'documento',
  client: client(),
  project: null,
  clientService: null,
  ...overrides,
});

test('admin e direzione mantengono accesso globale soltanto su contesti coerenti', () => {
  for (const role of ['admin', 'direzione'] satisfies RoleCode[]) {
    const user = actor(role);
    assert.equal(canEditLead(user, { assignedToId: 'altro' }), true);
    assert.equal(canEditClient(user, client()), true);
    assert.equal(canEditProject(user, project()), true);
    assert.equal(canEditService(user, service()), true);
    assert.equal(canAssignService(user, service()), true);
    assert.equal(canEditTask(user, { clientId: 'client-1', assignedToId: null, createdById: null }), true);
    assert.equal(canEditChecklistItem(user, { clientId: 'client-1', createdById: null, updatedById: null }), true);
    assert.equal(canEditDocument(user, document()), true);
    assert.equal(canEditTechnicalPractice(user, { technicalOwnerId: 'altro' }), true);
  }

  const inconsistentProject = project('client-1', 'user-1', client('client-2', null, 'user-1'));
  assert.equal(canEditProject(actor('admin'), inconsistentProject), false);
});

test('il commerciale modifica i lead assegnati e quelli non assegnati della coda condivisa', () => {
  const commerciale = actor('commerciale');
  assert.equal(canEditLead(commerciale, { assignedToId: 'user-1' }), true);
  assert.equal(canEditLead(commerciale, { assignedToId: null }), true);
  assert.equal(canEditLead(commerciale, { assignedToId: 'user-2' }), false);
  assert.equal(canEditLead(actor('consulente'), { assignedToId: 'user-1' }), false);
  assert.equal(canEditLead(actor('collaboratore_limitato'), { assignedToId: 'user-1' }), false);
});

test('le offerte commerciali seguono creatore, lead e cliente senza collegamenti incoerenti', () => {
  const commerciale = actor('commerciale');
  const ownedLead = { assignedToId: 'user-1', clientId: null };
  const foreignLead = { assignedToId: 'user-2', clientId: null };

  assert.equal(canEditCommercialOffer(commerciale, { createdById: 'user-1' }), true);
  assert.equal(canEditCommercialOffer(commerciale, { leadId: 'lead-1', lead: ownedLead }), true);
  assert.equal(canEditCommercialOffer(commerciale, { leadId: 'lead-1', lead: foreignLead }), false);
  assert.equal(canEditCommercialOffer(commerciale, { clientId: 'client-1', client: client('client-1', 'user-1') }), true);
  assert.equal(canEditCommercialOffer(commerciale, { clientId: 'client-1', client: client('client-1', 'user-2') }), false);
  assert.equal(canEditCommercialOffer(commerciale, { leadId: 'lead-missing', lead: null }), false);
  assert.equal(canEditCommercialOffer(commerciale, {
    leadId: 'lead-1',
    clientId: 'client-2',
    lead: { assignedToId: 'user-1', clientId: 'client-1' },
    client: client('client-2', 'user-1'),
  }), false);
  assert.equal(canEditCommercialOffer(actor('revisore'), { createdById: 'user-2' }), false);
  assert.equal(canEditCommercialOffer(actor('admin'), { createdById: 'user-2' }), true);
});

test('clienti e progetti sono modificabili soltanto dal responsabile previsto', () => {
  const commerciale = actor('commerciale');
  const consulente = actor('consulente');

  assert.equal(canEditClient(commerciale, client('client-1', 'user-1', 'user-2')), true);
  assert.equal(canEditClient(commerciale, client('client-1', 'user-2', 'user-1')), false);
  assert.equal(canEditClient(consulente, client('client-1', 'user-2', 'user-1')), true);
  assert.equal(canEditClient(consulente, client('client-1', 'user-1', 'user-2')), false);

  assert.equal(canEditProject(consulente, project('client-1', 'user-1')), true);
  assert.equal(canEditProject(consulente, project('client-1', 'user-2', client('client-1', null, 'user-1'))), true);
  assert.equal(canEditProject(consulente, project('client-1', 'user-2', client('client-1', null, 'user-2'))), false);
  assert.equal(canEditProject(commerciale, project('client-1', 'user-1')), false);
  assert.equal(canEditClient(actor('collaboratore_limitato'), client('client-1', 'user-1', 'user-1')), false);
});

test('i servizi rispettano assegnazione, ownership e operativita trasversale del backoffice', () => {
  const consulente = actor('consulente');
  const backoffice = actor('backoffice');
  const ownedClient = client('client-1', null, 'user-1');

  assert.equal(canEditService(consulente, service('client-1', 'user-1')), true);
  assert.equal(canEditService(consulente, service('client-1', null, ownedClient)), true);
  assert.equal(canEditService(consulente, service('client-1', null, client('client-1'), project('client-1', 'user-1'))), true);
  assert.equal(canEditService(consulente, service('client-1', 'user-2')), false);
  assert.equal(canEditService(backoffice, service('client-1', 'user-1')), true);
  assert.equal(canEditService(backoffice, service('client-1', null)), true);
  assert.equal(canEditService(actor('collaboratore_limitato'), service('client-1', 'user-1')), false);

  assert.equal(canAssignService(actor('commerciale'), service('client-1', null, client('client-1', 'user-1'))), true);
  assert.equal(canAssignService(actor('commerciale'), service('client-1', null, client('client-1', 'user-2'))), false);
  assert.equal(canAssignService(consulente, service('client-1', 'user-1')), true);
  assert.equal(canAssignService(consulente, service('client-1', null, ownedClient)), true);
  assert.equal(canAssignService(backoffice, service()), false);
});

test('task e checklist ereditano solo contesti coerenti e mantengono il backoffice operativo', () => {
  const consulente = actor('consulente');
  const ownedClient = client('client-1', null, 'user-1');

  assert.equal(canEditTask(consulente, { clientId: 'client-1', assignedToId: 'user-1', createdById: null }), true);
  assert.equal(canEditTask(consulente, { clientId: 'client-1', assignedToId: null, createdById: 'user-1' }), true);
  assert.equal(canEditTask(consulente, { clientId: 'client-1', assignedToId: null, createdById: null, client: ownedClient }), true);
  assert.equal(canEditTask(consulente, { clientId: 'client-1', assignedToId: null, createdById: null, project: project('client-1', 'user-1') }), true);
  assert.equal(canEditTask(consulente, { clientId: 'client-1', assignedToId: null, createdById: null, clientService: service('client-1', 'user-1') }), true);
  assert.equal(canEditTask(consulente, { clientId: 'client-1', assignedToId: 'user-2', createdById: 'user-2' }), false);
  assert.equal(canEditTask(actor('backoffice'), { clientId: 'client-1', assignedToId: null, createdById: null }), true);
  assert.equal(canEditTask(actor('collaboratore_limitato'), { clientId: 'client-1', assignedToId: 'user-1', createdById: 'user-1' }), false);

  assert.equal(canEditChecklistItem(consulente, { clientId: 'client-1', createdById: 'user-1', updatedById: null }), true);
  assert.equal(canEditChecklistItem(consulente, { clientId: 'client-1', createdById: null, updatedById: null, client: ownedClient }), true);
  assert.equal(canEditChecklistItem(actor('backoffice'), { clientId: 'client-1', createdById: null, updatedById: null }), true);
  assert.equal(canEditChecklistItem(actor('collaboratore_limitato'), { clientId: 'client-1', createdById: 'user-1', updatedById: 'user-1' }), false);
});

test('i documenti sensibili richiedono sempre il flag e il backoffice resta trasversale sui non sensibili', () => {
  const sensitive = document({ containsSensitiveData: true });

  assert.equal(canEditDocument(actor('admin'), sensitive), false);
  assert.equal(canEditDocument(actor('admin'), sensitive, true), true);
  assert.equal(canEditDocument(actor('direzione'), document({ type: 'CRIF' })), false);
  assert.equal(canEditDocument(actor('direzione'), document({ type: 'CRIF' }), true), true);
  assert.equal(canEditDocument(actor('backoffice'), document()), true);
  assert.equal(canEditDocument(actor('backoffice'), sensitive), false);
  assert.equal(canEditDocument(actor('backoffice'), sensitive, true), true);
  assert.equal(canEditDocument(actor('consulente'), document({ uploadedById: 'user-1' })), true);
  assert.equal(canEditDocument(actor('consulente'), document({ client: client('client-1', null, 'user-1') })), true);
  assert.equal(canEditDocument(actor('commerciale'), document({ client: client('client-1', 'user-1') })), true);
  assert.equal(canEditDocument(actor('collaboratore_limitato'), document({ uploadedById: 'user-1' })), false);
});

test('contesti cross-client sono negati anche se una relazione secondaria appartiene all attore', () => {
  const consulente = actor('consulente');
  const commerciale = actor('commerciale');
  const clientOfAnotherRecord = client('client-2', 'user-1', 'user-1');
  const mismatchedProject = project('client-2', 'user-1', clientOfAnotherRecord);
  const mismatchedService = service('client-2', 'user-1', clientOfAnotherRecord, mismatchedProject);

  assert.equal(hasConsistentClientContext({ clientId: 'client-1', client: clientOfAnotherRecord }), false);
  assert.equal(canEditProject(consulente, project('client-1', null, clientOfAnotherRecord)), false);
  assert.equal(canEditService(consulente, { ...mismatchedService, clientId: 'client-1' }), false);
  assert.equal(canAssignService(commerciale, { ...mismatchedService, clientId: 'client-1' }), false);
  assert.equal(canEditTask(consulente, {
    clientId: 'client-1',
    assignedToId: null,
    createdById: null,
    client: clientOfAnotherRecord,
  }), false);
  assert.equal(canEditDocument(consulente, document({
    clientId: 'client-1',
    uploadedById: 'user-2',
    client: clientOfAnotherRecord,
    project: mismatchedProject,
  })), false);
});

test('le pratiche tecniche sono globali per backoffice ma il consulente deve esserne titolare', () => {
  assert.equal(canEditTechnicalPractice(actor('backoffice'), { technicalOwnerId: null }), true);
  assert.equal(canEditTechnicalPractice(actor('consulente'), { technicalOwnerId: 'user-1' }), true);
  assert.equal(canEditTechnicalPractice(actor('consulente'), { technicalOwnerId: 'user-2' }), false);
  assert.equal(canEditTechnicalPractice(actor('commerciale'), { technicalOwnerId: 'user-1' }), false);
  assert.equal(canEditTechnicalPractice(actor('collaboratore_limitato'), { technicalOwnerId: 'user-1' }), false);
});

test('le letture di lead e offerte seguono assegnazione, creatore e parent coerenti', () => {
  const commerciale = actor('commerciale');
  assert.equal(canViewLead(commerciale, { assignedToId: null }), true);
  assert.equal(canViewLead(commerciale, { assignedToId: 'user-1' }), true);
  assert.equal(canViewLead(commerciale, { assignedToId: 'user-2' }), false);
  assert.equal(canViewCommercialOffer(commerciale, { createdById: 'user-1' }), true);
  assert.equal(canViewCommercialOffer(commerciale, { leadId: 'lead-1', lead: { assignedToId: 'user-2', clientId: null } }), false);
  assert.equal(canViewCommercialOffer(commerciale, { clientId: 'client-1', client: client('client-1', 'user-1') }), true);
  assert.equal(canViewCommercialOffer(actor('admin'), { leadId: 'missing', lead: null }), false);
  assert.equal(canViewCommercialOffer(actor('admin'), {
    leadId: 'lead-1',
    clientId: 'client-2',
    lead: { assignedToId: null, clientId: 'client-1' },
    client: client('client-2'),
  }), false);
});

test('servizi e contesti cliente in lettura negano parent incoerenti', () => {
  const ownedClient = client('client-1', null, 'user-1');
  const ownedProject = project('client-1', 'user-1', ownedClient);
  const ownedService = service('client-1', 'user-1', ownedClient, ownedProject);
  assert.equal(canViewService(actor('consulente'), ownedService), true);
  assert.equal(canViewClientContext(actor('consulente'), { clientId: 'client-1', client: ownedClient, project: ownedProject, clientService: ownedService }), true);
  assert.equal(canViewClientContext(actor('admin'), {
    clientId: 'client-1',
    client: ownedClient,
    project: { ...project('client-1'), id: 'project-2' },
    clientService: ownedService,
  }), false);
  assert.equal(canViewService(actor('admin'), service('client-1', null, client('client-2'))), false);
  assert.equal(canViewProject(actor('admin'), { id: 'project-1', clientId: 'client-1', consultantId: null, client: null }), false);
  assert.equal(canViewService(actor('admin'), { id: 'service-1', clientId: 'client-1', projectId: null, assignedToId: null, client: null, project: null }), false);
  assert.equal(canViewService(actor('admin'), { id: 'service-1', clientId: 'client-1', projectId: 'missing', assignedToId: null, client: ownedClient, project: null }), false);
});

test('la lettura documenti nega collegamenti dangling o cross-client anche agli amministratori', () => {
  assert.equal(canViewDocument(actor('admin'), document({ client: null })), false);
  assert.equal(canViewDocument(actor('admin'), document({ projectId: 'project-2', project: project('client-2', null, client('client-2'), 'project-2'), client: client('client-1') })), false);
  assert.equal(canViewDocument(actor('admin'), document({ clientId: null, client: null, projectId: 'project-1', project: project('client-1') })), false);
  assert.equal(canViewDocument(actor('admin'), document({ projectId: 'missing-project', project: null })), false);
  assert.equal(canViewDocument(actor('admin'), document({ clientServiceId: 'missing-service', clientService: null })), false);
  assert.equal(canViewDocument(actor('admin'), document({ projectId: 'expected-project', project: project('client-1', null, client('client-1'), 'different-project') })), false);
  assert.equal(canViewDocument(actor('admin'), document({ clientServiceId: 'expected-service', clientService: service('client-1') })), false);
  assert.equal(canViewDocument(actor('admin'), document({
    projectId: 'project-1',
    project: project('client-1', null, client('client-1'), 'project-1'),
    clientServiceId: 'service-1',
    clientService: { ...service('client-1'), projectId: 'project-2' },
  })), false);
  assert.equal(canViewDocument(actor('admin'), document({
    projectId: 'project-1',
    project: project('client-1'),
    clientServiceId: 'service-1',
    clientService: service('client-1'),
  })), true);
  assert.equal(canViewDocument(actor('admin'), document()), true);
});

test('task e checklist in lettura ereditano soltanto contesti cliente validi', () => {
  const ownedClient = client('client-1', null, 'user-1');
  assert.equal(canViewTask(actor('consulente'), { clientId: 'client-1', assignedToId: null, createdById: null, client: ownedClient }), true);
  assert.equal(canViewTask(actor('admin'), { clientId: 'client-1', assignedToId: null, createdById: null, client: null }), false);
  assert.equal(canViewTask(actor('admin'), { clientId: 'client-1', projectId: 'missing', assignedToId: null, createdById: null, client: ownedClient, project: null }), false);
  assert.equal(canViewTask(actor('backoffice'), { clientId: null, assignedToId: null, createdById: null }), false);
  assert.equal(canViewChecklistItem(actor('consulente'), { clientId: 'client-1', createdById: null, updatedById: null, client: ownedClient }), true);
  assert.equal(canViewChecklistItem(actor('admin'), { clientId: 'client-1', createdById: null, updatedById: null, client: null }), false);
  assert.equal(canViewChecklistItem(actor('admin'), { clientId: 'client-1', clientServiceId: 'missing', createdById: null, updatedById: null, client: ownedClient, clientService: null }), false);
});

test('output AI richiedono contesto run identico e revisione indipendente dal generatore', () => {
  const ownedClient = client('client-1', null, 'consultant-1');
  const run = { clientId: 'client-1', clientServiceId: null, projectId: null, createdById: 'generator-1' };
  const output = {
    clientId: 'client-1',
    clientServiceId: null,
    projectId: null,
    status: 'needs_review',
    requiresHumanReview: true,
    forbiddenPhrases: [],
    reviewedById: null,
    reviewedAt: null,
    run,
    client: ownedClient,
    project: null,
    clientService: null,
  };

  assert.equal(canViewAiOutput(actor('consulente', 'consultant-1'), output), true);
  assert.equal(canViewAiOutput(actor('consulente', 'other-consultant'), output), false);
  assert.equal(canViewAiOutput(actor('admin'), { ...output, run: { ...run, clientId: 'client-2' } }), false);
  assert.equal(canViewAiOutput(actor('revisore'), { ...output, clientId: null, client: null, run: { clientId: null, clientServiceId: null, projectId: null, createdById: 'generator-1' } }), false);
  assert.equal(canViewAiOutput(actor('direzione'), { ...output, clientId: null, client: null, run: { clientId: null, clientServiceId: null, projectId: null, createdById: 'generator-1' } }), true);

  assert.equal(canReviewAiOutput(actor('revisore', 'reviewer-1'), output), true);
  assert.equal(canReviewAiOutput(actor('consulente', 'generator-1'), output), false);
  assert.equal(canReviewAiOutput(actor('revisore', 'reviewer-1'), { ...output, forbiddenPhrases: ['garantito'] }), false);
  assert.equal(canReviewAiOutput(actor('revisore', 'reviewer-1'), { ...output, run: { ...run, createdById: null } }), false);
  assert.equal(canApproveAiOutput(actor('revisore', 'approver-1'), output), false);
  assert.equal(canApproveAiOutput(actor('revisore', 'approver-1'), { ...output, reviewedById: 'reviewer-1', reviewedAt: new Date() }), true);
  assert.equal(canApproveAiOutput(actor('revisore', 'reviewer-1'), { ...output, reviewedById: 'reviewer-1', reviewedAt: new Date() }), false);
  assert.equal(canApproveAiOutput(actor('revisore', 'approver-1'), { ...output, reviewedById: 'generator-1', reviewedAt: new Date() }), false);
  assert.equal(canApproveAiOutput(actor('revisore', 'generator-1'), { ...output, reviewedById: 'reviewer-1', reviewedAt: new Date() }), false);
});
