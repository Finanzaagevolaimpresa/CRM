import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { currentAvailableFunding, exactMoneySchema, practiceOfferSnapshotHash, PracticeReadinessError, startPractice } from '../src/lib/practice-readiness';

test('money accepts exact two-decimal strings without floating point coercion',()=>{
  assert.equal(exactMoneySchema.parse('1490.25'),'1490.25');
  for(const value of ['1.001','1e3','-1','NaN','']) assert.throws(()=>exactMoneySchema.parse(value));
});

test('all practice writes remain default-off before database access',async()=>{
  const previous=process.env.PRACTICE_READINESS_MODE; delete process.env.PRACTICE_READINESS_MODE;
  let touched=false;
  try { await assert.rejects(startPractice({$transaction:async()=>{touched=true;},$queryRaw:async()=>[]} as never,{} as never,{}),e=>e instanceof PracticeReadinessError&&e.code==='DISABLED'); assert.equal(touched,false); }
  finally { if(previous===undefined) delete process.env.PRACTICE_READINESS_MODE; else process.env.PRACTICE_READINESS_MODE=previous; }
});


test('available funding counts only terminal confirmed evidence with exact decimals',()=>{
  const confirmed={id:'confirmed',status:'CONFIRMED',amount:new Prisma.Decimal('0.10'),successor:undefined};
  const reversed={id:'reversed',status:'CONFIRMED',amount:new Prisma.Decimal('99.99'),successor:{id:'reversal'}};
  const declared={id:'declared',status:'DECLARED',amount:new Prisma.Decimal('20.00'),successor:undefined};
  assert.equal(currentAvailableFunding([confirmed,reversed,declared]).toFixed(2),'0.10');
});


test('offer snapshot canonicalizes Prisma decimals and Date as exact JSON scalars',()=>{
  const input={offerId:'offer-1',updatedAt:new Date('2026-09-14T10:00:00.000Z'),taxableAmount:new Prisma.Decimal('100.00'),vatAmount:new Prisma.Decimal('22.00'),totalAmount:new Prisma.Decimal('122.00'),revisionId:'revision-1'};
  assert.equal(practiceOfferSnapshotHash(input),practiceOfferSnapshotHash({...input}));
});
