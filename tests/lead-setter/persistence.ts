import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { syntheticPerson, syntheticSession } from '../selective-sharing/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { assignCommercialLeadInboxItem, closeCommercialLeadInboxItem, initializeCommercialLeadInboxItem, saveSetterCall,
  unassignCommercialLeadInboxItem } from '../../src/lib/commercial-lead-inbox';
import { readResponsibility } from '../../src/lib/responsibility';
import { recordHistoricalLeadContact } from '../../src/lib/commercial-lead-historical-contact-storage';
import { type SetterCommand, type SetterDetails } from '../../src/lib/lead-setter-contract';
import { leadWorkWhere, type LeadWorkQueue } from '../../src/lib/lead-work-queues';
import { grantLead, leadProof } from '../selective-leads/fixtures';
import { readLeadSharing, revokeLeadSharing } from '../../src/lib/selective-lead-access';
import { admitBusinessInboxEvent } from '../../src/lib/business-event-backbone';
import { readLeadAcquisitions, readLeadAcquisitionSummary } from '../../src/lib/lead-acquisition';
import { createLeadSubmittedEventV1 } from '../../src/lib/lead-event-contract';
import { syntheticLeadEventInputV1 } from '../fixtures/n10-lead-event-v1';
import { currentAssignmentNotices } from '../../src/lib/assignment-notices';
import { openOrdinaryWindow, ordinaryWindowExpiry, endOrdinaryWindow } from '../../src/lib/admin-ordinary-window';
import { resolveInternalSession, revokeInternalSession } from '../../src/lib/internal-session-registry';
import { createPrivilegedStepUpToken, verifyPrivilegedStepUpToken } from '../../src/lib/privileged-step-up-token';

const db = new PrismaClient();
type Person = Awaited<ReturnType<typeof syntheticPerson>>;
let admin: Person, owner: Person, other: Person, tech: Person;
const actor = (p: Person) => ({ userId: p.user.id, sessionId: p.session.sessionId! });
const key = { version: Number(process.env.PRIVILEGED_STEP_UP_KEY_VERSION), secret: process.env.PRIVILEGED_STEP_UP_SECRET! };
before(async () => {
  assert.equal(process.env.APP_ENV, 'test');
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  admin = await syntheticPerson(db,'Amministrazione sintetica','admin');
  owner = await syntheticPerson(db,'Setter sintetico','commerciale');
  other = await syntheticPerson(db,'Altro referente sintetico','commerciale');
  tech = await syntheticPerson(db,'Tecnico sintetico','consulente');
});
after(async () => { await db.$disconnect(); });

async function newLead() {
  const lead = await db.lead.create({data:{firstName:'Collaudo',lastName:'Setter',companyName:'Sintetico '+randomUUID(),source:'CRM',leadSource:'manuale'}});
  await initializeCommercialLeadInboxItem(db,{leadId:lead.id,actor:actor(admin),attribution:{originKind:'MANUAL_CRM'},reasonCode:'MANUAL_INTAKE'});
  return lead.id;
}
async function assign(id: string, p: Person) {
  const item = await db.commercialLeadInboxItem.findUniqueOrThrow({where:{leadId:id}});
  return assignCommercialLeadInboxItem(db,{leadId:id,actor:{...actor(admin),requireManualAdmin:true},targetUserId:p.user.id,expectedInboxVersion:item.version});
}
async function listed(p: Person, id:string, queue: LeadWorkQueue) {
  return db.lead.count({where:{id,AND:[leadWorkWhere(p.session,queue,new Date())]}});
}
async function nextCommand(id: string, patch: Partial<SetterCommand> = {}): Promise<SetterCommand> {
  const [lead,item] = await Promise.all([db.lead.findUniqueOrThrow({where:{id}}), db.commercialLeadInboxItem.findUnique({where:{leadId:id}})]);
  return {id:randomUUID(), leadId:id, version:item?.version ?? null, leadVersion:lead.updatedAt.toISOString(), outcome:'UNREACHABLE',
    nextKind:'CALLBACK', nextLocal:'2026-04-20', details:null, ...patch};
}
const risk = { origin:'UNKNOWN',finding:'',source:'',date:'' } as const;
const detail: SetterDetails = {project:'Progetto sintetico',site:'Roma',obstacle:'',expenses:'',timing:'',quotes:'',
  investment:'10000',ownFunds:'3000',financing:'7000',instalments:'',activity:'',otherAid:'',consultantSummary:'Sintesi sintetica',
  assistance:'INTERESTED',crif:{origin:'DECLARED',finding:'Dichiarazione sintetica',source:'Chiamata',date:''},central:risk,delays:risk};

