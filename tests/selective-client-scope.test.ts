import assert from 'node:assert/strict';
import test from 'node:test';
import type { Prisma } from '@prisma/client';
import { assertNoSelectiveClientMutation, loadSelectiveClientScope } from '../src/lib/selective-client-scope';

type Row = Record<string, unknown>;
type Table = Record<string, Row[]>;
type Query = { where: Row; select: Row };

// Identifier-graph tests, not PostgreSQL or concurrency qualification. The
// fake applies predicates instead of returning fixtures regardless of scope.
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return (value as Row[]).some(item => matches(row, item));
    if (value && typeof value === 'object' && 'in' in value) return (value.in as unknown[]).includes(row[key]);
    return row[key] === value;
  });
}
function project(row: Row, select: Row): Row {
  return Object.fromEntries(Object.entries(select).map(([key, selection]) => {
    if (selection === true) return [key, row[key] ?? null];
    const nested = (selection as { select: Row }).select;
    const value = row[key];
    if (Array.isArray(value)) return [key, value.map(item => project(item, nested))];
    if (key === 'acceptance') return [key, value ? project(value as Row, nested) : null];
    return [key, []];
  }));
}
function database(tables: Table) {
  const calls: Array<{ table: string; operation: string; query?: Query }> = [];
  const db = new Proxy({}, { get: (_target, name: string) => {
    if (name === '$queryRaw') return async (parts: TemplateStringsArray | Prisma.Sql) => {
      const sql = ('strings' in parts ? parts.strings : parts).join('?');
      if (sql.includes('FROM "TechnicalAssignment"')) {
        calls.push({ table: 'TechnicalAssignment', operation: 'read', query: { where: {},
          select: { id: true, kind: true, projectId: true, practiceId: true } } }); return [];
      }
      assert.match(sql, /FROM "User"/);
      calls.push({ table: 'User', operation: 'lock' }); return [{ id: 'recipient', active: true, deletedAt: null }];
    };
    return new Proxy({}, { get: (_delegate, operation: string) => async (query: Query) => {
      assert.ok(['findMany', 'findFirst'].includes(operation), `unexpected mutation: ${name}.${operation}`);
      calls.push({ table: name, operation, query });
      const rows = (tables[name] ?? []).filter(row => matches(row, query.where)).map(row => project(row, query.select));
      return operation === 'findFirst' ? rows[0] ?? null : rows;
    } });
  } }) as Prisma.TransactionClient;
  return { db, calls };
}
function fixture(): Table {
  return {
    selectiveClientGrant: [
      { id: 'grant-selected', recipientId: 'recipient', clientId: 'client-selected', revokedAt: new Date(),
        payload: { expiresAt: '2000-01-01T00:00:00Z' }, proof: 'invalid', revisions: [{ id: 'history-selected', commandId: 'command-selected' }] },
      { id: 'grant-other-recipient', recipientId: 'someone-else', clientId: 'client-other', revisions: [] },
    ],
    client: [{ id: 'client-selected', leadId: 'lead-legacy' }, { id: 'client-other' }],
    company: [{ id: 'company-selected', clientId: 'client-selected' }, { id: 'company-other', clientId: 'client-other' }],
    companyPerson: [{ id: 'membership-selected', companyId: 'company-selected', personId: 'person-shared' },
      { id: 'membership-other', companyId: 'company-other', personId: 'person-shared' }],
    lead: [{ id: 'lead-selected', clientId: 'client-selected' }, { id: 'lead-legacy', clientId: null }, { id: 'lead-other', clientId: 'client-other' }],
    project: [{ id: 'project-selected', clientId: 'client-selected' },
      { id: 'project-conflicting-company', clientId: 'client-other', companyId: 'company-selected' },
      { id: 'project-other', clientId: 'client-other', companyId: 'company-other' }],
    clientService: [{ id: 'service-selected', clientId: 'client-selected', contractId: 'contract-shared', paymentId: 'payment-linked' },
      { id: 'service-project-only', clientId: 'client-other', projectId: 'project-selected' },
      { id: 'service-other', clientId: 'client-other', projectId: 'project-other', contractId: 'contract-shared' }],
    contract: [{ id: 'contract-shared', clientId: 'client-other', projectId: 'project-other', signedDocumentId: 'document-contract' }],
    payment: [{ id: 'payment-linked', contractId: 'contract-shared', clientId: 'client-other', accountingDocumentId: 'document-payment' }],
    document: [{ id: 'document-client', clientId: 'client-selected' }, { id: 'document-company', companyId: 'company-selected' },
      { id: 'document-service', clientServiceId: 'service-project-only' }, { id: 'document-contract' }, { id: 'document-payment' },
      { id: 'document-other', clientId: 'client-other', projectId: 'project-other' }],
    commercialOffer: [{ id: 'offer-client', clientId: 'client-selected' }, { id: 'offer-lead', leadId: 'lead-legacy' }, { id: 'offer-other', clientId: 'client-other' }],
  };
}

