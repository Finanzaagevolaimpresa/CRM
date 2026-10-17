import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { assertSyntheticCatalogDatabase } from '../../src/lib/service-catalog-v2-persistence';
import { saveApprovedMessageDraft } from '../../src/lib/approved-communications';
import { canonicalSha256 } from '../../src/lib/canonical-json';

// Persistence/restart fixtures, not evidence of a real send or authorization.
// Admission, proof verification and transports have separate native tests.
const db = new PrismaClient();
async function main() {
  assert.equal(process.env.CI, 'true'); await assertSyntheticCatalogDatabase(db);
  const user = await db.user.findUniqueOrThrow({ where: { id: 'release-owner' } });
  const session = await db.internalSession.create({ data: { userId: user.id, tokenDigest: randomBytes(32), expiresAt: new Date(Date.now()+3_600_000) } });
  const actor = { userId:user.id, sessionId:session.id, expiresAt:Math.floor(session.expiresAt.getTime()/1000), role:'admin' as const, active:true, permissionOverrides:[] };
  const box = await db.communicationMailbox.findUniqueOrThrow({ where:{ address:'assistenza@finanzaagevolaimpresa.it' } });
  const practice = await db.technicalPractice.findFirstOrThrow({ where:{ title:'M4 synthetic history' } });
  await db.ordinaryEmailAuthority.create({ data:{ id:'ordinary-email',userId:user.id,mailboxId:box.id,enabled:false } });
  await db.ordinaryEmailChannel.create({ data:{ mailboxId:box.id,mailboxRevision:box.revision,qualificationReference:'SYNTHETIC_PERSISTENCE_ONLY',enabled:false } });
  const messages:string[]=[];
  for (const state of ['RESERVED','CLAIMED','UNCERTAIN','ACCEPTED'] as const) {
    const saved=await saveApprovedMessageDraft(db,actor,{ messageId:randomUUID(),expectedRevision:0,
      context:{kind:'TECHNICAL',id:practice.id},mailboxId:box.id,replyTo:box.address,to:['restart@invalid.test'],cc:[],bcc:[],
      subject:'Synthetic restart '+state,body:'Synthetic persistence fixture, no transport.',attachmentVersionIds:[],classification:'ORDINARY' });
    messages.push(saved.id);
    const version=await db.communicationVersion.findUniqueOrThrow({where:{messageId_revision:{messageId:saved.id,revision:1}}});
    const decisionId=randomUUID(),attemptId=randomUUID();
    const decision={protocol:'FAI_ORDINARY_EMAIL_PERSONAL_DECISION_V1',decisionId,messageId:saved.id,actorId:user.id,
      sessionId:session.id,draftHash:saved.snapshotHash,draftRevision:1,syntheticPersistenceOnly:true};
    const hash=canonicalSha256(decision);
    await db.ordinaryEmailDecision.create({data:{id:decisionId,messageId:saved.id,versionId:version.id,actorId:user.id,sessionId:session.id,
      decision,decisionHash:hash,proof:hash,envelopeHash:hash}});
    await db.ordinaryEmailAttempt.create({data:{id:attemptId,requestId:randomUUID(),decisionId,messageId:saved.id}});
    if(state!=='RESERVED') {
      const claim=await db.ordinaryEmailClaim.create({data:{id:randomUUID(),attemptId,expiresAt:new Date(Date.now()+10_000)}});
      await db.ordinaryEmailAttempt.update({where:{id:attemptId},data:{state:'CLAIMED'}});
      if(state==='UNCERTAIN'||state==='ACCEPTED') {
        await db.ordinaryEmailOutcome.create({data:{id:randomUUID(),attemptId,claimId:claim.id,outcome:state,phase:'CONTENT',replyCode:state==='ACCEPTED'?250:null}});
        await db.ordinaryEmailAttempt.update({where:{id:attemptId},data:{state}});
      }
    }
    await db.approvedCommunication.update({where:{id:saved.id},data:{state:state==='ACCEPTED'?'SENT':state==='UNCERTAIN'?'UNCERTAIN':'SENDING'}});
  }
  const descriptor={protocol:'IMAP_UID',host:'restart.invalid.test',port:993,security:'TLS',minVersion:'TLSv1.2',
    rejectUnauthorized:true,folder:'INBOX',generation:'1234',authenticationReference:'SYNTHETIC_ONLY'};
  const stream=await db.ordinaryEmailInboundStream.create({data:{id:randomUUID(),mailboxId:box.id,mailboxRevision:box.revision,
    descriptor,descriptorHash:canonicalSha256(descriptor),qualificationReference:'SYNTHETIC_PERSISTENCE_ONLY',
    validUntil:new Date(Date.now()+3_600_000),enabled:true,cursor:'100'}});
  const batch=await db.ordinaryEmailInboundBatch.create({data:{id:randomUUID(),streamId:stream.id,streamRevision:1,fromVersion:0,
    fromCursorHash:canonicalSha256('100'),nextCursorHash:canonicalSha256('102'),batchHash:canonicalSha256('synthetic-page1')}});
  const payload={externalMessageId:'<restart@invalid.test>',inReplyTo:'<synthetic-restart@invalid.test>',sender:'restart@invalid.test',
    subject:'Synthetic reply',body:'Private synthetic restart material',receivedAt:new Date().toISOString()};
  const item=await db.ordinaryEmailInboundItem.create({data:{id:randomUUID(),streamId:stream.id,batchId:batch.id,providerId:'101',payload,payloadHash:canonicalSha256(payload)}});
  const reply=await db.communicationReply.create({data:{canonicalMailboxId:box.id,externalMessageId:'ordinary-inbound:'+item.id,
    inReplyTo:payload.inReplyTo,sender:payload.sender,subject:payload.subject,body:payload.body,receivedAt:new Date(payload.receivedAt),
    messageId:messages[3],acquiredById:user.id,linkedById:user.id,contentHash:canonicalSha256(payload),evidenceReference:'SYNTHETIC_RESTART_ONLY'}});
  await db.ordinaryEmailInboundLink.create({data:{itemId:item.id,replyId:reply.id,actorId:user.id}});
  await db.ordinaryEmailInboundStream.update({where:{id:stream.id},data:{cursor:'102',cursorVersion:1}});
  const conflictBatch=await db.ordinaryEmailInboundBatch.create({data:{id:randomUUID(),streamId:stream.id,streamRevision:1,fromVersion:1,
    fromCursorHash:canonicalSha256('102'),nextCursorHash:canonicalSha256('103'),batchHash:canonicalSha256('synthetic-page2')}});
  await db.ordinaryEmailInboundConflict.create({data:{id:randomUUID(),itemId:item.id,batchId:conflictBatch.id,observedHash:canonicalSha256({...payload,body:'Conflicting synthetic observation'})}});
  await db.ordinaryEmailInboundStream.update({where:{id:stream.id},data:{cursor:'103',cursorVersion:2}});
  await db.ordinaryEmailInboundStream.update({where:{id:stream.id},data:{enabled:false,revision:2}});
  await db.internalSession.update({where:{id:session.id},data:{revokedAt:new Date(),revokedReason:'INTERNAL_SINGLE'}});
  console.log('ORDINARY_EMAIL_SYNTHETIC_RESTART_HISTORY_READY');
}
main().finally(()=>db.$disconnect()).catch(()=>{console.error('ORDINARY_EMAIL_RESTART_FIXTURE_FAILED');process.exitCode=1;});