test('Coda per ruolo e avviso trasferiti dopo riassegnazione; l’apertura precedente perde autorità',async () => {
  const id = await newLead();
  assert.equal(await listed(admin,id,'today'),1); assert.equal(await listed(admin,id,'unassigned'),1);
  assert.equal(await listed(owner,id,'unassigned'),0);
  await assert.rejects(assign(id,tech));
  await assign(id,owner);
  assert.equal(await listed(owner,id,'contact'),1); assert.equal(await listed(admin,id,'unassigned'),0);
  assert.equal(await listed(owner,id,'missing'),1);
  assert((await currentAssignmentNotices(owner.session)).some(n => n.href==='/leads/'+id));
  const stale = await nextCommand(id);
  await assert.rejects(saveSetterCall(db,actor(tech),stale)); await assert.rejects(saveSetterCall(db,actor(other),stale));
  await assign(id,other);
  assert.equal(await listed(owner,id,'contact'),0); assert.equal(await listed(other,id,'contact'),1);
  assert(!(await currentAssignmentNotices(owner.session)).some(n => n.href==='/leads/'+id));
  await assert.rejects(saveSetterCall(db,actor(owner),stale));
  const item = await assign(id,owner);
  await assert.rejects(saveSetterCall(db,actor(owner),stale));
  await unassignCommercialLeadInboxItem(db,{leadId:id,actor:{...actor(admin),requireManualAdmin:true},expectedInboxVersion:item.version});
  assert.equal(await listed(admin,id,'unassigned'),1);
  assert.equal(await db.leadSetterCall.count({where:{leadId:id}}),0);
  assert.equal(await db.auditLog.count({where:{entityId:id,event:'responsibility_accepted'}}),0);
});

test('Tentativo, doppio clic, risposta persa, primo contatto, rinvio, assenza e chiusura sono persistenti',async () => {
  const id = await newLead(), assigned = await assign(id,owner);
  const attempt = await nextCommand(id);
  const results = await Promise.all([saveSetterCall(db,actor(owner),attempt),saveSetterCall(db,actor(owner),attempt)]);
  assert.deepEqual(results.map(r => r.replay).sort(),[false,true]); assert.equal(results[0].id,results[1].id);
  await assert.rejects(saveSetterCall(db,actor(owner),{...attempt,nextLocal:'2026-05-15'}));
  assert.equal(await listed(owner,id,'missing'),0); assert.equal(await listed(owner,id,'contact'),1);
  const cycle = () => db.commercialLeadSlaCycle.findFirstOrThrow({where:{inboxItemId:assigned.id}});
  assert.equal((await cycle()).firstResponseAt,null);
  await assert.rejects(saveSetterCall(db,actor(owner),await nextCommand(id,{outcome:'VIDEO_HELD',details:detail})));
  const book = await nextCommand(id,{outcome:'VIDEO_BOOKED',nextKind:'VIDEO',nextLocal:'2027-01-14T13:10',details:detail});
  await saveSetterCall(db,actor(owner),book);
  assert((await saveSetterCall(db,actor(owner),book)).replay);
  const first = (await cycle()).firstResponseAt;
  assert(first); assert.equal(await listed(owner,id,'contact'),0); assert.equal(await listed(owner,id,'videos'),1);
  await saveSetterCall(db,actor(owner),await nextCommand(id,{outcome:'VIDEO_DEFERRED',nextKind:'VIDEO',nextLocal:'2027-01-18T11:00',details:detail}));
  await saveSetterCall(db,actor(owner),await nextCommand(id,{outcome:'VIDEO_ABSENT'}));
  assert.equal(await listed(owner,id,'videos'),0); assert.equal((await cycle()).firstResponseAt?.toISOString(),first.toISOString());
  assert.equal(await db.leadSetterCall.count({where:{leadId:id}}),4);
  await assert.rejects(db.leadSetterCall.update({where:{id:book.id},data:{outcome:'CONTACT'}}));
  const item = await db.commercialLeadInboxItem.findUniqueOrThrow({where:{leadId:id}});
  await closeCommercialLeadInboxItem(db,{leadId:id,actor:actor(owner),expectedInboxVersion:item.version,reasonCode:'LOST'});
  await assert.rejects(saveSetterCall(db,actor(owner),await nextCommand(id)));
  assert.equal(await listed(owner,id,'overdue'),0);
});

