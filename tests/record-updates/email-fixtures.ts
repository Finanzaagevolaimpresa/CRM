import type { PrismaClient } from '@prisma/client';
import type { AuthSession } from '../../src/lib/auth';
import { assertAiOrchestratorEphemeralDatabaseIdentity } from '../db/ai-orchestrator-db-test-guard';
import { configureCommunicationMailbox, qualifyCommunicationMailbox } from '../../src/lib/approved-communications';

/** Synthetic database qualification only; no transport or provider is contacted. */
export async function syntheticUpdateMailbox(db: PrismaClient, actor: AuthSession) {
  await assertAiOrchestratorEphemeralDatabaseIdentity(db);
  const old = await db.communicationMailbox.findUniqueOrThrow({ where: { address: 'comunicazioni@finanzaagevolaimpresa.it' } });
  const box = await configureCommunicationMailbox(db, actor, { mailboxId: old.id, expectedRevision: old.revision,
    kind: 'MAILBOX', canonicalMailboxId: null, providerReference: 'register_it', responsibleUserId: actor.userId,
    canSend: true, canReceive: true, restricted: false, configurationReference: 'M4_COMUNICAZIONI_REGISTER_IT' });
  await qualifyCommunicationMailbox(db, actor, { mailboxId: box.id, expectedRevision: box.revision, action: 'TEST', testReference: 'SYNTHETIC_UPDATE_EMAIL_ONLY' });
  await qualifyCommunicationMailbox(db, actor, { mailboxId: box.id, expectedRevision: box.revision, action: 'ENABLE' });
  await db.ordinaryEmailAuthority.create({ data: { id: 'ordinary-email', userId: actor.userId, mailboxId: box.id, enabled: true } });
  await db.ordinaryEmailChannel.create({ data: { mailboxId: box.id, mailboxRevision: box.revision, qualificationReference: 'SYNTHETIC_UPDATE_EMAIL_ONLY', enabled: true } });
  return box;
}
