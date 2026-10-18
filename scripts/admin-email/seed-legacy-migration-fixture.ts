import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { approvedMessageSnapshotSchema, approvedMessageHash } from '../../src/lib/approved-communication-contract';
const db=new PrismaClient();
async function main(){
  assert.equal(process.env.CI,'true');assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.APP_ENV,'test');
  const url=new URL(process.env.DATABASE_URL!);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'5432');assert.equal(url.pathname,'/fai_crm_test');
  const [guard]=await db.$queryRaw<Array<{count:number;sentinel:string}>>`SELECT count(*)::integer AS count,
    (SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()) AS sentinel
    FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
  assert.equal(guard.count,51);assert.equal(guard.sentinel,'FAI_CRM_EPHEMERAL_TEST_ONLY_V1');
  const box=await db.communicationMailbox.findUniqueOrThrow({where:{address:'comunicazioni@finanzaagevolaimpresa.it'}});
  const snapshot=approvedMessageSnapshotSchema.parse({schema:'fai.approved-email.v1',messageId:'22222222-5252-4252-8252-222222222222',revision:1,
    context:{kind:'TECHNICAL',id:'migration52-practice'},clientId:'migration52-client',channel:'EMAIL_MANUAL',mailboxId:box.id,mailboxRevision:box.revision,
    from:box.address,replyTo:box.address,to:['synthetic-legacy@invalid.test'],cc:[],bcc:[],subject:'Historical v1 migration fixture',body:'SYNTHETIC_LEGACY_V1_ONLY',attachments:[],classification:'ORDINARY'});
  // Schema51 intentionally lacks later provenance columns: return only the historical id.
  await db.communicationVersion.create({data:{id:'33333333-5252-4252-8252-333333333333',messageId:snapshot.messageId,revision:1,
    snapshot:JSON.parse(JSON.stringify(snapshot)),snapshotHash:approvedMessageHash(snapshot),createdById:'migration52-owner'},select:{id:true}});
}
main().finally(()=>db.$disconnect());
