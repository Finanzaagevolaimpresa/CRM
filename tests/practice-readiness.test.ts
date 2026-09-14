import assert from 'node:assert/strict';
import test from 'node:test';
import { exactMoneySchema, PracticeReadinessError, startPractice } from '../src/lib/practice-readiness';

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
