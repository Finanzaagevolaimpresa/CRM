import { canonicalJson, sha256 } from '../../src/lib/canonical-json';
import {
  createCommunicationAuditRecordV1,
  createCommunicationHeldDecisionV1,
  createDisabledCommunicationGateSnapshotV1,
  parseCommunicationIntentV1,
} from '../../src/lib/communication-backbone-contract';

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  }
  return value;
}

export function executeDeterministicCommunicationMockV1(
  intentValue: unknown,
  evaluatedAtValue: unknown,
) {
  const intent = parseCommunicationIntentV1(intentValue);
  const heldDecision = createCommunicationHeldDecisionV1(
    intent,
    createDisabledCommunicationGateSnapshotV1(),
    evaluatedAtValue,
  );
  const audit = createCommunicationAuditRecordV1(intent, heldDecision);
  const core = {
    schemaVersion: 'fai.communication-mock-result.v1',
    resultVersion: 1,
    outcome: 'HELD',
    reasonCode: heldDecision.reasonCode,
    intentReferenceHash: audit.intentReferenceHash,
    semanticHash: intent.idempotency.semanticHash,
    gateSnapshotHash: audit.gateSnapshotHash,
    decisionHash: heldDecision.decisionHash,
    dispatch: 'NOT_ATTEMPTED',
    sideEffects: {
      persistence: false,
      network: false,
      dispatch: false,
      egress: false,
      delivery: false,
    },
  } as const;
  return deepFreeze({
    ...core,
    resultHash: sha256(`fai.communication-mock-result.v1\n${canonicalJson(core)}`),
  });
}
