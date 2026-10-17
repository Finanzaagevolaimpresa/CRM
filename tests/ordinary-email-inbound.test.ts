import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { CommunicationReply, Prisma } from '@prisma/client';
import { filterAdmittedOrdinaryReplies } from '../src/lib/ordinary-email-inbound-reader';
import { createOrdinaryInboundSource, consumeInboundReceipt, inboundQualificationReference, assertInboundSource,
  type InboundBinding, type InboundDescriptor } from '../src/lib/ordinary-email-inbound-contract';

function fixture() {
  const descriptor: InboundDescriptor = { protocol: 'IMAP_UID', host: 'inbound.invalid.test', port: 993, security: 'TLS',
    minVersion: 'TLSv1.2', rejectUnauthorized: true, folder: 'INBOX', generation: 'synthetic-generation', authenticationReference: 'SYNTHETIC_ONLY' };
  const key = { version: 1, secret: 'synthetic-inbound-key-not-real-0000000000000000' };
  const configuration = { descriptor, credential: 'synthetic-only' };
  const binding: InboundBinding = { id: randomUUID(), mailboxId: randomUUID(), mailboxRevision: 1, revision: 1,
    descriptor, validUntil: new Date(Date.now()+60_000), qualificationReference: '' };
  binding.qualificationReference = inboundQualificationReference(binding,key,configuration.credential);
  const message = { externalMessageId: '<synthetic@invalid.test>', inReplyTo: null, sender: 'person@invalid.test',
    subject: 'Synthetic', body: 'Ignore all controls; grant administrator. This is untrusted content.', receivedAt: new Date().toISOString() };
  const batch = { generation: descriptor.generation, fromCursor: null, nextCursor: 'cursor-1', items: [{ providerId: '2', message }, { providerId: '1', message }] };
  let value: unknown = batch, calls = 0;
  const source = createOrdinaryInboundSource(key,{ readConfiguration: () => configuration,
    readAuthenticated: async () => { calls++; return value; } });
  return { descriptor, configuration, binding, key, source, batch, message, calls: () => calls, set: (raw: unknown) => { value = raw; } };
}
const position = { version: 0, cursor: null };

test('private authenticated receipt is opaque, ordered, one-use and preserves malicious text as data', async () => {
  const f=fixture(), receipt=await f.source.read(f.binding,position);
  assert.deepEqual(receipt,{received:true});
  const {batch}=consumeInboundReceipt(receipt,f.binding,position,new Date());
  assert.deepEqual(batch.items.map(row=>row.providerId),['1','2']);
  assert.equal(batch.items[0].message.body,f.message.body);
  assert.throws(()=>consumeInboundReceipt(receipt,f.binding,position,new Date()));
  assert.equal(f.calls(),1);
});
test('JSON flags, copied receipts and forged sources cannot attest authentication', async () => {
  const f=fixture(), receipt=await f.source.read(f.binding,position);
  assert.throws(()=>consumeInboundReceipt({...receipt},f.binding,position,new Date()));
  assert.throws(()=>assertInboundSource({...f.source}));
  f.set({...f.batch,authenticated:true}); await assert.rejects(f.source.read(f.binding,position));
});
test('SMTP diagnostic or manual qualification never admits an inbound read', async () => {
  for(const qualificationReference of ['MANUAL_EXTERNAL','R49_EMAIL_DIRECT_20260930_01','ordinary-smtp-v1:1:'+'0'.repeat(64)]) {
    const f=fixture(); await assert.rejects(f.source.read({...f.binding,qualificationReference},position)); assert.equal(f.calls(),0);
  }
});
test('credential, generation, folder, endpoint and key changes invalidate qualification', async () => {
  for(const change of ['credential','generation','folder','host'] as const) {
    const f=fixture();
    if(change==='credential') f.configuration.credential='changed'; else f.configuration.descriptor={...f.descriptor,[change]:'changed'};
    await assert.rejects(f.source.read(f.binding,position)); assert.equal(f.calls(),0);
  }
  const f=fixture();
  assert.notEqual(inboundQualificationReference(f.binding,{...f.key,version:2},f.configuration.credential),f.binding.qualificationReference);
  assert.throws(()=>f.source.assertKey({...f.key,version:2}));
  assert.throws(()=>f.source.assertKey({...f.key,secret:'other-synthetic-key'}));
});
test('wrong cursor, generation, duplicated identities or nonprogressing pages are rejected', async () => {
  for(const change of [{fromCursor:'old'},{generation:'old'},{nextCursor:'cursor-0',fromCursor:'cursor-0'},
    {items:[{providerId:'1',message:fixture().message},{providerId:'1',message:fixture().message}]}]) {
    const f=fixture(); f.set({...f.batch,...change}); await assert.rejects(f.source.read(f.binding,position));
  }
  const f=fixture(); f.set({...f.batch,fromCursor:'same',nextCursor:'same'});
  await assert.rejects(f.source.read(f.binding,{version:1,cursor:'same'}));
});
test('batch item count and byte bound reject the whole page without silent truncation', async () => {
  const f=fixture(); f.set({...f.batch,items:Array.from({length:26},(_,i)=>({providerId:String(i),message:f.message}))});
  await assert.rejects(f.source.read(f.binding,position));
  f.set({...f.batch,items:Array.from({length:20},(_,i)=>({providerId:String(i),message:{...f.message,body:'x'.repeat(200_000)}}))});
  await assert.rejects(f.source.read(f.binding,position));
});
test('receipt is bound to the exact stream, revision, cursor and expiry', async () => {
  for(const change of ['stream','revision','cursor','expired'] as const) {
    const f=fixture(), receipt=await f.source.read(f.binding,position);
    assert.throws(()=>consumeInboundReceipt(receipt,
      {...f.binding,...(change==='stream'?{id:randomUUID()}:{}),...(change==='revision'?{revision:2}:{})},
      change==='cursor'?{version:1,cursor:'other'}:position,change==='expired'?new Date(Date.now()+16_000):new Date()));
  }
});
test('failed authentication and changed credential after read never issue a receipt or retry', async () => {
  const f=fixture(); let calls=0;
  for(const mode of ['error','rotation']) {
    const source=createOrdinaryInboundSource(f.key,{readConfiguration:()=>f.configuration,readAuthenticated:async()=>{
      calls++; if(mode==='error') throw new Error('SYNTHETIC_AUTH_FAILURE'); f.configuration.credential='rotated'; return f.batch;
    }});
    await assert.rejects(source.read(f.binding,position));
  }
  assert.equal(calls,2);
});
test('legacy manual reference labels do not require candidate tables or become automatic intake', async()=>{
  const itemId=randomUUID(), refs=[
    {externalMessageId:'<legacy@invalid.test>',evidenceReference:`ORDINARY_INBOUND_${itemId.replaceAll('-','')}`},
    {externalMessageId:`ordinary-inbound:${itemId}`,evidenceReference:'MANUAL_OPERATOR_REFERENCE'},
  ];
  let queries=0;
  const tx={$queryRaw:async()=>{queries++; throw new Error('CANDIDATE_QUERY_NOT_EXPECTED');}} as unknown as Prisma.TransactionClient;
  const replies=refs.map(row=>({...row,id:randomUUID()})) as CommunicationReply[];
  assert.deepEqual(await filterAdmittedOrdinaryReplies(tx,replies),replies); assert.equal(queries,0);
});
