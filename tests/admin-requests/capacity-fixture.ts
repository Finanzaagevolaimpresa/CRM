import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Person } from '../selective-leads/fixtures';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { canonicalSha256 } from '../../src/lib/canonical-json';
import { adminRequestSubmissionDigest, type AdminRequestSubmission } from '../../src/lib/admin-request-contract';
import { requestCommandHash, requestStateSchema, flushAdminRequestConstraints } from '../../src/lib/admin-request-storage';

/** CI-only bulk fixture. Real retained rows, matching events and minimal audits
 * commit together with all database constraints enabled. No production data. */
export async function seedRequestCapacity(db: PrismaClient, person: Person, input: AdminRequestSubmission, count = 6001) {
  assert.equal(process.env.CI, 'true');
  assert(process.env.ADMIN_REQUEST_DB_TESTS === '1' || process.env.ADMIN_REQUEST_BROWSER_CONFIRMED === '1');
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  assert(Number.isInteger(count) && count > 0 && count <= 6001);
  const ids: string[] = [];
  for (let start = 0; start < count; start += 250) {
    const rows = Array.from({ length: Math.min(250, count - start) }, () => {
      const id = randomUUID(), submitted = { ...input, commandId: id };
      const state = requestStateSchema.parse({ requestId: id, authorId: person.user.id, sessionId: person.session.sessionId,
        revision: 1, status: 'OPEN', submitted, requesterReply: null,
        submissionSha256: adminRequestSubmissionDigest({ userId: person.user.id, sessionId: person.session.sessionId! }, submitted) });
      ids.push(id);
      return { id, author: person.user.id, session: person.session.sessionId, kind: input.subject.kind, target: input.subject.targetId,
        state, hash: canonicalSha256(state), event: randomUUID(),
        commandHash: requestCommandHash(person.user.id, person.session.sessionId!, 'SUBMIT', submitted) };
    });
    const payload = JSON.stringify(rows);
    await db.$transaction(async tx => {
      await tx.$executeRaw`INSERT INTO "AdminRequest"(id,"authorId","sessionId",kind,"leadId","clientId","projectId","practiceId",revision,state,"stateHash")
        SELECT r.id::uuid,r.author,r.session::uuid,r.kind,
          CASE WHEN r.kind='Lead' THEN r.target END, CASE WHEN r.kind='Client' THEN r.target END,
          CASE WHEN r.kind='Project' THEN r.target END, CASE WHEN r.kind='TechnicalPractice' THEN r.target END,1,r.state,r.hash
        FROM jsonb_to_recordset(${payload}::jsonb) AS r(id text,author text,session text,kind text,target text,state jsonb,hash text)`;
      await tx.$executeRaw`INSERT INTO "AdminRequestEvent"(id,"requestId",revision,"commandId","actorId","sessionId",operation,"commandHash",state,"stateHash")
        SELECT r.event::uuid,r.id::uuid,1,r.id::uuid,r.author,r.session::uuid,'SUBMIT',r."commandHash",r.state,r.hash
        FROM jsonb_to_recordset(${payload}::jsonb) AS r(event text,id text,author text,session text,"commandHash" text,state jsonb,hash text)`;
      await tx.$executeRaw`INSERT INTO "AuditLog"(id,"actorId",event,"entityType","entityId",before,after)
        SELECT r.event,r.author,'admin_request_changed','AdminRequestEvent',r.event,
          jsonb_build_object('version',0),jsonb_build_object('version',1,'action','SUBMIT','stateHash',r.hash)
        FROM jsonb_to_recordset(${payload}::jsonb) AS r(event text,author text,hash text)`;
      await flushAdminRequestConstraints(tx);
    }, { timeout: 30_000 });
  }
  return ids;
}
