import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Prisma } from '@prisma/client';
import { OrdinaryEmailReceipts } from '../src/components/ordinary-email-receipts';
import { communicationDeliveryLabel, hasBlockingOrdinaryReceipt, ordinaryReceiptSchema, type OrdinaryEmailReceipt } from '../src/lib/ordinary-email-receipt';
import { readAdmittedOrdinaryEmailReceipts } from '../src/lib/ordinary-email-receipt-reader';

const now = new Date('2026-10-16T16:00:00Z');
function receipt(state: OrdinaryEmailReceipt['state']): OrdinaryEmailReceipt {
  return ordinaryReceiptSchema.parse({ id: randomUUID(), revision: 1, snapshotHash: 'a'.repeat(64), state, createdAt: now,
    outcome: ['RESERVED','CLAIMED'].includes(state) ? null : state, recordedAt: ['RESERVED','CLAIMED'].includes(state) ? null : now });
}

test('SMTP acceptance, manual declaration and newer drafts retain distinct labels', () => {
  const accepted = receipt('ACCEPTED');
  assert.equal(communicationDeliveryLabel('SENT',1,[accepted],[]),'Accettata dal server');
  assert.equal(communicationDeliveryLabel('SENT',1,[],[]),'Invio dichiarato');
  assert.equal(communicationDeliveryLabel('DRAFT',2,[accepted],[]),'Bozza');
  assert.equal(communicationDeliveryLabel('SENDING',1,[receipt('NOT_SENT')],[{createdAt:new Date(now.getTime()+1)}]),'Invio manuale in corso');
  assert.equal(communicationDeliveryLabel('SENDING',1,[receipt('RESERVED')],[]),'Invio prenotato · senza ricevuta');
});

test('missing, claimed and uncertain receipts block reuse and cannot claim SMTP acceptance', () => {
  for(const state of ['RESERVED','CLAIMED','ACCEPTED','UNCERTAIN'] as const) assert.equal(hasBlockingOrdinaryReceipt([receipt(state)]),true);
  assert.equal(hasBlockingOrdinaryReceipt([receipt('NOT_SENT')]),false);
  const base = receipt('ACCEPTED');
  for(const changed of [{outcome:null},{recordedAt:null},{outcome:'NOT_SENT'},{state:'CLAIMED'},{claimId:randomUUID()}]) {
    assert.equal(ordinaryReceiptSchema.safeParse({...base,...changed}).success,false);
  }
});

test('rendered receipts explain acceptance and uncertainty without delivery claims or retry buttons', () => {
  const html=renderToStaticMarkup(createElement(OrdinaryEmailReceipts,{receipts:[receipt('ACCEPTED'),receipt('UNCERTAIN'),receipt('CLAIMED')]}));
  assert.match(html,/Accettata dal server/); assert.match(html,/Non prova la consegna o la lettura/);
  assert.match(html,/Esito incerto · non ripetere/); assert.match(html,/Esito da riconciliare · senza ricevuta/);
  assert.doesNotMatch(html,/<button|<form|Consegnata|Letta|Ritenta/);
  assert.equal(renderToStaticMarkup(createElement(OrdinaryEmailReceipts,{receipts:[]})),'');
});

test('schema50 absence remains usable but partial schema and SQL errors never masquerade as manual receipts', async () => {
  for(const present of [0,1,2,3,4,5]) {
    let reads=0;
    const tx={$queryRaw:async()=>{reads++;return [{present}];}} as unknown as Prisma.TransactionClient;
    if(present===0) assert.deepEqual(await readAdmittedOrdinaryEmailReceipts(tx,randomUUID()),[]);
    else await assert.rejects(readAdmittedOrdinaryEmailReceipts(tx,randomUUID()),/UNAVAILABLE/);
    assert.equal(reads,1);
  }
  const failure=new Error('SYNTHETIC_CONNECTION_LOST');
  const tx={$queryRaw:async()=>{throw failure;}} as unknown as Prisma.TransactionClient;
  await assert.rejects(readAdmittedOrdinaryEmailReceipts(tx,randomUUID()),error=>error===failure);
});
