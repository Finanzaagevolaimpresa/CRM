import { randomUUID } from 'node:crypto';
import type { PrismaClient, RoleCode } from '@prisma/client';
import type { AuthSession } from '../../src/lib/auth';
import { createRegistrySessionToken, digestRegistrySessionToken } from '../../src/lib/session';
import { rotatePrivilegedStepUpKeyVersion, PRIVILEGED_STEP_UP_KEY_PURPOSE } from '../../src/lib/application-key-registry';
import { createPrivilegedStepUpToken, privilegedStepUpKeyDigest } from '../../src/lib/privileged-step-up-token';
import { configureCommunicationMailbox, qualifyCommunicationMailbox } from '../../src/lib/approved-communications';
import { emptyCommunicationRecipientSelection } from '../../src/lib/communication-recipient-policy';
import { previewInternalCommunication, confirmInternalCommunication } from '../../src/lib/internal-communications';
import type { CommunicationContext } from '../../src/lib/approved-communication-contract';

export async function contextPerson(db: PrismaClient, role: RoleCode = 'admin') {
  const user=await db.user.create({data:{name:'Synthetic context person',email:`context-${randomUUID()}@invalid.test`,role,active:true,passwordHash:'unusable-synthetic'}});
  const cookie=createRegistrySessionToken();
  const session=await db.internalSession.create({data:{userId:user.id,tokenDigest:Buffer.from(await digestRegistrySessionToken(cookie.bytes)),expiresAt:new Date(Date.now()+3_600_000)}});
  const actor={userId:user.id,sessionId:session.id,expiresAt:Math.floor(session.expiresAt.getTime()/1000),role,active:true,permissionOverrides:[]} satisfies AuthSession;
  return {user,actor,cookie:cookie.token};
}
export async function contextFixture(db: PrismaClient) {
  const owner=await contextPerson(db), member=await contextPerson(db,'commerciale'), outsider=await contextPerson(db);
  const latest=await db.applicationKeyVersion.findFirst({where:{purpose:PRIVILEGED_STEP_UP_KEY_PURPOSE},orderBy:{version:'desc'}});
  const key={version:(latest?.version??0)+1,secret:'synthetic-context-key-not-production-00000000000000'};
  await db.$transaction(tx=>rotatePrivilegedStepUpKeyVersion(tx,{version:key.version,keyDigest:privilegedStepUpKeyDigest(key.secret),actorUserId:owner.user.id}));
  const before=await db.communicationMailbox.findUniqueOrThrow({where:{address:'comunicazioni@finanzaagevolaimpresa.it'}});
  const box=await configureCommunicationMailbox(db,owner.actor,{mailboxId:before.id,expectedRevision:before.revision,kind:'MAILBOX',canonicalMailboxId:null,
    providerReference:'register_it',responsibleUserId:owner.user.id,canSend:true,canReceive:true,restricted:false,configurationReference:'M4_COMUNICAZIONI_REGISTER_IT'});
  await qualifyCommunicationMailbox(db,owner.actor,{mailboxId:box.id,expectedRevision:box.revision,action:'TEST',testReference:'SYNTHETIC_CONTEXT_ONLY'});
  await qualifyCommunicationMailbox(db,owner.actor,{mailboxId:box.id,expectedRevision:box.revision,action:'ENABLE'});
  await db.$executeRaw`INSERT INTO "OrdinaryEmailAuthority" ("id","userId","mailboxId","enabled") VALUES ('ordinary-email',${owner.user.id},${box.id}::uuid,true)
    ON CONFLICT ("id") DO UPDATE SET "userId"=EXCLUDED."userId","mailboxId"=EXCLUDED."mailboxId","enabled"=true,"revision"="OrdinaryEmailAuthority"."revision"+1`;
  await db.$executeRaw`INSERT INTO "OrdinaryEmailChannel" ("mailboxId","mailboxRevision","qualificationReference","enabled") VALUES (${box.id}::uuid,${box.revision},'SYNTHETIC_CONTEXT_ONLY',true)
    ON CONFLICT ("mailboxId") DO UPDATE SET "mailboxRevision"=EXCLUDED."mailboxRevision","qualificationReference"=EXCLUDED."qualificationReference","enabled"=true,"revision"="OrdinaryEmailChannel"."revision"+1`;
  const lead=await db.lead.create({data:{firstName:'Synthetic',lastName:'Context lead',email:'lead-context@invalid.test'}});
  const client=await db.client.create({data:{displayName:'Synthetic standalone client',type:'societa'}});
  const credentials={key,sessionToken:owner.cookie,stepUpToken:createPrivilegedStepUpToken({key,userId:owner.user.id,sessionToken:owner.cookie})};
  return {owner,member,outsider,lead,client,box,key,credentials};
}
export type ContextFixture=Awaited<ReturnType<typeof contextFixture>>;
export function contextDraft(f:ContextFixture,context:CommunicationContext) {
  const recipientSelection=emptyCommunicationRecipientSelection();
  if(context.kind==='INTERNAL')recipientSelection.to.userIds=[f.member.user.id];
  return {messageId:randomUUID(),expectedRevision:0,context,mailboxId:f.box.id,replyTo:f.box.address,
    to:context.kind==='INTERNAL'?[]:['external-context@invalid.test'],cc:[],bcc:[],recipientSelection,
    subject:'Synthetic contextual message',body:'SYNTHETIC_CONTEXT_BODY',attachmentVersionIds:[],contextFileIds:[] as string[],classification:'ORDINARY' as const};
}
export async function contextThread(db:PrismaClient,f:ContextFixture) {
  const input={id:randomUUID(),expectedVersion:0,title:'Synthetic internal private thread',selection:{userIds:[f.member.user.id],groups:[]}};
  const preview=await previewInternalCommunication(db,f.owner.actor,input,f.credentials);
  await confirmInternalCommunication(db,f.owner.actor,input,preview.evidenceHash,f.credentials);
  return input;
}
