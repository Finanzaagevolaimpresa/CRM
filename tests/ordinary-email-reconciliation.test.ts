import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, link } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson } from '../src/lib/canonical-json';
import { signOrdinaryRecoveryPreview, verifyOrdinaryRecoveryPreview, ordinaryRecoveryConfirmation } from '../src/lib/ordinary-email-reconciliation-contract';
import type { OrdinaryAttemptRequest } from '../src/lib/ordinary-email-smtp-candidate';

let root: string, api: typeof import('../src/lib/ordinary-email-observation');
test.before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(),'fai-smtp-observation-'));
  process.env.LOCAL_DOCUMENT_STORAGE_ROOT = root;
  api = await import('../src/lib/ordinary-email-observation');
});
function fixture() {
  const attemptId = randomUUID(), lease = { attemptId, leaseId: randomUUID(), committed: true as const, expiresAt: new Date(Date.now()+15000).toISOString() };
  const request = { attemptId, intentHash: 'a'.repeat(64), mimeHash: 'b'.repeat(64), envelopeHash: 'c'.repeat(64) } as OrdinaryAttemptRequest;
  const result = { outcome: 'ACCEPTED' as const, phase: 'CONTENT' as const, replyCode: 250 };
  return { lease, request, result, now: new Date() };
}
test('private observation binds one claim and exact MIME/envelope; neither current key rotation nor browser choices supplies proof', () => {
  const f=fixture(), sealed=api.sealOrdinaryObservation(f.lease,f.request,f.result,f.now);
  assert.equal(api.verifyOrdinaryObservation(sealed,f.lease,f.request).observation.outcome,'ACCEPTED');
  assert.doesNotMatch(JSON.stringify(sealed), new RegExp(f.lease.leaseId));
  for (const change of [
    () => api.verifyOrdinaryObservation(sealed,{ ...f.lease, leaseId: randomUUID() },f.request),
    () => api.verifyOrdinaryObservation(sealed,{ ...f.lease, attemptId: randomUUID() },f.request),
    () => api.verifyOrdinaryObservation(sealed,f.lease,{ ...f.request, mimeHash:'d'.repeat(64) }),
    () => api.verifyOrdinaryObservation({ ...sealed,observation:{ ...sealed.observation,observedAt:new Date(0).toISOString() } },f.lease,f.request),
  ]) assert.throws(change);
});
test('uncertainty, absent final reply and a 250 labelled NOT_SENT cannot become definitive evidence', () => {
  const f=fixture();
  for (const result of [{ outcome:'UNCERTAIN',phase:'CONTENT',replyCode:250 },
    { outcome:'NOT_SENT',phase:'CONTENT' }, { outcome:'NOT_SENT',phase:'CONTENT',replyCode:250 },
    { outcome:'ACCEPTED',phase:'RCPT',replyCode:250 }]) {
    assert.throws(() => api.sealOrdinaryObservation(f.lease,f.request,result as typeof f.result,f.now));
  }
  assert.equal(api.sealOrdinaryObservation(f.lease,f.request,{ outcome:'NOT_SENT',phase:'DATA',replyCode:354 },f.now).observation.outcome,'NOT_SENT');
});
test('journal survives reopening, is idempotent for exact bytes, and refuses overwrite, truncation and hard links', async () => {
  const f=fixture(); await api.writeOrdinaryObservation(f.lease,f.request,f.result,f.now);
  const sealed=await api.readOrdinaryObservation(f.lease.attemptId);
  await api.writeOrdinaryObservation(f.lease,f.request,f.result,f.now);
  assert.equal(api.verifyOrdinaryObservation(sealed,f.lease,f.request).observation.outcome,'ACCEPTED');
  const file=path.join(root,'ordinary-email-observations',f.lease.attemptId+'.json');
  const before=await readFile(file);
  await assert.rejects(api.writeOrdinaryObservation(f.lease,f.request,{ outcome:'NOT_SENT',phase:'CONTENT',replyCode:550 },f.now));
  assert.deepEqual(await readFile(file),before);
  const partial=fixture(); await writeFile(path.join(root,'ordinary-email-observations',partial.lease.attemptId+'.json'),'{');
  await assert.rejects(api.readOrdinaryObservation(partial.lease.attemptId));
  await assert.rejects(api.writeOrdinaryObservation(partial.lease,partial.request,partial.result,partial.now));
  const linked=fixture(); await link(file,path.join(root,'ordinary-email-observations',linked.lease.attemptId+'.json'));
  await assert.rejects(api.readOrdinaryObservation(linked.lease.attemptId));
});
test('journal rejects unknown fields, altered MAC, unsafe IDs and missing sources without inventing an outcome', async () => {
  const f=fixture(), sealed=api.sealOrdinaryObservation(f.lease,f.request,f.result,f.now);
  await assert.rejects(api.readOrdinaryObservation('../outside'));
  await assert.rejects(api.readOrdinaryObservation(f.lease.attemptId));
  const file=path.join(root,'ordinary-email-observations',f.lease.attemptId+'.json');
  await writeFile(file,canonicalJson({ ...sealed,additional:'untrusted' }));
  await assert.rejects(api.readOrdinaryObservation(f.lease.attemptId));
  assert.throws(() => api.verifyOrdinaryObservation({ ...sealed,mac:'0'.repeat(64) },f.lease,f.request));
});
test('recovery preview has its own exact five-minute lifetime, key binding and strict confirmation contract', () => {
  const now=new Date('2026-11-01T09:00:00Z'), key={version:1,secret:'synthetic-reconciliation-key-000000000000000'};
  const payload={protocol:'FAI_ORDINARY_EMAIL_RECOVERY_PREVIEW_V1' as const,messageId:randomUUID(),attemptId:randomUUID(),
    commandId:randomUUID(),actorId:'synthetic-admin',sessionId:randomUUID(),keyVersion:1,sourceHash:'a'.repeat(64),
    stateHash:'b'.repeat(64),outcome:'ACCEPTED' as const,issuedAt:now.toISOString(),expiresAt:new Date(now.getTime()+300000).toISOString()};
  const token=signOrdinaryRecoveryPreview(payload,key);
  assert.deepEqual(verifyOrdinaryRecoveryPreview(token,key,new Date(now.getTime()+299999)),payload);
  assert.throws(() => verifyOrdinaryRecoveryPreview(token,key,new Date(now.getTime()+300000)));
  assert.throws(() => verifyOrdinaryRecoveryPreview(token,{...key,version:2},now));
  assert.throws(() => verifyOrdinaryRecoveryPreview(token,key,new Date(now.getTime()-1)));
  assert.equal(ordinaryRecoveryConfirmation.safeParse({messageId:payload.messageId,attemptId:payload.attemptId,token,reason:'Motivo',confirmed:true,outcome:'ACCEPTED'}).success,false);
});
