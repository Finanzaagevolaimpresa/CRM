import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RoleCode } from '@prisma/client';
import {
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
  hasConsistentClientContext,
} from '../src/lib/access-control';

const actor = (role: RoleCode, userId = 'user-1') => ({ role, userId });
const client = (id = 'client-1', salesOwnerId: string | null = null, consultantId: string | null = null) => ({
  id,
  salesOwnerId,
  consultantId,
});
const project = (clientId = 'client-1', consultantId: string | null = null, linkedClient = client(clientId)) => ({
  clientId,
  consultantId,
  client: linkedClient,
});
const service = (clientId = 'client-1', assignedToId: string | null = null, linkedClient = client(clientId), linkedProject = project(clientId, null, linkedClient)) => ({
  clientId,
  assignedToId,
  client: linkedClient,
  project: linkedProject,
});
const document = (overrides: Record<string, unknown> = {}) => ({
  clientId: 'client-1',
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
