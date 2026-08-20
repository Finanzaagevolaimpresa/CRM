import {
  createLeadSubmittedEventV1,
  type LeadSubmittedEventInputV1,
} from '../../src/lib/lead-event-contract';

export function syntheticLeadEventInputV1(): LeadSubmittedEventInputV1 {
  return {
    eventId: '00000000-0000-4000-8000-000000000010',
    businessCorrelationId: '00000000-0000-4000-8000-000000000011',
    occurredAt: '2026-08-19T12:00:00.000Z',
    source: {
      systemCode: 'WORDPRESS',
      formCode: 'SYNTHETIC_FORM',
      formVersion: 'v1',
      submissionId: 'SYNTHETIC-000001',
    },
    privacy: {
      service: {
        noticeCode: 'SYNTHETIC_PRIVACY_NOTICE',
        noticeVersion: 'v1',
        purposeCode: 'SERVICE_REQUEST_FOLLOW_UP',
        legalBasisCode: 'PRE_CONTRACTUAL_MEASURES',
        evidenceKind: 'NOTICE_ACKNOWLEDGEMENT',
        decision: 'ACKNOWLEDGED',
      },
      marketing: {
        noticeCode: 'SYNTHETIC_MARKETING_NOTICE',
        noticeVersion: 'v1',
        purposeCode: 'DIRECT_MARKETING',
        legalBasisCode: 'CONSENT',
        evidenceKind: 'CONSENT',
        decision: 'DENIED',
      },
    },
    catalogReference: {
      catalogVersion: '2026-07-12-v1',
      serviceCode: 'verifica_ai_essenziale',
      serviceVersion: 1,
    },
    payload: {
      firstName: 'Synthetic',
      lastName: 'Lead',
      companyName: 'Synthetic Company',
      email: 'synthetic.lead@n10.invalid',
      phone: '+39 333 000 0010',
      city: 'Synthetic City',
      region: 'Synthetic Region',
      interestText: 'Synthetic business interest',
      serviceInterestText: 'Synthetic service request',
      message: 'Synthetic-only N10 contract fixture.',
      sourcePagePath: '/synthetic-contact/',
      requestedAmount: { currency: 'EUR', minorUnits: 5_000_000 },
    },
  };
}

export const SYNTHETIC_LEAD_EVENT_V1 = createLeadSubmittedEventV1(
  syntheticLeadEventInputV1(),
);