test('Contatto pregresso dell’assegnatario senza accettazione personale, esclusione dal conteggio e SLA conservato',async () => {
  const id = await newLead(), item = await assign(id,owner);
  const decision = (await readResponsibility(db,'Lead',id)).current!;
  await recordHistoricalLeadContact(db,actor(owner),{commandId:randomUUID(),leadId:id,expectedInboxVersion:item.version,expectedAssignmentId:decision.id,
    occurredAt:new Date(item.initializedAt.getTime()-86400000).toISOString(),source:'EXISTING_DOCUMENT',evidenceReference:'Riferimento sintetico privato',attested:true});
  assert.equal(await listed(owner,id,'contact'),0);
  await saveSetterCall(db,actor(owner),await nextCommand(id,{outcome:'CONTACT',nextKind:'NONE',nextLocal:'',details:detail}));
  assert.equal((await db.commercialLeadSlaCycle.findFirstOrThrow({where:{inboxItemId:item.id}})).firstResponseAt,null);
  assert.equal(await db.auditLog.count({where:{entityId:id,event:'responsibility_accepted'}}),0);
});

test('Intervento tecnico prima della pratica: solo il lead scelto e i campi ammessi fino alla revoca',async () => {
  const binding = await db.selectiveLeadAuthority.findUniqueOrThrow({where:{id:'lead-sharing'}});
  const authorityUser = await db.user.findUniqueOrThrow({where:{id:binding.userId}});
  const authority = {user:authorityUser,...await syntheticSession(db,authorityUser)};
  const id = await newLead(), foreign = await newLead();
  await db.userPermissionOverride.upsert({where:{userId_permission:{userId:tech.user.id,permission:'lead.read'}},
    update:{allowed:true},create:{userId:tech.user.id,permission:'lead.read',allowed:true}});
  const {receipt} = await grantLead(db,authority,{leadId:id,recipientId:tech.user.id,revision:0,commandId:randomUUID(),
    fields:['companyName','status'],expiresAt:null});
  const techNotices = async () => (await currentAssignmentNotices(tech.session)).map(notice => notice.href);
  assert((await techNotices()).includes('/shared-leads/' + id));
  assert(!(await techNotices()).includes('/shared-leads/' + foreign));
  const selected = await readLeadSharing(db,tech.session,id);
  assert.deepEqual(selected.fields.map(f=>f.key).sort(),['companyName','status']);
  await assert.rejects(readLeadSharing(db,tech.session,foreign));
  await assert.rejects(saveSetterCall(db,actor(tech),await nextCommand(id)));
  await revokeLeadSharing(db,authority.session,{grantId:receipt.grantId,revision:receipt.revision,commandId:randomUUID()},leadProof(authority));
  await assert.rejects(readLeadSharing(db,tech.session,id));
  assert(!(await techNotices()).includes('/shared-leads/' + id));
});

test('Eccezioni di acquisizione: ricevuta sito senza scheda, fonte distinta, provenienza illeggibile e ambito Admin', async () => {
  const receipt = async (systemCode: string) => {
    const base = syntheticLeadEventInputV1();
    const event = createLeadSubmittedEventV1({ ...base, eventId: randomUUID(), businessCorrelationId: randomUUID(),
      source: { ...base.source, systemCode, submissionId: randomUUID() } });
    return (await admitBusinessInboxEvent(db, event)).inboxEventId;
  };
  const website = await receipt('WORDPRESS'), internal = await receipt('OTHER_FIXTURE');
  const template = await db.businessInboxEvent.findUniqueOrThrow({ where: { id: internal } });
  const invalid = await db.businessInboxEvent.create({ data: { ...template, id: randomUUID(), eventId: randomUUID(),
    keyDigest: randomUUID().replaceAll('-', '').repeat(2), envelopeJson: '{' }, select: { id: true } });
  const unlinked = await readLeadAcquisitions(db, actor(admin), { queue: 'unlinked' });
  assert(unlinked.items.some(item => item.id === website && item.verified));
  assert(unlinked.items.every(item => item.id !== internal && item.id !== invalid.id));
  assert((await readLeadAcquisitionSummary(db, actor(admin))).some(group => group.source === 'Da verificare'));
  assert((await readLeadAcquisitions(db, actor(admin), {})).items.some(item => item.id === invalid.id && !item.verified && item.event === null));
  await assert.rejects(readLeadAcquisitions(db, actor(owner), { queue: 'unlinked' }));
});

