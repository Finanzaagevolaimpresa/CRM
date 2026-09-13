import { createHash } from 'node:crypto';
import type { CommercialLeadActivity } from '@prisma/client';
import { createDisabledCommunicationGateSnapshotV1 } from './communication-backbone-contract';
import {
  createCommunicationPersistenceAuthorityV1,
  recordCommunicationIntentHeldV1,
  type CommunicationPersistenceTransactionV1,
} from './communication-intent-persistence';
import { N15_ASSIGNMENT_SYNTHETIC_OPT_IN } from './n15-synthetic-self-claim-admission';

export const N15_ASSIGNMENT_SYNTHETIC_PROFILE = Object.freeze({
  producerCode: 'CRM_N15_SYNTHETIC_MANAGER_ASSIGNMENT_V1',
  templateCode: 'CRM_MANAGER_ASSIGNMENT_SYNTHETIC_REFERENCE',
  templateVersion: 'n15-r03-v1',
  reasonCode: 'CRM_LEAD_MANAGER_ASSIGNMENT_SYNTHETIC',
  optIn: N15_ASSIGNMENT_SYNTHETIC_OPT_IN,
} as const);

const templateHash = createHash('sha256')
  .update(`${N15_ASSIGNMENT_SYNTHETIC_PROFILE.templateCode}:${N15_ASSIGNMENT_SYNTHETIC_PROFILE.templateVersion}`)
  .digest('hex');

/** Recipient comes only from the target locked and validated by the N14 assignment transaction. */
export function recordN15SyntheticAssignment(
  scope: CommunicationPersistenceTransactionV1,
  activity: Pick<CommercialLeadActivity, 'id' | 'inboxItemId' | 'assigneeAfterId' | 'createdAt'>,
  fault?: (point: 'AFTER_INTENT' | 'AFTER_DECISION') => void,
) {
  if (!activity.assigneeAfterId) throw new Error('N15_SYNTHETIC_ASSIGNMENT_RECIPIENT_REQUIRED');
  const authority = createCommunicationPersistenceAuthorityV1({
    producerCode: N15_ASSIGNMENT_SYNTHETIC_PROFILE.producerCode,
    now: () => activity.createdAt,
  });
  return recordCommunicationIntentHeldV1(scope, authority, {
    intentId: activity.id,
    businessCorrelationId: activity.inboxItemId,
    callerIdempotencyKey: `commercial-lead-assignment:${activity.id}`,
    recipient: { authorityCode: 'CRM', entityType: 'USER', entityId: activity.assigneeAfterId },
    message: {
      messageClass: 'SERVICE',
      reasonCode: N15_ASSIGNMENT_SYNTHETIC_PROFILE.reasonCode,
      templateReference: {
        templateCode: N15_ASSIGNMENT_SYNTHETIC_PROFILE.templateCode,
        templateVersion: N15_ASSIGNMENT_SYNTHETIC_PROFILE.templateVersion,
        templateHash,
      },
    },
    gateSnapshot: createDisabledCommunicationGateSnapshotV1(),
  }, fault);
}
