import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { ApprovedMessageSnapshot } from '../src/lib/approved-communication-contract';
import type { OrdinaryChannel } from '../src/lib/ordinary-email-candidate';
import { previewOrdinaryDecision, confirmOrdinaryDecision, checkPersistedOrdinaryDecision, type OrdinaryDecisionCurrentState } from '../src/lib/ordinary-email-decision';
import { createPrivilegedStepUpToken } from '../src/lib/privileged-step-up-token';

const now = new Date('2026-10-16T12:00:00Z'), later = new Date(now.getTime() + 10 * 60_000);
const key = { version: 1, secret: 'synthetic-ordinary-decision-test-key-000000000000000' };
const bytes = Buffer.from('SYNTHETIC VERSION ONE\n');
const snapshot: ApprovedMessageSnapshot = { schema: 'fai.approved-email.v1', channel: 'EMAIL_MANUAL', messageId: randomUUID(), revision: 1,
  context: { kind: 'TECHNICAL', id: 'synthetic-practice' }, clientId: 'synthetic-client', mailboxId: randomUUID(), mailboxRevision: 1,
  from: 'comunicazioni@finanzaagevolaimpresa.it', replyTo: 'comunicazioni@finanzaagevolaimpresa.it',
  to: ['recipient@invalid.test'], cc: ['visible@invalid.test'], bcc: ['hidden@invalid.test'],
  subject: 'Decisione sintetica', body: 'Contenuto esterno non autorevole.', classification: 'ORDINARY',
  attachments: [{ documentId: 'doc-one', versionId: 'version-one', sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length, filename: 'synthetic.txt', mimeType: 'text/plain' }] };
const channel: OrdinaryChannel = { purpose: 'ORDINARY_SMTP', mailboxId: snapshot.mailboxId, mailboxRevision: 1,
  address: 'comunicazioni@finanzaagevolaimpresa.it', providerReference: 'register_it', configurationReference: 'M4_COMUNICAZIONI_REGISTER_IT',
  channelRevision: 1, qualificationReference: 'SYNTHETIC_ONLY' };
const material = { snapshot, channel, materials: new Map([['version-one', bytes]]) };
const current: OrdinaryDecisionCurrentState = { actor: { userId: 'synthetic-personal-authority', sessionId: randomUUID(),
  role: 'admin', active: true, expiresAt: later, registryExpiresAt: later }, authority: { id: 'ordinary-email', purpose: 'ORDINARY_EMAIL',
  userId: 'synthetic-personal-authority', mailboxId: snapshot.mailboxId, revision: 1, enabled: true }, contextHash: 'a'.repeat(64) };
const credentials = { sessionToken: 'synthetic-session-cookie', stepUpToken: createPrivilegedStepUpToken({ key,
  userId: current.actor.userId, sessionToken: 'synthetic-session-cookie', nowSeconds: now.getTime() / 1000 }) };
const preview = () => previewOrdinaryDecision(material, current, key, now);
const confirm = (token: string, next = material, state = current, auth = credentials, clock = now) =>
  confirmOrdinaryDecision(token, next, state, key, auth, clock);

test('stored decisions require their signature, exact current materials and authority before a lease', () => {
  const result=confirm(preview().token);
  assert.equal(checkPersistedOrdinaryDecision(result.decision,result.proof,material,current,key,now).prepared.mimeHash,result.prepared.mimeHash);
  assert.throws(()=>checkPersistedOrdinaryDecision(result.decision,'0'.repeat(64),material,current,key,now));
  assert.throws(()=>checkPersistedOrdinaryDecision({...result.decision,contextHash:'0'.repeat(64)},result.proof,material,current,key,now));
  assert.throws(()=>checkPersistedOrdinaryDecision(result.decision,result.proof,material,{...current,authority:{...current.authority,revision:2}},key,now));
  assert.throws(()=>checkPersistedOrdinaryDecision(result.decision,result.proof,{...material,snapshot:{...snapshot,bcc:[]}},current,key,now));
  assert.throws(()=>checkPersistedOrdinaryDecision(result.decision,result.proof,material,current,key,later));
});
test('authorized material expiry bounds both preview lifetime and confirmation', () => {
  const contextExpiresAt=new Date(now.getTime()+1000), state={...current,contextExpiresAt};
  const shown=previewOrdinaryDecision(material,state,key,now);
  assert.equal(shown.expiresAt,contextExpiresAt.toISOString());
  assert.throws(()=>confirm(shown.token,material,state,credentials,contextExpiresAt));
  assert.throws(()=>previewOrdinaryDecision(material,{...state,contextExpiresAt:now},key,now));
});

