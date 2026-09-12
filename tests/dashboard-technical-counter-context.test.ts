import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDashboardTechnicalCounterContext } from '../src/lib/dashboard-technical-counter-context';
import type { Actor } from '../src/lib/access-control';

const admin: Actor = { userId: 'admin', role: 'admin' };
const commerciale: Actor = { userId: 'commerciale', role: 'commerciale' };
const consulente: Actor = { userId: 'consulente', role: 'consulente' };
const client = { id: 'client', salesOwnerId: 'other-sales', consultantId: 'other-consultant', deletedAt: null };
const project = { id: 'project', clientId: client.id, deletedAt: null };
const service = { id: 'service', clientId: client.id, projectId: project.id, deletedAt: null };
const practice = {
  id: 'practice', clientId: client.id, projectId: project.id, clientServiceId: service.id,
  commercialOwnerId: null, technicalOwnerId: null, deletedAt: null,
  status: 'in_istruttoria', nextClientUpdateAt: new Date('2026-09-01T00:00:00Z'),
};
const communication = {
  id: 'communication', technicalPracticeId: practice.id, clientId: client.id,
  projectId: project.id, clientServiceId: service.id,
  status: 'da_revisionare' as const, usedAt: null, deletedAt: null,
};
const input = {
  session: admin,
  practices: [practice], clients: [client], projects: [project], services: [service],
  communications: [communication],
};
const deletedAt = new Date('2026-08-01T00:00:00Z');

test('a valid graph retains original practice fields and distinct communication totals', () => {
  const approved = { ...communication, id: 'approved', status: 'approvata' as const };
  const result = buildDashboardTechnicalCounterContext({ ...input, communications: [communication, approved] });
  assert.deepEqual(result, { visiblePractices: [practice], visibleCommunications: [communication, approved], commsToReview: 1, approvedUnusedComms: 1 });
  assert.equal(result.visiblePractices[0], practice);
  assert.equal(result.visiblePractices[0].nextClientUpdateAt, practice.nextClientUpdateAt);
});

test('missing or deleted clients hide practice and communication even for admin', () => {
  for (const clients of [[], [{ ...client, deletedAt }]]) {
    assert.deepEqual(buildDashboardTechnicalCounterContext({ ...input, clients }), {
      visiblePractices: [], visibleCommunications: [], commsToReview: 0, approvedUnusedComms: 0,
    });
  }
});

test('missing or deleted direct projects cannot contribute to technical totals', () => {
  for (const projects of [[], [{ ...project, deletedAt }]]) {
    assert.equal(buildDashboardTechnicalCounterContext({ ...input, projects }).visiblePractices.length, 0);
  }
});

test('missing or deleted referenced services hide the parent practice', () => {
  for (const services of [[], [{ ...service, deletedAt }]]) {
    assert.equal(buildDashboardTechnicalCounterContext({ ...input, services }).visiblePractices.length, 0);
  }
});

test('cross-client direct parents and mismatched service projects are rejected', () => {
  const cases = [
    { projects: [{ ...project, clientId: 'other' }], services: [service] },
    { projects: [project], services: [{ ...service, clientId: 'other' }] },
    { projects: [project, { ...project, id: 'second-project' }], services: [{ ...service, projectId: 'second-project' }] },
  ];
  for (const context of cases) {
    assert.equal(buildDashboardTechnicalCounterContext({ ...input, ...context }).visiblePractices.length, 0);
  }
});

test('a service-only practice still requires a present active same-client service project', () => {
  const practices = [{ ...practice, projectId: null }];
  const communications = [{ ...communication, projectId: null }];
  assert.equal(buildDashboardTechnicalCounterContext({ ...input, practices, communications }).commsToReview, 1);
  for (const projects of [[], [{ ...project, deletedAt }], [{ ...project, clientId: 'other' }]]) {
    assert.equal(buildDashboardTechnicalCounterContext({ ...input, practices, communications, projects }).commsToReview, 0);
  }
});

test('optional project and service links may both be absent or the service may lack a project', () => {
  const standalone = { ...practice, projectId: null, clientServiceId: null };
  assert.equal(buildDashboardTechnicalCounterContext({ ...input, practices: [standalone], projects: [], services: [] }).visiblePractices.length, 1);
  assert.equal(buildDashboardTechnicalCounterContext({ ...input, services: [{ ...service, projectId: null }] }).visiblePractices.length, 1);
});

test('assigned practice access is independent from ownership of its client', () => {
  for (const assignment of [{ commercialOwnerId: commerciale.userId }, { technicalOwnerId: commerciale.userId }]) {
    const result = buildDashboardTechnicalCounterContext({ ...input, session: commerciale, practices: [{ ...practice, ...assignment }] });
    assert.equal(result.visiblePractices.length, 1);
    assert.equal(result.commsToReview, 1);
  }
  assert.equal(buildDashboardTechnicalCounterContext({ ...input, session: commerciale }).commsToReview, 0);
  // The canonical technical predicate also permits consultants independently
  // from the separate client-list ownership predicate.
  assert.equal(buildDashboardTechnicalCounterContext({ ...input, session: consulente }).commsToReview, 1);
});

test('each communication parent reference must agree with the visible practice', () => {
  for (const mismatch of [
    { technicalPracticeId: 'missing' }, { clientId: 'other' },
    { projectId: 'other' }, { projectId: null },
    { clientServiceId: 'other' }, { clientServiceId: null },
  ]) {
    assert.equal(buildDashboardTechnicalCounterContext({ ...input, communications: [{ ...communication, ...mismatch }] }).commsToReview, 0);
  }
});

test('status and usedAt select the two independent communication counters', () => {
  const communications = [
    communication,
    { ...communication, id: 'approved', status: 'approvata' as const },
    { ...communication, id: 'used-date', status: 'approvata' as const, usedAt: deletedAt },
    { ...communication, id: 'used-status', status: 'usata_inviata' as const },
    { ...communication, id: 'draft', status: 'bozza' as const },
    { ...communication, id: 'archived-communication', status: 'archiviata' as const },
    { ...communication, id: 'deleted-review', deletedAt },
    { ...communication, id: 'deleted-approved', status: 'approvata' as const, deletedAt },
  ];
  const result = buildDashboardTechnicalCounterContext({ ...input, communications });
  assert.equal(result.commsToReview, 1);
  assert.equal(result.approvedUnusedComms, 1);
});

test('deleted practices are excluded while status alone adds no new access restriction', () => {
  assert.equal(buildDashboardTechnicalCounterContext({ ...input, practices: [{ ...practice, deletedAt }] }).commsToReview, 0);
  const result = buildDashboardTechnicalCounterContext({ ...input, practices: [{ ...practice, status: 'archiviata' }] });
  assert.equal(result.visiblePractices.length, 1);
  assert.equal(result.commsToReview, 1);
});

test('all supplied communications are counted without a preview limit', () => {
  const communications = Array.from({ length: 127 }, (_, index) => ({ ...communication, id: `communication-${index}` }));
  assert.equal(buildDashboardTechnicalCounterContext({ ...input, communications }).commsToReview, 127);
  assert.deepEqual(buildDashboardTechnicalCounterContext({ ...input, practices: [], communications: [] }), {
    visiblePractices: [], visibleCommunications: [], commsToReview: 0, approvedUnusedComms: 0,
  });
});
