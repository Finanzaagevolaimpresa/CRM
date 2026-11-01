import assert from 'node:assert/strict';
import test from 'node:test';
import { isTechnicalAccount, fieldsForDisclosure, technicalFieldAllowed } from '../src/lib/technical-confidentiality';
import { evaluatePermission } from '../src/lib/permission-evaluator';
import { currentTechnicalRestriction } from '../src/lib/technical-account-membership';
import { technicalActionAllowed, technicalFileRouteAllowed, technicalPageMode } from '../src/lib/technical-surface-policy';
import { assertUnclassifiedTechnicalRecipients } from '../src/lib/communication-recipient-policy';
import type { Prisma, RoleCode } from '@prisma/client';

for (const role of ['consulente','backoffice'] as const) {
  test(role + ': positive overrides and historical broad fields cannot disclose protected data', () => {
    const actor = { role, active: true, permissionOverrides: ['contract.read','payment.read','audit.read','communications.internal.read','settings.manage']
      .map(permission => ({ permission, allowed: true })) };
    for (const permission of ['contract.read','payment.read','audit.read','communications.internal.read','settings.manage'] as const) assert.equal(evaluatePermission(actor, permission).allowed, false);
    assert.deepEqual(fieldsForDisclosure(actor,'Project',['title','description','priority','technicalOwnerName','paymentReference','notes','amount','totalInvestment']),['title','priority','technicalOwnerName','totalInvestment']);
    assert.deepEqual(fieldsForDisclosure(actor,'TechnicalPractice',['integrationRequestNote','internalNotes','clientVisibleStatus','dueDate']),['dueDate']);
    assert.equal(technicalFieldAllowed('Task','description'),false);
    assert.equal(technicalFieldAllowed('ChecklistItem','notes'),false);
    assert.equal(technicalActionAllowed(actor,'payment-actions:createPayment'),false);
    assert.equal(technicalActionAllowed(actor,'technical-work-actions:saveTechnicalWork'),true);
  });
}
test('a mixed profile or canonical second technical function cannot bypass the ceiling; Admin remains distinct', () => {
  const actor = { role:'amministrazione' as RoleCode,active:true,permissionOverrides:[{permission:'technical.write',allowed:true},{permission:'payment.read',allowed:true}] };
  assert.equal(isTechnicalAccount(actor),true); assert.equal(evaluatePermission(actor,'payment.read').allowed,false);
  assert.equal(evaluatePermission({...actor,permissionOverrides:[],technicalRestricted:true},'payment.read').allowed,false);
  assert.equal(evaluatePermission({...actor,role:'admin',technicalRestricted:true},'payment.read').allowed,true);
  assert.equal(isTechnicalAccount({role:'commerciale',permissionOverrides:[]}),false);
  assert.deepEqual(fieldsForDisclosure({role:'commerciale'},'Project',['description']),['description']);
});
test('canonical ownership is read, never created; unavailable membership does not fail open', async () => {
  const query = (assigned:boolean) => ({$queryRaw:async()=>[{assigned}]}) as unknown as Pick<Prisma.TransactionClient,'$queryRaw'>;
  assert.equal(await currentTechnicalRestriction(query(true),'synthetic-owner',{role:'commerciale'}),true);
  assert.equal(await currentTechnicalRestriction(query(false),'synthetic-sales',{role:'commerciale'}),false);
  assert.equal(await currentTechnicalRestriction(query(true),'synthetic-admin',{role:'admin'}),false);
  await assert.rejects(currentTechnicalRestriction({$queryRaw:async()=>[]} as unknown as Pick<Prisma.TransactionClient,'$queryRaw'>,'synthetic',{role:'commerciale'}),/UNAVAILABLE/);
});
test('new and indirect routes default to denial while selected technical routes remain operational', () => {
  for(const route of ['/payments','/contracts','/audit-log','/documents/[id]/versions','/trash','/exports','/unknown-new-page']) assert.equal(technicalPageMode(route),'denied');
  assert.equal(technicalPageMode('/technical-work/[kind]/[id]'),'original');
  assert.equal(technicalPageMode('/technical-uploads/[kind]/[id]'),'original');
  assert.equal(technicalPageMode('/projects/[id]'),'record');
  assert.equal(technicalFileRouteAllowed('/technical-work/[kind]/[id]/documents/[versionId]'),true);
  for(const route of ['/technical-uploads/[kind]/[id]/files/[commandId]','/videos/[id]/content','/export','/contracts/[id]/download']) assert.equal(technicalFileRouteAllowed(route),false);
});
test('unclassified communications cannot evade the technical recipient restriction via typed To, CC or BCC', () => {
  const person={id:'synthetic-tech',name:'Synthetic technician',email:'tech@example.test',role:'consulente',active:true,deletedAt:null};
  for(const key of ['to','cc','bcc'] as const){
    const recipients={to:['customer@example.test'],cc:[] as string[],bcc:[] as string[]};recipients[key].push('TECH@example.test');
    assert.throws(()=>assertUnclassifiedTechnicalRecipients([person],recipients),/UNCLASSIFIED/);
    assert.throws(()=>assertUnclassifiedTechnicalRecipients([{...person,role:'commerciale',technicalRestricted:true}],recipients),/UNCLASSIFIED/);
  }
  assert.doesNotThrow(()=>assertUnclassifiedTechnicalRecipients([{...person,role:'admin'}],{to:[person.email],cc:[],bcc:[]}));
  assert.doesNotThrow(()=>assertUnclassifiedTechnicalRecipients([person],{to:['customer@example.test'],cc:[],bcc:[]}));
});
