import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { canonicalJson, canonicalSha256 } from '../src/lib/canonical-json';
import { admitsTechnicalPrivateItemOrigin, admitsTechnicalPrivateItemCreation,
  technicalPrivateItemCommand, technicalPrivateItemInitialRow, technicalPrivateItemRequestDigest,
  type TechnicalPrivateItemAdmission, type TechnicalPrivateItemCommand,
  type TechnicalPrivateItemOrigin } from '../src/lib/technical-private-item-contract';
import { previewTechnicalPrivateItemCreation, confirmTechnicalPrivateItemCreation,
  signTechnicalPrivateItemReceipt, readTechnicalPrivateItemReceipt,
  type TechnicalPrivateItemReceipt } from '../src/lib/technical-private-item-proof';
import type { TechnicalWorkItemParent } from '../src/lib/technical-work-item-context';

const now = Date.parse('2026-10-26T16:00:00.000Z');
const key = { version: 4, secret: 'synthetic-private-item-test-key-material-only' };
const target = { kind: 'TechnicalPractice' as const, targetId: 'synthetic-practice-a' };
const command: TechnicalPrivateItemCommand = {
  commandId: '8908dbb5-d8ce-4d09-8de5-44472b37556e', itemId: '3af4ac86-074f-4c26-acb4-177e35c13e68',
  kind: 'Task', target, expectedContextSha256: 'a'.repeat(64),
  values: { title: 'Relazione tecnica', description: 'Verifica delle misure', priority: 'alta', dueAt: null },
};
const current: TechnicalPrivateItemAdmission = {
  authorityId: 'technical-assignment', authorityUserId: 'synthetic-personal-admin',
  authorityRevision: 2, authorityEnabled: true, actorId: 'synthetic-personal-admin', actorEpoch: 5,
  role: 'admin', managerAllowed: true, serviceWriteAllowed: true,
  sessionId: 'a3bfac42-f2c5-43d6-a12d-4fe93adc59ef', sessionExpiresAt: now + 900_000,
  personalProofExpiresAt: now + 600_000, keyVersion: 4, target, contextSha256: 'a'.repeat(64),
  targetOperational: true, parent: { clientId: 'synthetic-client', projectId: 'synthetic-project',
    serviceId: 'synthetic-service', companyId: 'synthetic-company' },
};
const preview = previewTechnicalPrivateItemCreation(key, command, current, now);
function confirm(raw: unknown = command, admission: unknown = current, token = preview.token, at = now + 1, yes = true) {
  return confirmTechnicalPrivateItemCreation(key, raw, admission as TechnicalPrivateItemAdmission, token, yes, at);
}

test('private creation requires an exact personal confirmation with a freshly matching admission', () => {
  assert.deepEqual(confirm(), { command, requestDigest: technicalPrivateItemRequestDigest(command) });
  assert.equal(confirm(command, current, preview.token, now + 1, false), null);
  assert.equal(confirm(command, current, preview.token, now - 1), null);
  assert.equal(confirm(command, current, preview.token, now + 300_000), null);
  assert.equal(confirm(command, current, preview.token, NaN), null);
});

test('another Admin, a technician or a new session cannot consume the personal preview', () => {
  const deltas = [{ actorId: 'synthetic-other-admin' }, { authorityUserId: 'synthetic-other-admin' },
    { actorId: 'synthetic-tech', role: 'consulente' }, { role: 'backoffice' },
    { sessionId: 'c8dcd7f8-79e0-4b72-a12f-1634113ecb67' }];
  for (const delta of deltas) assert.equal(confirm(command, { ...current, ...delta }), null);
});

test('permission, binding, session, personal proof, lifecycle and context changes revoke open previews', () => {
  const deltas = [{ authorityEnabled: false }, { authorityRevision: 3 }, { actorEpoch: 6 }, { managerAllowed: false },
    { serviceWriteAllowed: false }, { keyVersion: 5 }, { targetOperational: false }, { contextSha256: 'b'.repeat(64) },
    { sessionExpiresAt: now }, { personalProofExpiresAt: now },
    { target: { ...target, targetId: 'synthetic-practice-b' } },
    { parent: { ...current.parent, projectId: 'synthetic-other-project' } }];
  for (const delta of deltas) assert.equal(confirm(command, { ...current, ...delta }), null);
});

