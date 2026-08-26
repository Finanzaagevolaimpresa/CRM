import {
  createCommunicationIntentV1,
  type CommunicationIntentInputV1,
} from '../../src/lib/communication-backbone-contract';

export const SYNTHETIC_COMMUNICATION_INTENT_INPUT_V1 = {
  intentId: '018f47a2-4d12-4abc-8def-0123456789ab',
  businessCorrelationId: '6f9619ff-8b86-4aa9-a111-223344556677',
  occurredAt: '2026-08-26T05:00:00.000Z',
  source: {
    producerCode: 'CRM_CORE',
    callerIdempotencyKey: 'N15:CRM:CASE:0001',
  },
  recipient: {
    authorityCode: 'CRM',
    entityType: 'LEAD',
    entityId: 'c000000000000000000000001',
  },
  message: {
    messageClass: 'SERVICE',
    reasonCode: 'CASE_STATUS_UPDATE',
    templateReference: {
      templateCode: 'CASE_STATUS_UPDATE',
      templateVersion: 'n15-test-v1',
      templateHash: 'a'.repeat(64),
    },
  },
} as const satisfies CommunicationIntentInputV1;

export const SYNTHETIC_COMMUNICATION_INTENT_V1 = createCommunicationIntentV1(
  SYNTHETIC_COMMUNICATION_INTENT_INPUT_V1,
);

export const SYNTHETIC_COMMUNICATION_EVALUATED_AT_V1 = '2026-08-26T05:00:01.000Z';
