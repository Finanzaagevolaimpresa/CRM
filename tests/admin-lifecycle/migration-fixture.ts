import { PrismaClient } from '@prisma/client';
import { syntheticAuthority } from '../selective-sharing/fixtures';
import { adminHistoryFixture } from '../admin-records/history-fixture';
import { storedNoticeMessage, linkedOrdinaryNoticeReply } from '../record-updates/communication-fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';

/** Synthetic immutable history prepared on schema72, before state enrollment. */
const db=new PrismaClient();
async function main(){
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const ledger=await db.$queryRaw<Array<{count:number}>>`SELECT count(*)::int AS count FROM "_prisma_migrations"
    WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
  if(ledger[0].count!==72)throw new Error('SYNTHETIC_BASE72_REQUIRED');
  const actor=await syntheticAuthority(db),source=await adminHistoryFixture(db,actor.user.id);
  const outgoing=await storedNoticeMessage(db,{leadId:source.lead.id,authorId:actor.user.id});
  await linkedOrdinaryNoticeReply(db,outgoing.message.id,outgoing.mailbox.id,actor.user.id);
  console.log(JSON.stringify({synthetic:true,base:72,sourceKinds:['ControlledIntake','ApprovedCommunication','CommunicationReply']}));
}
void main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>db.$disconnect());
