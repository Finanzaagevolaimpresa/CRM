import assert from 'node:assert/strict';
import test from 'node:test';
import { canViewPaymentListRecord, canViewPreAnalysisListRecord } from '../src/lib/business-list-access';
import type { Actor } from '../src/lib/access-control';

const admin: Actor = { userId: 'admin', role: 'admin' };
const consultant: Actor = { userId: 'consultant', role: 'consulente' };
const client = { id: 'client', salesOwnerId: null, consultantId: consultant.userId, deletedAt: null };
const project = { id: 'project', clientId: client.id, consultantId: consultant.userId, deletedAt: null };
const contract = { id: 'contract', clientId: client.id, projectId: project.id };
const payment = { clientId: client.id, contractId: contract.id };
const company = { id: 'company', clientId: client.id, deletedAt: null };
const preAnalysis = { clientId: client.id, projectId: project.id, companyId: company.id };
const paymentContext = { payment, contract, client, project };
const preAnalysisContext = { preAnalysis, client, project, company };
const deletedAt = new Date('2026-09-01T00:00:00Z');

test('valid payment and pre-analysis parents are visible to their assigned consultant', () => {
  assert.equal(canViewPaymentListRecord(consultant, paymentContext), true);
  assert.equal(canViewPreAnalysisListRecord(consultant, preAnalysisContext), true);
});

test('payment without a contract project does not require a project', () => {
  assert.equal(canViewPaymentListRecord(consultant, {
    ...paymentContext, contract: { ...contract, projectId: null }, project: null,
  }), true);
  assert.equal(canViewPreAnalysisListRecord(consultant, {
    ...preAnalysisContext, preAnalysis: { ...preAnalysis, companyId: null }, company: null,
  }), true);
});

test('missing, deleted and mismatched clients reject both records even for admin', () => {
  for (const contextClient of [null, { ...client, deletedAt }, { ...client, id: 'different-client' }]) {
    assert.equal(canViewPaymentListRecord(admin, { ...paymentContext, client: contextClient }), false);
    assert.equal(canViewPreAnalysisListRecord(admin, { ...preAnalysisContext, client: contextClient }), false);
  }
});

test('payment contract must exist and match both its ID and client', () => {
  for (const contextContract of [null, { ...contract, id: 'different-contract' }, { ...contract, clientId: 'different-client' }]) {
    assert.equal(canViewPaymentListRecord(admin, { ...paymentContext, contract: contextContract }), false);
  }
});

test('a referenced payment project must be active and match the contract and client', () => {
  for (const contextProject of [null, { ...project, deletedAt }, { ...project, id: 'different-project' }, { ...project, clientId: 'different-client' }]) {
    assert.equal(canViewPaymentListRecord(admin, { ...paymentContext, project: contextProject }), false);
  }
});

test('pre-analysis requires an active exact project with the same client', () => {
  for (const contextProject of [null, { ...project, deletedAt }, { ...project, id: 'different-project' }, { ...project, clientId: 'different-client' }]) {
    assert.equal(canViewPreAnalysisListRecord(admin, { ...preAnalysisContext, project: contextProject }), false);
  }
  assert.equal(canViewPreAnalysisListRecord(admin, {
    ...preAnalysisContext, preAnalysis: { ...preAnalysis, projectId: null }, project: null,
  }), false);
});

test('a referenced company must exist, be active and match the pre-analysis and client', () => {
  for (const contextCompany of [null, { ...company, deletedAt }, { ...company, id: 'different-company' }, { ...company, clientId: 'different-client' }]) {
    assert.equal(canViewPreAnalysisListRecord(admin, { ...preAnalysisContext, company: contextCompany }), false);
  }
});

test('project-only ownership does not bypass the required client visibility', () => {
  const otherClient = { ...client, consultantId: 'other-consultant' };
  assert.equal(canViewPaymentListRecord(consultant, { ...paymentContext, client: otherClient }), false);
  assert.equal(canViewPreAnalysisListRecord(consultant, { ...preAnalysisContext, client: otherClient }), false);
});

test('parents already selected by deletedAt null may omit that property', () => {
  const activeClient = { id: client.id, salesOwnerId: client.salesOwnerId, consultantId: client.consultantId };
  const activeProject = { id: project.id, clientId: project.clientId, consultantId: project.consultantId };
  assert.equal(canViewPaymentListRecord(consultant, { ...paymentContext, client: activeClient, project: activeProject }), true);
  assert.equal(canViewPreAnalysisListRecord(consultant, {
    ...preAnalysisContext, client: activeClient, project: activeProject, company: { id: company.id, clientId: company.clientId },
  }), true);
});

test('the shared predicates yield matching authorized list IDs and aggregate counts', () => {
  const paymentRecords = [
    { id: 'valid', context: paymentContext },
    { id: 'without-project', context: { ...paymentContext, contract: { ...contract, projectId: null }, project: null } },
    { id: 'deleted-project', context: { ...paymentContext, project: { ...project, deletedAt } } },
    { id: 'wrong-contract', context: { ...paymentContext, contract: { ...contract, clientId: 'other' } } },
  ];
  const preAnalysisRecords = [
    { id: 'valid', context: preAnalysisContext },
    { id: 'without-company', context: { ...preAnalysisContext, preAnalysis: { ...preAnalysis, companyId: null }, company: null } },
    { id: 'deleted-company', context: { ...preAnalysisContext, company: { ...company, deletedAt } } },
    { id: 'wrong-project', context: { ...preAnalysisContext, project: { ...project, clientId: 'other' } } },
  ];
  const paymentList = paymentRecords.filter(({ context }) => canViewPaymentListRecord(consultant, context));
  const preAnalysisList = preAnalysisRecords.filter(({ context }) => canViewPreAnalysisListRecord(consultant, context));
  assert.deepEqual(paymentList.map(({ id }) => id), ['valid', 'without-project']);
  assert.deepEqual(preAnalysisList.map(({ id }) => id), ['valid', 'without-company']);
  assert.equal(paymentRecords.reduce((count, { context }) => count + Number(canViewPaymentListRecord(consultant, context)), 0), paymentList.length);
  assert.equal(preAnalysisRecords.reduce((count, { context }) => count + Number(canViewPreAnalysisListRecord(consultant, context)), 0), preAnalysisList.length);
});
