import {
  createLeadSubmittedEventV1,
  type LeadEventPayloadV1,
} from '../../src/lib/lead-event-contract';
import { syntheticLeadEventInputV1 } from './n10-lead-event-v1';

export const N13_SYNTHETIC_KEY_VERSION = 7;
export const N13_SYNTHETIC_KEY_SECRET = Buffer.from(
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  'hex',
);

export function syntheticN13LeadEvent(overrides: Readonly<{
  payload?: Partial<LeadEventPayloadV1>;
}> = {}) {
  const base = syntheticLeadEventInputV1();
  return createLeadSubmittedEventV1({
    ...base,
    eventId: '00000000-0000-4000-8000-000000000013',
    businessCorrelationId: '00000000-0000-4000-8000-000000000014',
    source: {
      ...base.source,
      formCode: 'N13_SYNTHETIC_FORM',
      submissionId: 'N13-SYNTHETIC-000001',
    },
    payload: {
      ...base.payload,
      ...overrides.payload,
    },
  });
}
