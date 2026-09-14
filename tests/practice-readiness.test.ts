import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { currentAvailableFunding, exactMoneySchema, parsePracticeMaterialInput, parsePracticeMaterialsCompletenessInput, practiceOfferSnapshotHash, PracticeReadinessError, startPractice } from '../src/lib/practice-readiness';

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

test('materials completeness form normalizes blank optional reasons and controls invalid input',()=>{
  const base={practiceId:'00000000-0000-4000-8000-000000000001',expectedVersion:'3'};
  assert.equal(parsePracticeMaterialsCompletenessInput(base).emptyChecklistReason,undefined);
  assert.equal(parsePracticeMaterialsCompletenessInput({...base,emptyChecklistReason:null}).emptyChecklistReason,null);
  assert.equal(parsePracticeMaterialsCompletenessInput({...base,emptyChecklistReason:''}).emptyChecklistReason,null);
  assert.equal(parsePracticeMaterialsCompletenessInput({...base,emptyChecklistReason:'   '}).emptyChecklistReason,null);
  assert.equal(parsePracticeMaterialsCompletenessInput({...base,emptyChecklistReason:'  Motivazione reale  '}).emptyChecklistReason,'Motivazione reale');
  assert.throws(
    ()=>parsePracticeMaterialsCompletenessInput({...base,emptyChecklistReason:'x'.repeat(501)}),
    error=>error instanceof PracticeReadinessError&&error.code==='DENIED',
  );
});

test('material form normalizes only blank optional document references',()=>{
  const base={practiceId:'00000000-0000-4000-8000-000000000001',checklistItemId:'checklist-1',status:'INVALIDATED' as const,reason:'Versione sostituita',expectedVersion:'4'};
  const parsed=parsePracticeMaterialInput({...base,documentId:'',documentVersionId:'   '});
  assert.equal(parsed.documentId,null);
  assert.equal(parsed.documentVersionId,null);
  assert.equal(parsed.reason,'Versione sostituita');
  assert.throws(
    ()=>parsePracticeMaterialInput({...base,status:'VALIDATED',documentId:'x'.repeat(192),documentVersionId:''}),
    error=>error instanceof PracticeReadinessError&&error.code==='DENIED',
  );
  assert.throws(
    ()=>parsePracticeMaterialInput({...base,status:'NOT_NEEDED',reason:'   '}),
    error=>error instanceof PracticeReadinessError&&error.code==='DENIED',
  );
});