test('ordinary decision binds the exact MIME and canonical personal actor; proof and preview disclose no content or cookie', () => {
  const shown = preview(), confirmed = confirm(shown.token);
  assert.deepEqual(shown.summary.bcc, snapshot.bcc);
  assert.equal(confirmed.decision.actorId, current.actor.userId);
  assert.equal(confirmed.decision.mimeHash, createHash('sha256').update(confirmed.prepared.mime).digest('hex'));
  assert.equal(confirmed.decision.intentHash, confirmed.prepared.intentHash);
  assert.match(confirmed.proof, /^[a-f0-9]{64}$/);
  const payload = Buffer.from(shown.token.split('.')[1], 'base64url').toString();
  for (const sensitive of [...snapshot.to, ...snapshot.bcc, snapshot.body, credentials.sessionToken, key.secret]) {
    assert.ok(!payload.includes(sensitive)); assert.ok(!JSON.stringify(confirmed.decision).includes(sensitive));
  }
});

test('project-sharing, another admin, commercial actor, disabled or revised email authority cannot decide', () => {
  const token = preview().token;
  const states: OrdinaryDecisionCurrentState[] = [
    { ...current, actor: { ...current.actor, userId: 'other-admin' } },
    { ...current, actor: { ...current.actor, role: 'commerciale' } },
    { ...current, actor: { ...current.actor, active: false } },
    { ...current, authority: { ...current.authority, enabled: false } },
    { ...current, authority: { ...current.authority, revision: 2 } },
    { ...current, authority: { ...current.authority, userId: 'other-admin' } },
    { ...current, authority: { ...current.authority, mailboxId: randomUUID() } },
    { ...current, authority: { ...current.authority, id: 'project-sharing', purpose: 'PROJECT_SHARING' } as unknown as OrdinaryDecisionCurrentState['authority'] },
  ];
  for (const state of states) assert.throws(() => confirm(token, material, state));
});

test('existing step-up is mandatory and bound to this user, cookie, key and time', () => {
  const token = preview().token;
  assert.throws(() => confirmOrdinaryDecision(token, material, current, key, { ...credentials, stepUpToken: undefined }, now));
  assert.throws(() => confirm(token, material, current, { ...credentials, sessionToken: 'other-session-cookie' }));
  const otherUser = createPrivilegedStepUpToken({ key, userId: 'other-admin', sessionToken: credentials.sessionToken, nowSeconds: now.getTime() / 1000 });
  assert.throws(() => confirm(token, material, current, { ...credentials, stepUpToken: otherUser }));
  assert.throws(() => confirmOrdinaryDecision(token, material, current, { ...key, version: 2 }, credentials, now));
  assert.throws(() => confirmOrdinaryDecision(token, material, current, { ...key, secret: 'other-synthetic-key-0000000000000000000' }, credentials, now));
});

test('editing any recipient, body, attachment, sender or channel invalidates the preview', () => {
  const token = preview().token;
  const edits: Partial<ApprovedMessageSnapshot>[] = [{ to: ['other@invalid.test'] }, { cc: [] }, { bcc: [] },
    { subject: 'Changed' }, { body: 'Changed' }, { attachments: [] }, { revision: 2 },
    { from: 'other@invalid.test' }, { replyTo: 'other@invalid.test' },
    { attachments: [{ ...snapshot.attachments[0], filename: 'other.txt' }] },
    { attachments: [{ ...snapshot.attachments[0], mimeType: 'application/pdf' }] }];
  for (const edit of edits) assert.throws(() => confirm(token, { ...material, snapshot: { ...snapshot, ...edit } }));
  assert.throws(() => confirm(token, { ...material, channel: { ...channel, channelRevision: 2 } }));
  assert.throws(() => confirm(token, { ...material, channel: { ...channel, qualificationReference: 'OTHER_QUALIFICATION' } }));
  assert.throws(() => confirm(token, { ...material, materials: new Map([['version-one', Buffer.from('changed')]]) }));
});

test('changed policy context or session, either expiry and expired/future previews are denied', () => {
  const token = preview().token;
  for (const state of [
    { ...current, contextHash: 'b'.repeat(64) },
    { ...current, actor: { ...current.actor, sessionId: randomUUID() } },
    { ...current, actor: { ...current.actor, expiresAt: now } },
    { ...current, actor: { ...current.actor, registryExpiresAt: now } },
  ]) assert.throws(() => confirm(token, material, state));
  assert.throws(() => confirm(token, material, current, credentials, new Date(now.getTime() + 5 * 60_000)));
  assert.throws(() => confirm(token, material, current, credentials, new Date(now.getTime() - 1)));
});

test('forged, oversized or other-purpose proofs fail; repeated preview use retains one consumption identity', () => {
  const token = preview().token, [prefix, encoded, signature] = token.split('.');
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString()); payload.authorityRevision = 9;
  for (const wrong of [token + '0', 'x'.repeat(5000), credentials.stepUpToken, `${prefix}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${signature}`,
    `${prefix}.${encoded}.${'0'.repeat(64)}`]) assert.throws(() => confirm(wrong));
  // The pure contract cannot consume a DB row. The future atomic unique
  // reservation must reject this same decisionId even with another request ID.
  assert.equal(confirm(token).decision.decisionId, confirm(token).decision.decisionId);
  assert.notEqual(confirm(token).decision.decisionId, confirm(preview().token).decision.decisionId);
});