test('the earliest session or personal proof boundary closes preview consumption', () => {
  for (const field of ['sessionExpiresAt', 'personalProofExpiresAt'] as const) {
    const short = { ...current, [field]: now + 1_000 };
    const token: string = previewTechnicalPrivateItemCreation(key, command, short, now).token;
    assert.ok(confirm(command, short, token, now + 999));
    assert.equal(confirm(command, short, token, now + 1_000), null);
    assert.throws(() => previewTechnicalPrivateItemCreation(key, command, { ...short, [field]: now }, now));
  }
});

test('neither a source association nor a grant can be smuggled into the closed creation payload', () => {
  for (const field of ['recipientId', 'assignedToId', 'createdById', 'clientId', 'projectId', 'serviceId',
    'documentId', 'versionId', 'status', 'grant', 'notification', 'privateOrigin']) {
    assert.equal(technicalPrivateItemCommand.safeParse({ ...command, [field]: 'unexpected' }).success, false);
    assert.equal(technicalPrivateItemCommand.safeParse({ ...command, values: { ...command.values, [field]: 'unexpected' } }).success, false);
  }
});

test('changed text, command identity, item identity or target invalidates the preview rather than creating a second row', () => {
  for (const delta of [{ commandId: '8c76ea27-a215-4412-844b-cc57eb3d4684' },
    { itemId: 'a1c8791a-07ee-45d2-b6a4-9a9ce8d2a795' }, { values: { ...command.values, description: 'Altro testo' } },
    { values: { ...command.values, priority: 'urgente' } }, { target: { ...target, targetId: 'synthetic-practice-b' } }]) {
    assert.equal(confirm({ ...command, ...delta }), null);
  }
  assert.notEqual(technicalPrivateItemRequestDigest(command),
    technicalPrivateItemRequestDigest({ ...command, values: { ...command.values, description: 'Altro testo' } }));
});

test('canonical preview displays normalized text/date and confirmation cannot silently normalize a different payload', () => {
  const raw = { ...command, values: { ...command.values, title: '  Relazione tecnica  ', dueAt: '2026-10-27T09:00:00+01:00' } };
  const normalized = previewTechnicalPrivateItemCreation(key, raw, current, now);
  assert.equal(normalized.command.kind, 'Task');
  assert.equal(normalized.command.values.title, 'Relazione tecnica');
  assert.equal(confirm(raw, current, normalized.token), null);
  assert.ok(confirm(normalized.command, current, normalized.token));
});

test('private initial rows derive canonical links and fixed initial state without assignee or document', () => {
  const task = technicalPrivateItemInitialRow(command, current, now);
  assert.ok(task && 'assignedToId' in task);
  assert.equal(task.assignedToId, null); assert.equal(task.completedAt, null); assert.equal(task.status, 'aperta');
  assert.equal(task.clientId, current.parent.clientId); assert.equal(task.clientServiceId, current.parent.serviceId);
  assert.equal(task.createdById, current.actorId); assert.equal(task.id, command.itemId);
  const check: TechnicalPrivateItemCommand = { ...command, kind: 'ChecklistItem', values: { title: 'Foto impianto', notes: null } };
  const row = technicalPrivateItemInitialRow(check, current, now);
  assert.ok(row && 'documentId' in row);
  assert.equal(row.documentId, null); assert.equal(row.status, 'da_richiedere'); assert.equal(row.active, true);
  assert.equal(technicalPrivateItemInitialRow(command, { ...current, contextSha256: 'f'.repeat(64) }, now), null);
});

test('financial titles, unknown classifications, oversized content and malformed dates are not admitted', () => {
  for (const title of ['Contratto firmato', 'Ricevuta pagamento']) {
    assert.equal(technicalPrivateItemCommand.safeParse({ ...command, values: { ...command.values, title } }).success, false);
  }
  for (const values of [{ ...command.values, title: 'x'.repeat(201) }, { ...command.values, description: 'x'.repeat(5001) },
    { ...command.values, priority: 'unknown' }, { ...command.values, dueAt: 'not-a-date' }]) {
    assert.equal(technicalPrivateItemCommand.safeParse({ ...command, values }).success, false);
  }
});

