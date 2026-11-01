import { writeFile } from 'node:fs/promises';
import { db, fixture, claimed, runtime } from './fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity, assertAiOrchestratorEphemeralDbTestConfiguration } from '../db/ai-orchestrator-db-test-guard';
import { recordStoredOrdinaryEmailOutcome } from '../../src/lib/ordinary-email-store-candidate';
import { writeOrdinaryObservation } from '../../src/lib/ordinary-email-observation';
async function main() {
  if (process.env.ORDINARY_RECOVERY_DB_TESTS !== '1' || !assertAiOrchestratorEphemeralDbTestConfiguration({
    requested: process.env.RUN_DB_TESTS === '1', destructiveConfirmed: process.env.AI_ORCHESTRATOR_DB_TESTS_CONFIRMED === '1',
    databaseUrl: process.env.DATABASE_URL, sentinel: process.env.AI_ORCHESTRATOR_DB_TEST_SENTINEL,
    appEnvironment: process.env.APP_ENV, nodeEnvironment: process.env.NODE_ENV })) throw new Error('SYNTHETIC_ONLY');
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const [ledger] = await db.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
  if (ledger.count !== 74n) throw new Error('SCHEMA74_REQUIRED');
  const rows=[];
  for (const state of ['CLAIMED','UNCERTAIN'] as const) {
    const f=await fixture(), c=await claimed(f);
    await writeOrdinaryObservation(c.lease,c.input,{outcome:'ACCEPTED',phase:'CONTENT',replyCode:250},new Date());
    if(state==='UNCERTAIN') await recordStoredOrdinaryEmailOutcome(db,c.lease,{outcome:'UNCERTAIN',phase:'CONTENT',replyCode:250});
    rows.push({ state, messageId:f.saved.id, attemptId:c.reserved.attemptId, keyVersion:runtime.key.version });
  }
  const result={synthetic:true,schema:74,rows,productionContact:false};
  await writeFile(process.argv[2],JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({synthetic:true,seeded:rows.length,schema:74,productionContact:false}));
}
main().finally(()=>db.$disconnect()).catch(error=>{console.error(error);process.exitCode=1;});
