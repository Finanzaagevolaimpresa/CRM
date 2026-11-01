import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { syntheticSession } from '../selective-sharing/fixtures';
import { leadProof } from '../selective-leads/fixtures';
import { readTechnicalAssignmentManagement } from '../../src/lib/technical-assignment-management';
import { previewTechnicalAssignment, confirmTechnicalAssignment } from '../../src/lib/technical-assignment-service';
import type { TechnicalTargetReference } from '../../src/lib/technical-assignment-display';

/** The 200 filler decisions use the real admission/preview/confirmation writer.
 * Only synthetic users are inserted directly; no journal or grant is forged. */
export async function seedAssignmentOverviewBoundary(db: PrismaClient, adminId: string,
  target: TechnicalTargetReference, selectedId: string) {
  assert.equal(process.env.CI, 'true');
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const user = await db.user.findUniqueOrThrow({ where: { id: adminId } });
  const actor = { user, ...await syntheticSession(db, user) };
  const suffix = randomUUID(), people = Array.from({ length: 200 }, (_, i) => ({
    id: `000-pagination-${String(i).padStart(3, '0')}-${suffix}`,
    name: `AAAA Pagina sintetica ${i}`, email: `${i}-${suffix}@pagination.invalid.test`,
    role: 'consulente' as const, passwordHash: 'synthetic-not-for-login',
  }));
  assert(people.every(person => person.id < selectedId));
  await db.user.createMany({ data: people });
  const setup = await readTechnicalAssignmentManagement(db, actor.session, target, selectedId);
  for (const person of people) {
    const ref = { ...target, recipientId: person.id };
    const input = { commandId: randomUUID(), targetId: target.targetId, expectedRevision: 0,
      expectedContextSha256: setup.contextSha256, expectedRecipientEpoch: 1,
      selection: { kind: target.kind, userId: person.id, responsibility: 'supporto',
        actions: ['update_status'], readableFields: ['status'], editableFields: [],
        documents: [], expiresAt: new Date(Date.now() + 3600000).toISOString() },
      reason: 'Decisione sintetica per limite elenco 200' };
    const preview = await previewTechnicalAssignment(db, actor.session, ref, 'ASSIGN', input);
    await confirmTechnicalAssignment(db, actor.session, leadProof(actor), ref, 'ASSIGN', input, preview.token, true);
  }
  const selected = await readTechnicalAssignmentManagement(db, actor.session, target, selectedId);
  assert.equal(selected.assignmentsLimited, true); assert.equal(selected.assignments.length, 200);
  assert(!selected.assignments.some(row => row.recipientId === selectedId));
  assert(!selected.people.some(row => row.id === selectedId));
  assert.equal(selected.selectedAssignment?.recipientId, selectedId);
  return selected;
}