test('tampering, malformed envelope, changed key and a different protocol domain do not authorize creation', () => {
  assert.equal(confirm(command, current, preview.token + '='), null);
  assert.equal(confirm(command, current, 'A'.repeat(48_001)), null);
  const parsed = JSON.parse(Buffer.from(preview.token, 'base64url').toString('utf8'));
  parsed.payload.command.values.description = 'Manipolata';
  assert.equal(confirm(command, current, Buffer.from(canonicalJson(parsed)).toString('base64url')), null);
  parsed.proof = createHmac('sha256', key.secret).update('FAI_TECHNICAL_WORK_ITEM_V1:preview:4:')
    .update(canonicalJson(parsed.payload)).digest('hex');
  assert.equal(confirm(command, current, Buffer.from(canonicalJson(parsed)).toString('base64url')), null);
  assert.equal(confirmTechnicalPrivateItemCreation({ ...key, secret: 'synthetic-other-key-material-only-99' },
    command, current, preview.token, true, now + 1), null);
});

const parent: TechnicalWorkItemParent = { target, ...current.parent, contextSha256: current.contextSha256, operational: true };
const origin: TechnicalPrivateItemOrigin = { protocol: 'TECHNICAL_PRIVATE_ITEM_ORIGIN_V1',
  commandId: command.commandId, kind: command.kind, itemId: command.itemId, target, ...current.parent,
  actorId: current.actorId, createdAt: new Date(now).toISOString() };

test('origin constrains the exact target even when two practices share every client/project/service link', () => {
  assert.equal(admitsTechnicalPrivateItemOrigin(origin, command, parent), true);
  assert.equal(admitsTechnicalPrivateItemOrigin(origin, command, { ...parent, target: { ...target, targetId: 'synthetic-practice-b' } }), false);
  assert.equal(admitsTechnicalPrivateItemOrigin(origin, command, { ...parent, target: { kind: 'Project', targetId: parent.projectId! } }), false);
  for (const field of ['clientId', 'projectId', 'serviceId', 'companyId'] as const) {
    assert.equal(admitsTechnicalPrivateItemOrigin(origin, command, { ...parent, [field]: 'synthetic-other' }), false);
  }
});

test('missing/corrupt origin fails closed; explicit successful no-origin lookup retains historical behavior', () => {
  for (const value of [undefined, {}, { ...origin, kind: 'Other' }, { ...origin, itemId: 'wrong' },
    { ...origin, grant: true }, { ...origin, target: { ...target, targetId: 'other' } }]) {
    assert.equal(admitsTechnicalPrivateItemOrigin(value, command, parent), false);
  }
  assert.equal(admitsTechnicalPrivateItemOrigin(null, { kind: 'Task', itemId: 'historical-cuid' }, parent), true);
  assert.equal(admitsTechnicalPrivateItemOrigin(null, command, { ...parent, operational: false }), false);
  assert.equal(admitsTechnicalPrivateItemOrigin(origin, { ...command, kind: 'ChecklistItem' }, parent), false);
  assert.equal(admitsTechnicalPrivateItemCreation(command, { ...current, parent: { ...current.parent, clientId: null } }, now), false);
});

const receipt: TechnicalPrivateItemReceipt = { protocol: 'TECHNICAL_PRIVATE_ITEM_RECEIPT_V1',
  commandId: command.commandId, itemId: command.itemId, kind: command.kind, target,
  actorId: current.actorId, sessionId: current.sessionId, authorityRevision: current.authorityRevision,
  keyVersion: key.version, requestDigest: technicalPrivateItemRequestDigest(command), admissionSha256: canonicalSha256(current),
  recordedAt: new Date(now + 1).toISOString(), grantCreated: false, notificationCreated: false };
const signature = signTechnicalPrivateItemReceipt(key, receipt);

test('lost-response reconciliation binds the exact command and session without inventing a grant or notification', () => {
  assert.deepEqual(readTechnicalPrivateItemReceipt(key, receipt, signature, receipt, now + 2), receipt);
  for (const delta of [{ actorId: 'other' }, { sessionId: '888cb1c2-a560-4b42-89df-73ee6e3b0387' },
    { requestDigest: 'e'.repeat(64) }, { target: { ...target, targetId: 'other' } }, { kind: 'ChecklistItem' as const }]) {
    assert.equal(readTechnicalPrivateItemReceipt(key, receipt, signature, { ...receipt, ...delta }, now + 2), null);
  }
  assert.equal(readTechnicalPrivateItemReceipt(key, receipt, signature, receipt, now), null);
  for (const delta of [{ grantCreated: true }, { notificationCreated: true }, { title: 'Unselected content' }]) {
    assert.equal(readTechnicalPrivateItemReceipt(key, { ...receipt, ...delta }, signature, receipt, now + 2), null);
  }
});