test('no historical selection performs no unrelated resource enumeration', async () => {
  const { db, calls } = database({});
  const scope = await loadSelectiveClientScope(db, 'recipient');
  assert.ok(Object.values(scope).every(value => value.length === 0));
  assert.deepEqual(calls.map(row => row.table), ['selectiveClientGrant', 'TechnicalAssignment']);
});

test('revoked, expired and invalid selections still exclude only the recipient client graph', async () => {
  const { db } = database(fixture());
  const scope = await loadSelectiveClientScope(db, 'recipient');
  assert.deepEqual(scope.selectiveClientIds, ['client-selected']);
  assert.deepEqual(scope.selectiveClientCompanyIds, ['company-selected']);
  assert.deepEqual(scope.selectiveClientPersonIds, ['person-shared']);
  assert.deepEqual(scope.selectiveClientLeadIds, ['lead-selected', 'lead-legacy']);
  assert.deepEqual(scope.selectiveClientProjectIds, ['project-selected', 'project-conflicting-company']);
  assert.deepEqual(scope.selectiveClientServiceIds, ['service-selected', 'service-project-only']);
  assert.deepEqual(scope.selectiveClientContractIds, ['contract-shared']);
  assert.deepEqual(scope.selectiveClientOfferIds, ['offer-client', 'offer-lead']);
  assert.ok(scope.selectiveClientAuditEntityIds.includes('command-selected'));
  assert.ok(scope.selectiveClientAuditEntityIds.includes('history-selected'));
  for (const id of ['client-other', 'company-other', 'membership-other', 'project-other', 'service-other', 'offer-other', 'document-other']) {
    assert.ok(!scope.selectiveClientAuditEntityIds.includes(id), `unrelated resource: ${id}`);
  }
});

test('shared contracts restrict their documents without recursively restricting an unrelated client', async () => {
  const { db } = database(fixture());
  const scope = await loadSelectiveClientScope(db, 'recipient');
  for (const id of ['document-client', 'document-company', 'document-service', 'document-contract', 'document-payment']) {
    assert.ok(scope.selectiveClientDocumentIds.includes(id), id);
  }
  assert.ok(!scope.selectiveClientDocumentIds.includes('document-other'));
  assert.ok(!scope.selectiveClientIds.includes('client-other'));
  assert.ok(!scope.selectiveClientProjectIds.includes('project-other'));
});