test('Registro Admin: 24 ore assolute, limite inattività, logout, cambio ruolo e prova recente per le operazioni sensibili',async () => {
  const passwordHash = admin.user.passwordHash;
  const ordinary = 'N14_LEAD_INBOX_ASSIGN';
  const create = async () => {
    const record = await syntheticSession(db,admin.user);
    const opening = await openOrdinaryWindow(db,record.session,key,record.token,passwordHash);
    assert(opening); return {...record,opening};
  };
  const a = await create();
  const expiry = (action:string, touch=false) => ordinaryWindowExpiry(db,a.session,action,key,a.token,a.opening.token,touch);
  const remaining = a.opening.expiresAt.getTime()-Date.now();
  assert(remaining>86330000 && remaining<=86401000);
  const t0 = Math.floor(Date.now()/1000);
  const su = createPrivilegedStepUpToken({key,userId:admin.user.id,sessionToken:a.token,role:'admin',nowSeconds:t0});
  assert.equal(verifyPrivilegedStepUpToken({key,expectedUserId:admin.user.id,sessionToken:a.token,role:'admin',token:su,nowSeconds:t0+1801}),false);
  assert.equal(await expiry('USER_PERMISSION_OVERRIDE'),null);
  assert.equal(await expiry('DRIVE_FOLDER_MANAGE'),null);
  assert.equal(await ordinaryWindowExpiry(db,a.session,ordinary,{...key,version:key.version+100},a.token,a.opening.token,false),null);
  assert.equal(await openOrdinaryWindow(db,owner.session,key,owner.token,owner.user.passwordHash),null);
  const age = async (confirmed:number,last:number) => db.internalSession.update({where:{id:a.session.sessionId},data:{
    ordinaryConfirmedAt:new Date(Date.now()-confirmed),ordinaryLastActiveAt:new Date(Date.now()-last)}});
  await age(23*3600000,1200000); assert(await expiry(ordinary,true));
  await age(23*3600000,3600100); assert.equal(await expiry(ordinary),null); assert.equal(await resolveInternalSession(db,a.token),null);
  await age(86401000,300000); assert.equal(await expiry(ordinary),null); assert.equal(await resolveInternalSession(db,a.token),null);
  const b = await create();
  await db.$transaction(tx=>revokeInternalSession(tx,b.session.sessionId!,'INTERNAL_SINGLE',admin.user.id));
  assert.equal(await ordinaryWindowExpiry(db,b.session,ordinary,key,b.token,b.opening.token,false),null);
  const c = await create();
  await endOrdinaryWindow(db,c.session);
  assert.equal(await ordinaryWindowExpiry(db,c.session,ordinary,key,c.token,c.opening.token,false),null);
  const closed = await db.internalSession.findUniqueOrThrow({where:{id:c.session.sessionId}});
  assert.equal(closed.expiresAt.getTime()-closed.createdAt.getTime(),8*3600000);
  const isolatedAdmin = await syntheticPerson(db,'Cambio ruolo sintetico','admin');
  const proof = await openOrdinaryWindow(db,isolatedAdmin.session,key,isolatedAdmin.token,isolatedAdmin.user.passwordHash);
  assert(proof); await db.user.update({where:{id:isolatedAdmin.user.id},data:{role:'commerciale'}});
  assert.equal(await resolveInternalSession(db,isolatedAdmin.token),null);
  assert.equal(await ordinaryWindowExpiry(db,isolatedAdmin.session,ordinary,key,isolatedAdmin.token,proof.token,false),null);
});
