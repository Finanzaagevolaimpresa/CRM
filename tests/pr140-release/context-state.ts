import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient, Prisma } from '@prisma/client';
import { assertSyntheticCatalogDatabase } from '../../src/lib/service-catalog-v2-persistence';
import { approvedMessageHash, approvedMessageSnapshotSchema } from '../../src/lib/approved-communication-contract';
import { emptyCommunicationRecipientSelection } from '../../src/lib/communication-recipient-policy';

// Persistence fixture only. The channel stays disabled. The following updates
// fixture enables the owner's personal binding for synthetic drafts only;
// another Admin must remain read-only in the native recovery checks.
const db=new PrismaClient();
async function main(){
  assert.equal(process.env.CI,'true');await assertSyntheticCatalogDatabase(db);
  const owner=await db.user.findUniqueOrThrow({where:{id:'release-owner'}}),member=await db.user.findUniqueOrThrow({where:{id:'release-observer'}});
  const other=await db.user.create({data:{id:'context-recovery-other',email:'context-recovery-other@invalid.test',name:'Synthetic other Admin',role:'admin',passwordHash:owner.passwordHash}});
  const box=await db.communicationMailbox.findUniqueOrThrow({where:{address:'assistenza@finanzaagevolaimpresa.it'}});
  const client=await db.client.findFirstOrThrow({orderBy:{id:'asc'},where:{deletedAt:null}});
  const lead=await db.lead.create({data:{firstName:'SYNTHETIC',lastName:'CONTEXT_RECOVERY_LEAD'}});
  const thread=await db.internalCommunicationThread.create({data:{id:randomUUID(),title:'SYNTHETIC_CONTEXT_RECOVERY',ownerUserId:owner.id}});
  const deleted=await db.internalCommunicationThread.create({data:{id:randomUUID(),title:'SYNTHETIC_CONTEXT_HIDDEN',ownerUserId:owner.id,deletedAt:new Date()}});
  for(const id of [thread.id,deleted.id])await db.internalCommunicationParticipant.createMany({data:[
    {threadId:id,userId:owner.id},{threadId:id,userId:member.id},{threadId:id,userId:other.id,active:false,version:2}
  ]});
  const bytes=Buffer.from('SYNTHETIC_CONTEXT_RECOVERY_FILE'),sha256=createHash('sha256').update(bytes).digest('hex');
  const storage=process.env.LOCAL_DOCUMENT_STORAGE_ROOT!;assert.ok(path.isAbsolute(storage));
  await mkdir(path.join(storage,'context-recovery'),{recursive:true,mode:0o700});
  const files=[];
  for(const revoked of [false,true]){
    const id=randomUUID(),storagePath='context-recovery/'+id+'.txt';
    await writeFile(path.join(storage,storagePath),bytes,{flag:'wx',mode:0o600});
    files.push(await db.communicationContextFile.create({data:{id,contextKind:'INTERNAL',internalThreadId:thread.id,uploadedById:owner.id,
      fileName:'recovery-context.txt',mimeType:'text/plain',sizeBytes:bytes.length,sha256,storagePath,revokedAt:revoked?new Date():null}}));
  }
  const messages=[];
  for(const context of [{kind:'LEAD' as const,id:lead.id},{kind:'CLIENT' as const,id:client.id},{kind:'INTERNAL' as const,id:thread.id}]){
    const id=randomUUID(),selection=emptyCommunicationRecipientSelection();selection.to.userIds=[member.id];
    const snapshot=approvedMessageSnapshotSchema.parse({schema:'fai.approved-email.v2',messageId:id,revision:1,context,
      clientId:context.kind==='CLIENT'?client.id:null,channel:'EMAIL_MANUAL',mailboxId:box.id,mailboxRevision:box.revision,
      from:box.address,replyTo:box.address,to:[member.email],cc:[],bcc:[],subject:'SYNTHETIC_CONTEXT_RECOVERY_'+context.kind,
      body:'SYNTHETIC_CONTEXT_RETAINED_BODY',classification:'ORDINARY',recipientSelection:selection,externalRecipients:{to:[],cc:[],bcc:[]},
      recipientEvidenceHash:'a'.repeat(64),contextEvidenceHash:'b'.repeat(64),attachments:context.kind==='INTERNAL'?[{
        source:'CONTEXT_FILE',documentId:files[0].id,versionId:files[0].id,filename:files[0].fileName,mimeType:files[0].mimeType,bytes:bytes.length,sha256}]:[]});
    await db.approvedCommunication.create({data:{id,contextKind:context.kind,clientId:context.kind==='CLIENT'?client.id:null,
      leadId:context.kind==='LEAD'?lead.id:null,internalThreadId:context.kind==='INTERNAL'?thread.id:null,mailboxId:box.id,createdById:owner.id}});
    await db.communicationVersion.create({data:{messageId:id,revision:1,createdById:owner.id,snapshot:snapshot as Prisma.InputJsonObject,snapshotHash:approvedMessageHash(snapshot)}});
    messages.push(id);
  }
  await writeFile(process.env.R05_CONTEXT_RECOVERY_FIXTURE!,JSON.stringify({synthetic:true,persistenceOnly:true,threadId:thread.id,deletedThreadId:deleted.id,
    ownerEmail:owner.email,memberEmail:member.email,otherEmail:other.email,leadId:lead.id,clientId:client.id,messageIds:messages,
    fileId:files[0].id,revokedFileId:files[1].id,sha256,bytes:bytes.toString()},null,2));
  console.log('ADMIN_EMAIL_CONTEXT_SYNTHETIC_RESTART_HISTORY_READY');
}
void main().finally(()=>db.$disconnect());