test('practice evidence protects referenced versions and documents and keeps UUID resource domains separate', async () => {
  const tables = fixture();
  const readinessId = '00000000-0000-4000-8000-000000000001';
  tables.practiceReadiness = [{ id: readinessId, clientId: 'client-selected', controlledIntakeId: '00000000-0000-4000-8000-000000000002',
    commercialOfferId: 'offer-practice', acceptedOfferRevisionId: '00000000-0000-4000-8000-000000000003',
    materials: [{ id: '00000000-0000-4000-8000-000000000004', documentVersionId: 'version-referenced', checklistItemId: 'checklist-linked' }] }];
  tables.documentVersion = [{ id: 'version-referenced', documentId: 'document-from-version' }, { id: 'version-other', documentId: 'document-other' }];
  tables.document!.push({ id: 'document-from-version', clientId: 'client-other' });
  tables.documentChecklistItem = [{ id: 'checklist-linked', clientId: 'client-other' }];
  tables.technicalPractice = [{ id: 'technical-selected', clientId: 'client-selected' }];
  const { db, calls } = database(tables);
  const scope = await loadSelectiveClientScope(db, 'recipient');
  assert.deepEqual(scope.selectiveClientReadinessIds, [readinessId]);
  assert.deepEqual(scope.selectiveClientTechnicalPracticeIds, ['technical-selected']);
  assert.ok(scope.selectiveClientDocumentIds.includes('document-from-version'));
  assert.ok(scope.selectiveClientAuditEntityIds.includes('checklist-linked'));
  assert.ok(scope.selectiveClientAuditEntityIds.includes('version-referenced'));
  assert.ok(!scope.selectiveClientDocumentIds.includes('version-referenced'));
  const communication = calls.find(call => call.table === 'approvedCommunication')!.query!;
  const predicates = communication.where.OR as Row[];
  assert.deepEqual(predicates.find(row => 'readinessId' in row), { readinessId: { in: [readinessId] } });
  assert.deepEqual(predicates.find(row => 'technicalPracticeId' in row), { technicalPracticeId: { in: ['technical-selected'] } });
});

test('indirect email, AI and record-update audit IDs are excluded without loading private contents', async () => {
  const tables = fixture();
  tables.approvedCommunication = [{ id: 'message-selected', clientId: 'client-selected', subject: 'synthetic-private',
    versions: [{ id: 'message-version' }], events: [{ id: 'message-event' }], replies: [{ id: 'reply-selected' }] }];
  tables.aiExecutionRequest = [{ id: 'request-selected', companyId: 'company-selected', prompt: 'synthetic-private', decisions: [{ id: 'decision-selected' }] }];
  tables.aiRun = [{ id: 'run-selected', aiExecutionRequestId: 'request-selected' }];
  tables.aiOutput = [{ id: 'output-selected', aiRunId: 'run-selected' }];
  tables.recordUpdateEvent = [{ id: 'update-selected', kind: 'CLIENT', recordId: 'client-selected', deliveries: [{ id: 'delivery-selected' }] },
    { id: 'update-other', kind: 'CLIENT', recordId: 'client-other', deliveries: [{ id: 'delivery-other' }] }];
  const { db, calls } = database(tables);
  const scope = await loadSelectiveClientScope(db, 'recipient');
  for (const id of ['message-selected', 'message-version', 'message-event', 'reply-selected', 'request-selected',
    'decision-selected', 'run-selected', 'output-selected', 'update-selected', 'delivery-selected']) {
    assert.ok(scope.selectiveClientAuditEntityIds.includes(id), id);
  }
  assert.ok(!scope.selectiveClientAuditEntityIds.includes('delivery-other'));
  assert.ok(!JSON.stringify(scope).includes('synthetic-private'));
  for (const call of calls) assert.doesNotMatch(JSON.stringify(call.query?.select), /"(?:subject|body|prompt|content|notes|email|storagePath|payload|proof)"/);
});

test('transaction mutation check locks the recipient and rejects either old or proposed selected client', async () => {
  for (const clientIds of [['client-selected', 'client-other'], ['client-other', 'client-selected']]) {
    const { db, calls } = database(fixture());
    await assert.rejects(assertNoSelectiveClientMutation(db, 'recipient', ...clientIds), /SELECTIVE_CLIENT_READ_ONLY/);
    assert.equal(calls[0]!.operation, 'lock');
    assert.equal(calls[1]!.table, 'selectiveClientGrant');
  }
  const { db } = database(fixture());
  await assertNoSelectiveClientMutation(db, 'recipient', 'client-other');
});
