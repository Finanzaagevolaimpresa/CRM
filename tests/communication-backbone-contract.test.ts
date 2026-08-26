import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { canonicalJson, canonicalSha256 } from '../src/lib/canonical-json';
import {
  COMMUNICATION_GATE_CODES,
  COMMUNICATION_INTENT_CANONICALIZATION_VERSION,
  COMMUNICATION_INTENT_MANIFEST,
  COMMUNICATION_INTENT_SCHEMA_VERSION,
  COMMUNICATION_INTENT_STATES,
  COMMUNICATION_INTENT_TYPE,
  COMMUNICATION_INTENT_VERSION,
  COMMUNICATION_MESSAGE_CLASSES,
  COMMUNICATION_RECIPIENT_ENTITY_TYPES,
  CommunicationIntentContractError,
  compareCommunicationIntentIdempotencyV1,
  createCommunicationAuditRecordV1,
  createCommunicationHeldDecisionV1,
  createCommunicationIntentV1,
  createDisabledCommunicationGateSnapshotV1,
  evaluateCommunicationGatesV1,
  isCommunicationIntentStateTransitionAllowedV1,
  parseCommunicationGateSnapshotV1,
  parseCommunicationHeldDecisionV1,
  parseCommunicationIntentV1,
  type CommunicationGateCode,
  type CommunicationIntentContractErrorCode,
} from '../src/lib/communication-backbone-contract';
import {
  assertClassifiedFields,
  dataClassificationCatalog,
  redactAuditPayload,
  UnclassifiedDataFieldError,
} from '../src/lib/data-classification';
import {
  SYNTHETIC_COMMUNICATION_EVALUATED_AT_V1,
  SYNTHETIC_COMMUNICATION_INTENT_INPUT_V1,
  SYNTHETIC_COMMUNICATION_INTENT_V1,
} from './fixtures/n15-communication-intent-v1';
import { executeDeterministicCommunicationMockV1 } from './fixtures/n15-communication-mock';

function expectContractError(
  code: CommunicationIntentContractErrorCode,
  operation: () => unknown,
) {
  assert.throws(
    operation,
    (error: unknown) => error instanceof CommunicationIntentContractError
      && error.code === code
      && error.message === code
      && error.cause === undefined,
  );
}

function inputWith(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    ...SYNTHETIC_COMMUNICATION_INTENT_INPUT_V1,
    source: { ...SYNTHETIC_COMMUNICATION_INTENT_INPUT_V1.source },
    recipient: { ...SYNTHETIC_COMMUNICATION_INTENT_INPUT_V1.recipient },
    message: {
      ...SYNTHETIC_COMMUNICATION_INTENT_INPUT_V1.message,
      templateReference: {
        ...SYNTHETIC_COMMUNICATION_INTENT_INPUT_V1.message.templateReference,
      },
    },
    ...overrides,
  };
}

function jsonClone(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function assertDeepFrozen(value: unknown) {
  if (value === null || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true);
  for (const item of Object.values(value as Record<string, unknown>)) assertDeepFrozen(item);
}

function sourceFilesUnder(path: string): string[] {
  if (!existsSync(path)) return [];
  const output: string[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = `${path}/${entry.name}`;
    if (entry.isDirectory()) output.push(...sourceFilesUnder(child));
    else if (/\.(?:c|m)?(?:j|t)sx?$/u.test(entry.name)) output.push(child);
  }
  return output;
}

test('N15 Phase 1A manifest is contract-only, outbound, dormant and provider-free', () => {
  assert.equal(COMMUNICATION_INTENT_SCHEMA_VERSION, 'fai.communication-intent.v1');
  assert.equal(COMMUNICATION_INTENT_TYPE, 'COMMUNICATION_INTENT');
  assert.equal(COMMUNICATION_INTENT_VERSION, 1);
  assert.equal(COMMUNICATION_INTENT_CANONICALIZATION_VERSION, 1);
  assert.deepEqual(COMMUNICATION_MESSAGE_CLASSES, ['TRANSACTIONAL', 'SERVICE', 'SECURITY']);
  assert.deepEqual(COMMUNICATION_INTENT_STATES, ['RECORDED', 'HELD']);
  assert.deepEqual(COMMUNICATION_RECIPIENT_ENTITY_TYPES, [
    'LEAD', 'CLIENT', 'PERSON', 'COMPANY', 'USER',
  ]);
  assert.deepEqual(COMMUNICATION_INTENT_MANIFEST, {
    schemaVersion: 'fai.communication-intent.v1',
    mode: 'CONTRACT_ONLY',
    direction: 'OUTBOUND',
    dormant: true,
    activation: 'NONE',
    persistence: 'NONE',
    n11Adapter: 'NONE',
    transport: 'NONE',
    providers: [],
    runtimeProducers: [],
    runtimeConsumers: [],
    recipientAuthority: 'CRM_REFERENCE_ONLY',
    recipientResolution: 'NONE',
    recipientEndpointSnapshot: 'NONE',
    body: 'NONE',
    marketingAllowed: false,
    workerAllowed: false,
    dispatchAllowed: false,
    networkEgressAllowed: false,
    gateEvaluation: 'HIERARCHICAL_ALL_OF',
    phase1AlwaysHeld: true,
    dataMode: 'SYNTHETIC_OR_REFERENCE_ONLY',
    messageClasses: ['TRANSACTIONAL', 'SERVICE', 'SECURITY'],
  });
  assertDeepFrozen(COMMUNICATION_INTENT_MANIFEST);
});

test('N15 Phase 1C records a dedicated persistence boundary without implementing it', () => {
  const adr = readFileSync(
    'docs/adr/ADR-0014-n15-communication-intent-dedicated-persistence-boundary-v1.md',
    'utf8',
  );
  for (const decision of [
    'N15_PHASE1C_DECISION_STATUS=ACCEPTED_ARCHITECTURE_NOT_IMPLEMENTED',
    'N15_PHASE1C_TARGET_STORAGE_BOUNDARY=DEDICATED_N15',
    'N15_PHASE1C_SHARED_PRIMITIVES=PURE_ONLY',
    'N15_PHASE1C_CURRENT_SCHEMA=UNCHANGED',
    'N15_PHASE1C_CURRENT_MIGRATIONS=42',
    'N15_PHASE1C_CURRENT_PERSISTENCE=NONE',
    'N15_PHASE1C_CURRENT_RUNTIME=NONE',
    'N15_PHASE1C_CURRENT_ACTIVATION=NONE',
    'N15_PHASE1C_N11_STORAGE_REUSE=FORBIDDEN',
    'N15_PHASE1C_N11_ADAPTER=NONE',
    'N15_PHASE1C_QUEUE_LIFECYCLE=DEFERRED',
    'N15_PHASE1C_F1_REMEDIATION=OUT_OF_SCOPE',
  ]) {
    assert.match(adr, new RegExp(`^${decision}$`, 'mu'), decision);
  }
  assert.match(adr, /OPEN_HUMAN_DECISION/u);
  assert.match(adr, /merge senza autorizzazione umana separata e vincolata all'head qualificato/u);
});

test('N15 Phase 1A canonical artifacts remain byte-characterized across Phase 1C', () => {
  const gate = createDisabledCommunicationGateSnapshotV1();
  const held = createCommunicationHeldDecisionV1(
    SYNTHETIC_COMMUNICATION_INTENT_V1,
    gate,
    SYNTHETIC_COMMUNICATION_EVALUATED_AT_V1,
  );
  const audit = createCommunicationAuditRecordV1(SYNTHETIC_COMMUNICATION_INTENT_V1, held);
  const mock = executeDeterministicCommunicationMockV1(
    SYNTHETIC_COMMUNICATION_INTENT_V1,
    SYNTHETIC_COMMUNICATION_EVALUATED_AT_V1,
  );
  assert.deepEqual({
    intent: canonicalSha256(SYNTHETIC_COMMUNICATION_INTENT_V1),
    gate: canonicalSha256(gate),
    held: canonicalSha256(held),
    audit: canonicalSha256(audit),
    mock: canonicalSha256(mock),
  }, {
    intent: '9bb7dd0390dfe3452cfa44ca7279b81249f97beb2ba39508ab00c561443eb07d',
    gate: 'c42f4be529776f6a5a6b1ca12894010a9ceb1560f65d32084304e29aae4fbfab',
    held: '04a6417fb912549d852c115fddcc32cb0c54ed40c930bb3a8fa0422ddeb9c64f',
    audit: '332c86456cddc9d9250ff107ac83965122761fa499ecb618a179e4c1777ebf00',
    mock: 'a249d46b5e0ab182fbb64e114427c142e0e49dd68031cfe735fe0ef94d361ec2',
  });
});

test('N15 creates and parses a canonical frozen intent with stable golden hashes', () => {
  const intent = SYNTHETIC_COMMUNICATION_INTENT_V1;
  assert.equal(intent.state, 'RECORDED');
  assert.equal(intent.occurredAt, '2026-08-26T05:00:00.000Z');
  assert.equal('callerIdempotencyKey' in intent.source, false);
  assert.equal(intent.idempotency.keyDigest, 'eb0d0f57c07c0c5e40e100ff32ef57efa29839288b219a15093247bd122402e5');
  assert.equal(intent.idempotency.semanticHash, '18545c3aaa0ff2bef397278ac6a0ed09ec795abb6ea4ec69b4b5eeac97ff4b2a');
  assert.equal(intent.idempotency.envelopeHash, '2bca3a73d3855551c3e014260fbeddc17da82ce28a7bc22c77afb7a1597a47ba');
  assert.deepEqual(parseCommunicationIntentV1(jsonClone(intent)), intent);
  assertDeepFrozen(intent);
  assertDeepFrozen(parseCommunicationIntentV1(jsonClone(intent)));
});

test('N15 admits only approved classes and exact CRM entity references without endpoints', () => {
  for (const messageClass of COMMUNICATION_MESSAGE_CLASSES) {
    const intent = createCommunicationIntentV1(inputWith({
      message: { ...SYNTHETIC_COMMUNICATION_INTENT_INPUT_V1.message, messageClass },
    }));
    assert.equal(intent.message.messageClass, messageClass);
  }
  for (const entityType of COMMUNICATION_RECIPIENT_ENTITY_TYPES) {
    const intent = createCommunicationIntentV1(inputWith({
      recipient: { ...SYNTHETIC_COMMUNICATION_INTENT_INPUT_V1.recipient, entityType },
    }));
    assert.equal(intent.recipient.entityType, entityType);
  }
  for (const messageClass of ['MARKETING', 'COMMERCIAL', 'PROMOTIONAL', 'service', ' SERVICE']) {
    expectContractError('COMMUNICATION_INTENT_CLASS_UNSUPPORTED', () => createCommunicationIntentV1(inputWith({
      message: { ...SYNTHETIC_COMMUNICATION_INTENT_INPUT_V1.message, messageClass },
    })));
  }
  expectContractError('COMMUNICATION_INTENT_RECIPIENT_INVALID', () => createCommunicationIntentV1(inputWith({
    recipient: { authorityCode: 'CRM', entityType: 'LEAD', entityId: '+393331234567' },
  })));
  expectContractError('COMMUNICATION_INTENT_RECIPIENT_INVALID', () => createCommunicationIntentV1(inputWith({
    recipient: { authorityCode: 'EXTERNAL', entityType: 'LEAD', entityId: 'c000000000000000000000001' },
  })));
  expectContractError('COMMUNICATION_INTENT_FIELD_UNKNOWN', () => createCommunicationIntentV1(inputWith({
    recipient: { ...SYNTHETIC_COMMUNICATION_INTENT_INPUT_V1.recipient, email: 'n15@example.invalid' },
  })));
  expectContractError('COMMUNICATION_INTENT_FIELD_UNKNOWN', () => createCommunicationIntentV1(inputWith({
    message: { ...SYNTHETIC_COMMUNICATION_INTENT_INPUT_V1.message, body: 'synthetic body' },
  })));
  expectContractError('COMMUNICATION_INTENT_FIELD_UNKNOWN', () => createCommunicationIntentV1(inputWith({
    message: {
      ...SYNTHETIC_COMMUNICATION_INTENT_INPUT_V1.message,
      templateReference: {
        ...SYNTHETIC_COMMUNICATION_INTENT_INPUT_V1.message.templateReference,
        endpoint: 'https://example.invalid',
      },
    },
  })));
});

test('N15 rejects unknown, inherited, accessor, symbol and non-plain input without value echo', () => {
  expectContractError('COMMUNICATION_INTENT_FIELD_UNKNOWN', () => createCommunicationIntentV1({
    ...inputWith(), unexpected: true,
  }));
  expectContractError('COMMUNICATION_INTENT_ENVELOPE_INVALID', () => createCommunicationIntentV1([]));
  expectContractError('COMMUNICATION_INTENT_FIELD_INVALID', () => createCommunicationIntentV1(inputWith({
    source: new Date('2026-08-26T05:00:00.000Z'),
  })));

  const accessor = inputWith();
  Object.defineProperty(accessor, 'message', {
    enumerable: true,
    get: () => SYNTHETIC_COMMUNICATION_INTENT_INPUT_V1.message,
  });
  expectContractError('COMMUNICATION_INTENT_ENVELOPE_INVALID', () => createCommunicationIntentV1(accessor));

  const nonEnumerable = inputWith();
  Object.defineProperty(nonEnumerable, 'unexpected', { enumerable: false, value: true });
  expectContractError('COMMUNICATION_INTENT_FIELD_UNKNOWN', () => createCommunicationIntentV1(nonEnumerable));

  const symbolBearing = {
    ...inputWith(),
    [Symbol('n15-private')]: 'synthetic-private-value',
  };
  expectContractError('COMMUNICATION_INTENT_FIELD_UNKNOWN', () => createCommunicationIntentV1(symbolBearing));

  const inherited = Object.assign(Object.create({ inherited: true }), inputWith()) as unknown;
  expectContractError('COMMUNICATION_INTENT_ENVELOPE_INVALID', () => createCommunicationIntentV1(inherited));

  const trapped = new Proxy(inputWith(), {
    ownKeys() { throw new Error('synthetic-private-value'); },
  });
  expectContractError('COMMUNICATION_INTENT_ENVELOPE_INVALID', () => createCommunicationIntentV1(trapped));
  const revokedIntent = Proxy.revocable({}, {});
  revokedIntent.revoke();
  expectContractError(
    'COMMUNICATION_INTENT_ENVELOPE_INVALID',
    () => createCommunicationIntentV1(revokedIntent.proxy),
  );
  expectContractError(
    'COMMUNICATION_INTENT_ENVELOPE_INVALID',
    () => parseCommunicationIntentV1(revokedIntent.proxy),
  );

  const privateValue = 'PRIVATE_N15_VALUE_MUST_NOT_ECHO';
  try {
    createCommunicationIntentV1(inputWith({
      source: { producerCode: 'CRM_CORE', callerIdempotencyKey: privateValue.repeat(8) },
    }));
    assert.fail('expected contract rejection');
  } catch (error) {
    assert.equal(error instanceof CommunicationIntentContractError, true);
    assert.equal(String(error).includes(privateValue), false);
  }
});

test('N15 normalizes time and technical references before computing separated hashes', () => {
  const normalized = createCommunicationIntentV1(inputWith({
    intentId: SYNTHETIC_COMMUNICATION_INTENT_INPUT_V1.intentId.toUpperCase(),
    businessCorrelationId: SYNTHETIC_COMMUNICATION_INTENT_INPUT_V1.businessCorrelationId.toUpperCase(),
    occurredAt: '2026-08-26T07:00:00+02:00',
    source: { producerCode: ' CRM_CORE ', callerIdempotencyKey: ' N15:CRM:CASE:0001 ' },
  }));
  assert.equal(normalized.intentId, SYNTHETIC_COMMUNICATION_INTENT_V1.intentId);
  assert.equal(normalized.businessCorrelationId, SYNTHETIC_COMMUNICATION_INTENT_V1.businessCorrelationId);
  assert.equal(normalized.occurredAt, SYNTHETIC_COMMUNICATION_INTENT_V1.occurredAt);
  assert.deepEqual(normalized.idempotency, SYNTHETIC_COMMUNICATION_INTENT_V1.idempotency);

  const replayEnvelope = createCommunicationIntentV1(inputWith({
    intentId: '9f4f22df-b0c1-4bcc-9dc1-556677889900',
    occurredAt: '2026-08-26T05:00:02.000Z',
  }));
  assert.equal(replayEnvelope.idempotency.keyDigest, SYNTHETIC_COMMUNICATION_INTENT_V1.idempotency.keyDigest);
  assert.equal(replayEnvelope.idempotency.semanticHash, SYNTHETIC_COMMUNICATION_INTENT_V1.idempotency.semanticHash);
  assert.notEqual(replayEnvelope.idempotency.envelopeHash, SYNTHETIC_COMMUNICATION_INTENT_V1.idempotency.envelopeHash);

  const changedTemplate = createCommunicationIntentV1(inputWith({
    message: {
      ...SYNTHETIC_COMMUNICATION_INTENT_INPUT_V1.message,
      templateReference: {
        ...SYNTHETIC_COMMUNICATION_INTENT_INPUT_V1.message.templateReference,
        templateHash: 'b'.repeat(64),
      },
    },
  }));
  assert.equal(changedTemplate.idempotency.keyDigest, SYNTHETIC_COMMUNICATION_INTENT_V1.idempotency.keyDigest);
  assert.notEqual(changedTemplate.idempotency.semanticHash, SYNTHETIC_COMMUNICATION_INTENT_V1.idempotency.semanticHash);
  assert.notEqual(
    SYNTHETIC_COMMUNICATION_INTENT_V1.idempotency.keyDigest,
    SYNTHETIC_COMMUNICATION_INTENT_V1.idempotency.semanticHash,
  );

  const permuted = createCommunicationIntentV1({
    message: {
      templateReference: {
        templateHash: 'a'.repeat(64),
        templateVersion: 'n15-test-v1',
        templateCode: 'CASE_STATUS_UPDATE',
      },
      reasonCode: 'CASE_STATUS_UPDATE',
      messageClass: 'SERVICE',
    },
    recipient: {
      entityId: 'c000000000000000000000001',
      entityType: 'LEAD',
      authorityCode: 'CRM',
    },
    source: { callerIdempotencyKey: 'N15:CRM:CASE:0001', producerCode: 'CRM_CORE' },
    occurredAt: '2026-08-26T05:00:00.000Z',
    businessCorrelationId: '6f9619ff-8b86-4aa9-a111-223344556677',
    intentId: '018f47a2-4d12-4abc-8def-0123456789ab',
  });
  assert.deepEqual(permuted.idempotency, SYNTHETIC_COMMUNICATION_INTENT_V1.idempotency);
});

test('N15 hybrid idempotency distinguishes NEW, REPLAY and CONFLICT without persistence', () => {
  const stored = {
    keyDigest: SYNTHETIC_COMMUNICATION_INTENT_V1.idempotency.keyDigest,
    semanticHash: SYNTHETIC_COMMUNICATION_INTENT_V1.idempotency.semanticHash,
  };
  assert.equal(compareCommunicationIntentIdempotencyV1(null, SYNTHETIC_COMMUNICATION_INTENT_V1), 'NEW');
  assert.equal(compareCommunicationIntentIdempotencyV1(stored, SYNTHETIC_COMMUNICATION_INTENT_V1), 'REPLAY');
  const sameSemanticNewEnvelope = createCommunicationIntentV1(inputWith({
    intentId: '9f4f22df-b0c1-4bcc-9dc1-556677889900',
    occurredAt: '2026-08-26T05:00:02.000Z',
  }));
  assert.equal(compareCommunicationIntentIdempotencyV1(stored, sameSemanticNewEnvelope), 'REPLAY');
  const conflict = createCommunicationIntentV1(inputWith({
    message: { ...SYNTHETIC_COMMUNICATION_INTENT_INPUT_V1.message, reasonCode: 'DOCUMENT_ACTION_REQUIRED' },
  }));
  assert.equal(compareCommunicationIntentIdempotencyV1(stored, conflict), 'CONFLICT');
  const newKey = createCommunicationIntentV1(inputWith({
    source: { producerCode: 'CRM_CORE', callerIdempotencyKey: 'N15:CRM:CASE:0002' },
  }));
  assert.equal(compareCommunicationIntentIdempotencyV1(stored, newKey), 'NEW');
  expectContractError('COMMUNICATION_INTENT_HASH_INVALID', () => compareCommunicationIntentIdempotencyV1({
    keyDigest: 'invalid', semanticHash: 'a'.repeat(64),
  }, SYNTHETIC_COMMUNICATION_INTENT_V1));
  for (const invalidStored of [undefined, false, 0, '', {}, [], {
    ...stored, unexpected: true,
  }]) {
    expectContractError(
      'COMMUNICATION_INTENT_HASH_INVALID',
      () => compareCommunicationIntentIdempotencyV1(invalidStored, SYNTHETIC_COMMUNICATION_INTENT_V1),
    );
  }
  const accessorStored = Object.defineProperty({}, 'keyDigest', {
    enumerable: true,
    get() { throw new Error('N15_STORED_SECRET'); },
  });
  Object.defineProperty(accessorStored, 'semanticHash', {
    enumerable: true,
    value: stored.semanticHash,
  });
  expectContractError(
    'COMMUNICATION_INTENT_HASH_INVALID',
    () => compareCommunicationIntentIdempotencyV1(accessorStored, SYNTHETIC_COMMUNICATION_INTENT_V1),
  );
  let statefulGetterCalls = 0;
  const statefulStored = Object.defineProperties({}, {
    keyDigest: {
      enumerable: true,
      get() {
        statefulGetterCalls += 1;
        return statefulGetterCalls % 2 === 0 ? stored.keyDigest : 'b'.repeat(64);
      },
    },
    semanticHash: {
      enumerable: true,
      get() {
        statefulGetterCalls += 1;
        return stored.semanticHash;
      },
    },
  });
  expectContractError(
    'COMMUNICATION_INTENT_HASH_INVALID',
    () => compareCommunicationIntentIdempotencyV1(statefulStored, SYNTHETIC_COMMUNICATION_INTENT_V1),
  );
  assert.equal(statefulGetterCalls, 0);
  const descriptorTrappedStored = new Proxy({}, {
    ownKeys() { return ['keyDigest', 'semanticHash']; },
    getOwnPropertyDescriptor() { throw new Error('N15_STORED_DESCRIPTOR_SECRET'); },
  });
  expectContractError(
    'COMMUNICATION_INTENT_HASH_INVALID',
    () => compareCommunicationIntentIdempotencyV1(
      descriptorTrappedStored,
      SYNTHETIC_COMMUNICATION_INTENT_V1,
    ),
  );
  const revokedStored = Proxy.revocable({}, {});
  revokedStored.revoke();
  expectContractError(
    'COMMUNICATION_INTENT_HASH_INVALID',
    () => compareCommunicationIntentIdempotencyV1(revokedStored.proxy, SYNTHETIC_COMMUNICATION_INTENT_V1),
  );
});

test('N15 parsing rejects discriminator, policy, lifecycle and hash tampering', () => {
  expectContractError('COMMUNICATION_INTENT_SCHEMA_UNSUPPORTED', () => parseCommunicationIntentV1({
    ...SYNTHETIC_COMMUNICATION_INTENT_V1, schemaVersion: 'fai.communication-intent.v2',
  }));
  expectContractError('COMMUNICATION_INTENT_TYPE_UNSUPPORTED', () => parseCommunicationIntentV1({
    ...SYNTHETIC_COMMUNICATION_INTENT_V1, intentType: 'COMMUNICATION_DISPATCH',
  }));
  expectContractError('COMMUNICATION_INTENT_VERSION_UNSUPPORTED', () => parseCommunicationIntentV1({
    ...SYNTHETIC_COMMUNICATION_INTENT_V1, intentVersion: 2,
  }));
  expectContractError('COMMUNICATION_INTENT_POLICY_INVALID', () => parseCommunicationIntentV1({
    ...SYNTHETIC_COMMUNICATION_INTENT_V1,
    policySnapshot: { ...SYNTHETIC_COMMUNICATION_INTENT_V1.policySnapshot, decision: 'ALLOWED' },
  }));
  expectContractError('COMMUNICATION_INTENT_STATE_TRANSITION_INVALID', () => parseCommunicationIntentV1({
    ...SYNTHETIC_COMMUNICATION_INTENT_V1, state: 'HELD',
  }));
  for (const field of ['keyDigest', 'semanticHash', 'envelopeHash'] as const) {
    expectContractError('COMMUNICATION_INTENT_HASH_INVALID', () => parseCommunicationIntentV1({
      ...SYNTHETIC_COMMUNICATION_INTENT_V1,
      idempotency: { ...SYNTHETIC_COMMUNICATION_INTENT_V1.idempotency, [field]: 'b'.repeat(64) },
    }));
  }
  expectContractError('COMMUNICATION_INTENT_FIELD_INVALID', () => createCommunicationIntentV1(inputWith({
    occurredAt: '2026-02-30T05:00:00.000Z',
  })));
  for (const occurredAt of [
    '0000-01-01T00:00:00+01:00',
    '9999-12-31T23:59:59-01:00',
  ]) {
    expectContractError('COMMUNICATION_INTENT_FIELD_INVALID', () => createCommunicationIntentV1(inputWith({
      occurredAt,
    })));
  }
  const upperBoundary = createCommunicationIntentV1(inputWith({
    occurredAt: '9999-12-31T22:59:59-01:00',
  }));
  assert.equal(upperBoundary.occurredAt, '9999-12-31T23:59:59.000Z');
  assert.deepEqual(parseCommunicationIntentV1(jsonClone(upperBoundary)), upperBoundary);
});

test('N15 hierarchical all-of gates fail closed and Phase 1A remains HELD for all vectors', () => {
  const disabled = createDisabledCommunicationGateSnapshotV1();
  assert.equal(disabled.allOfSatisfied, false);
  assert.equal(disabled.decision, 'HELD');
  assert.equal(disabled.reasonCode, 'N15_GATE_DISABLED');
  assert.deepEqual(Object.values(disabled.gates), Array(COMMUNICATION_GATE_CODES.length).fill('DISABLED'));
  assertDeepFrozen(disabled);
  assert.deepEqual(parseCommunicationGateSnapshotV1(jsonClone(disabled)), disabled);

  const combinations = 2 ** COMMUNICATION_GATE_CODES.length;
  for (let mask = 0; mask < combinations; mask += 1) {
    const gates = Object.fromEntries(COMMUNICATION_GATE_CODES.map((code, index) => [
      code,
      (mask & (1 << index)) === 0 ? 'DISABLED' : 'ENABLED',
    ]));
    const result = evaluateCommunicationGatesV1(gates);
    assert.equal(result.allOfSatisfied, mask === combinations - 1, String(mask));
    assert.equal(result.decision, 'HELD', String(mask));
    assert.equal(
      result.reasonCode,
      mask === combinations - 1 ? 'N15_PHASE1A_DORMANT' : 'N15_GATE_DISABLED',
      String(mask),
    );
  }

  for (const observation of [undefined, null, {}, true, 'true', 1, []]) {
    const result = evaluateCommunicationGatesV1(observation);
    assert.equal(result.decision, 'HELD');
    assert.equal(result.allOfSatisfied, false);
  }
  assert.equal(evaluateCommunicationGatesV1({ EXTRA: 'ENABLED' }).reasonCode, 'N15_GATE_ERROR');
  assert.equal(evaluateCommunicationGatesV1({ CAPABILITY: true }).reasonCode, 'N15_GATE_ERROR');
  assert.equal(evaluateCommunicationGatesV1(Object.create({ CAPABILITY: 'ENABLED' })).reasonCode, 'N15_GATE_ERROR');
  const accessor: Record<string, unknown> = {};
  Object.defineProperty(accessor, 'CAPABILITY', {
    enumerable: true,
    get() { throw new Error('synthetic gate error'); },
  });
  assert.equal(evaluateCommunicationGatesV1(accessor).reasonCode, 'N15_GATE_ERROR');
  const symbolBearing = { [Symbol('gate')]: 'ENABLED' };
  assert.equal(evaluateCommunicationGatesV1(symbolBearing).reasonCode, 'N15_GATE_ERROR');
  const trapped = new Proxy({}, { ownKeys() { throw new Error('synthetic gate error'); } });
  assert.equal(evaluateCommunicationGatesV1(trapped).reasonCode, 'N15_GATE_ERROR');
  const descriptorTrapped = new Proxy({}, {
    ownKeys() { return [...COMMUNICATION_GATE_CODES]; },
    getOwnPropertyDescriptor() { throw new Error('N15_PROXY_SECRET'); },
  });
  const descriptorTrapResult = evaluateCommunicationGatesV1(descriptorTrapped);
  assert.equal(descriptorTrapResult.decision, 'HELD');
  assert.equal(descriptorTrapResult.reasonCode, 'N15_GATE_ERROR');
  const revokedGates = Proxy.revocable({}, {});
  revokedGates.revoke();
  assert.equal(evaluateCommunicationGatesV1(revokedGates.proxy).reasonCode, 'N15_GATE_ERROR');
  const contradictoryProxy = new Proxy({}, {
    ownKeys() { return []; },
    getOwnPropertyDescriptor() {
      return { configurable: true, enumerable: true, writable: true, value: 'ENABLED' };
    },
  });
  const contradictoryResult = evaluateCommunicationGatesV1(contradictoryProxy);
  assert.equal(contradictoryResult.allOfSatisfied, false);
  assert.equal(contradictoryResult.reasonCode, 'N15_GATE_MISSING');
});

test('N15 allows only RECORDED to HELD and binds a tamper-evident held decision', () => {
  assert.equal(isCommunicationIntentStateTransitionAllowedV1('RECORDED', 'HELD'), true);
  for (const transition of [
    ['RECORDED', 'RECORDED'], ['HELD', 'HELD'], ['HELD', 'RECORDED'], ['RECORDED', 'READY'],
  ]) {
    assert.equal(isCommunicationIntentStateTransitionAllowedV1(transition[0], transition[1]), false);
  }
  const held = createCommunicationHeldDecisionV1(
    SYNTHETIC_COMMUNICATION_INTENT_V1,
    createDisabledCommunicationGateSnapshotV1(),
    SYNTHETIC_COMMUNICATION_EVALUATED_AT_V1,
  );
  assert.equal(held.fromState, 'RECORDED');
  assert.equal(held.toState, 'HELD');
  assert.equal(held.reasonCode, 'N15_GATE_DISABLED');
  assert.equal(held.intentSemanticHash, SYNTHETIC_COMMUNICATION_INTENT_V1.idempotency.semanticHash);
  assert.equal(held.intentEnvelopeHash, SYNTHETIC_COMMUNICATION_INTENT_V1.idempotency.envelopeHash);
  assert.equal(held.decisionHash, '7c5a34cb5d210c318d57c21319c0e9c482ca5c2d0a63b5202847e12c9c50ae63');
  assert.deepEqual(parseCommunicationHeldDecisionV1(jsonClone(held)), held);
  assertDeepFrozen(held);
  const equalTimeHeld = createCommunicationHeldDecisionV1(
    SYNTHETIC_COMMUNICATION_INTENT_V1,
    createDisabledCommunicationGateSnapshotV1(),
    SYNTHETIC_COMMUNICATION_INTENT_V1.occurredAt,
  );
  assert.equal(equalTimeHeld.evaluatedAt, SYNTHETIC_COMMUNICATION_INTENT_V1.occurredAt);
  expectContractError('COMMUNICATION_INTENT_STATE_TRANSITION_INVALID', () => createCommunicationHeldDecisionV1(
    SYNTHETIC_COMMUNICATION_INTENT_V1,
    createDisabledCommunicationGateSnapshotV1(),
    '2026-08-26T04:59:59.999Z',
  ));
  expectContractError('COMMUNICATION_INTENT_HASH_INVALID', () => parseCommunicationHeldDecisionV1({
    ...held, decisionHash: 'b'.repeat(64),
  }));
  expectContractError('COMMUNICATION_INTENT_HASH_INVALID', () => parseCommunicationHeldDecisionV1({
    ...held, intentSemanticHash: 'b'.repeat(64),
  }));
});

test('N15 audit projection is an exact minimized record of references, hashes and reason codes', () => {
  const held = createCommunicationHeldDecisionV1(
    SYNTHETIC_COMMUNICATION_INTENT_V1,
    createDisabledCommunicationGateSnapshotV1(),
    SYNTHETIC_COMMUNICATION_EVALUATED_AT_V1,
  );
  const audit = createCommunicationAuditRecordV1(SYNTHETIC_COMMUNICATION_INTENT_V1, held);
  assert.deepEqual(Object.keys(audit).sort(), [
    'schemaVersion', 'recordType', 'recordVersion', 'intentReferenceHash',
    'correlationReferenceHash', 'sourceReferenceHash', 'recipientReferenceHash',
    'templateReferenceHash', 'communicationClassCode', 'intentReasonReferenceHash',
    'policyReferenceCode', 'policyReasonCode', 'gateSnapshotHash', 'gateReasonCode',
    'fromState', 'toState', 'idempotencyKeyHash', 'semanticHash', 'envelopeHash',
    'decisionHash',
  ].sort());
  assert.equal(audit.intentReferenceHash, '586cce43168f1fd6ed988e8acce20bff1608a8c58a8e2a14e17c6a36f8e14932');
  assert.equal(audit.recipientReferenceHash, 'f20a2f257547afbc9cfcc2e1a39ac62abcf419bd52c888642717461e6d390cc7');
  assert.equal(audit.gateSnapshotHash, 'c42f4c57e3b5369503be489e16fa3e00988c56569ea6ecde53bec7abe30ee042');
  assert.deepEqual(redactAuditPayload(audit), audit);
  assertDeepFrozen(audit);

  const serialized = canonicalJson(audit);
  for (const prohibited of [
    SYNTHETIC_COMMUNICATION_INTENT_INPUT_V1.intentId,
    SYNTHETIC_COMMUNICATION_INTENT_INPUT_V1.businessCorrelationId,
    SYNTHETIC_COMMUNICATION_INTENT_INPUT_V1.source.callerIdempotencyKey,
    SYNTHETIC_COMMUNICATION_INTENT_INPUT_V1.recipient.entityId,
    'email', 'phone', 'address', 'endpoint', 'body', 'secret',
  ]) {
    assert.equal(serialized.toLowerCase().includes(prohibited.toLowerCase()), false, prohibited);
  }
  const encodedContact = 'PHONE_393331234567';
  const encodedContactIntent = createCommunicationIntentV1(inputWith({
    message: {
      ...SYNTHETIC_COMMUNICATION_INTENT_INPUT_V1.message,
      reasonCode: encodedContact,
    },
  }));
  const encodedContactHeld = createCommunicationHeldDecisionV1(
    encodedContactIntent,
    createDisabledCommunicationGateSnapshotV1(),
    SYNTHETIC_COMMUNICATION_EVALUATED_AT_V1,
  );
  const encodedContactAudit = createCommunicationAuditRecordV1(
    encodedContactIntent,
    encodedContactHeld,
  );
  assert.equal(canonicalJson(encodedContactAudit).includes(encodedContact), false);
  assert.match(encodedContactAudit.intentReasonReferenceHash, /^[0-9a-f]{64}$/u);

  const otherIntent = createCommunicationIntentV1(inputWith({
    intentId: '9f4f22df-b0c1-4bcc-9dc1-556677889900',
  }));
  const otherHeld = createCommunicationHeldDecisionV1(
    otherIntent,
    createDisabledCommunicationGateSnapshotV1(),
    SYNTHETIC_COMMUNICATION_EVALUATED_AT_V1,
  );
  expectContractError('COMMUNICATION_INTENT_AUDIT_INVALID', () => createCommunicationAuditRecordV1(
    SYNTHETIC_COMMUNICATION_INTENT_V1,
    otherHeld,
  ));
  const divergentIntentWithSameIds = createCommunicationIntentV1(inputWith({
    message: {
      ...SYNTHETIC_COMMUNICATION_INTENT_INPUT_V1.message,
      reasonCode: 'DOCUMENT_ACTION_REQUIRED',
    },
  }));
  const divergentHeldWithSameIds = createCommunicationHeldDecisionV1(
    divergentIntentWithSameIds,
    createDisabledCommunicationGateSnapshotV1(),
    SYNTHETIC_COMMUNICATION_EVALUATED_AT_V1,
  );
  assert.equal(divergentHeldWithSameIds.intentId, SYNTHETIC_COMMUNICATION_INTENT_V1.intentId);
  assert.notEqual(
    divergentHeldWithSameIds.intentSemanticHash,
    SYNTHETIC_COMMUNICATION_INTENT_V1.idempotency.semanticHash,
  );
  expectContractError('COMMUNICATION_INTENT_AUDIT_INVALID', () => createCommunicationAuditRecordV1(
    SYNTHETIC_COMMUNICATION_INTENT_V1,
    divergentHeldWithSameIds,
  ));
});

test('N15 deterministic mock is test-only, always HELD and has no side effects', () => {
  const first = executeDeterministicCommunicationMockV1(
    SYNTHETIC_COMMUNICATION_INTENT_V1,
    SYNTHETIC_COMMUNICATION_EVALUATED_AT_V1,
  );
  const serialized = canonicalJson(first);
  for (let index = 0; index < 100; index += 1) {
    assert.equal(canonicalJson(executeDeterministicCommunicationMockV1(
      SYNTHETIC_COMMUNICATION_INTENT_V1,
      SYNTHETIC_COMMUNICATION_EVALUATED_AT_V1,
    )), serialized);
  }
  assert.equal(first.outcome, 'HELD');
  assert.equal(first.dispatch, 'NOT_ATTEMPTED');
  assert.deepEqual(first.sideEffects, {
    persistence: false,
    network: false,
    dispatch: false,
    egress: false,
    delivery: false,
  });
  assert.equal(first.resultHash, '73aa4301bafaf765636f7e1757080364547d035949e43c8b842ea4de13ef087f');
  assert.equal('provider' in first, false);
  assertDeepFrozen(first);

  const enabled = Object.fromEntries(COMMUNICATION_GATE_CODES.map((code) => [code, 'ENABLED']));
  const heldWithAllEnabled = createCommunicationHeldDecisionV1(
    SYNTHETIC_COMMUNICATION_INTENT_V1,
    evaluateCommunicationGatesV1(enabled),
    SYNTHETIC_COMMUNICATION_EVALUATED_AT_V1,
  );
  assert.equal(heldWithAllEnabled.gateSnapshot.allOfSatisfied, true);
  assert.equal(heldWithAllEnabled.toState, 'HELD');
  assert.equal(heldWithAllEnabled.reasonCode, 'N15_PHASE1A_DORMANT');
});

test('N04 classifies every N15 contract field exactly and denies additions', () => {
  const intentFields = [
    'schemaVersion', 'intentType', 'intentVersion', 'intentId', 'businessCorrelationId',
    'occurredAt', 'source.producerCode', 'recipient.authorityCode', 'recipient.entityType',
    'recipient.entityId', 'message.messageClass', 'message.reasonCode',
    'message.templateReference.templateCode', 'message.templateReference.templateVersion',
    'message.templateReference.templateHash', 'policySnapshot.policyReferenceCode',
    'policySnapshot.policyVersion', 'policySnapshot.decision', 'policySnapshot.reasonCode',
    'state', 'idempotency.canonicalizationVersion', 'idempotency.keyDigest',
    'idempotency.semanticHash', 'idempotency.envelopeHash',
  ];
  const heldFields = [
    'schemaVersion', 'decisionType', 'decisionVersion', 'intentId', 'businessCorrelationId',
    'intentSemanticHash', 'intentEnvelopeHash', 'evaluatedAt', 'fromState', 'toState',
    'policySnapshot.policyReferenceCode',
    'policySnapshot.policyVersion', 'policySnapshot.decision', 'policySnapshot.reasonCode',
    'gateSnapshot.schemaVersion', 'gateSnapshot.snapshotVersion',
    'gateSnapshot.evaluationModel', ...COMMUNICATION_GATE_CODES.map(
      (code) => `gateSnapshot.gates.${code}`,
    ), 'gateSnapshot.allOfSatisfied', 'gateSnapshot.decision', 'gateSnapshot.reasonCode',
    'reasonCode', 'decisionHash',
  ];
  const auditFields = [
    'schemaVersion', 'recordType', 'recordVersion', 'intentReferenceHash',
    'correlationReferenceHash', 'sourceReferenceHash', 'recipientReferenceHash',
    'templateReferenceHash', 'communicationClassCode', 'intentReasonReferenceHash',
    'policyReferenceCode', 'policyReasonCode', 'gateSnapshotHash', 'gateReasonCode',
    'fromState', 'toState', 'idempotencyKeyHash', 'semanticHash', 'envelopeHash',
    'decisionHash',
  ];
  assert.deepEqual(Object.keys(dataClassificationCatalog.communication_intent_v1).sort(), intentFields.sort());
  assert.deepEqual(Object.keys(dataClassificationCatalog.communication_held_decision_v1).sort(), heldFields.sort());
  assert.deepEqual(Object.keys(dataClassificationCatalog.communication_audit_record_v1).sort(), auditFields.sort());
  for (const contract of [
    dataClassificationCatalog.communication_intent_v1,
    dataClassificationCatalog.communication_held_decision_v1,
    dataClassificationCatalog.communication_audit_record_v1,
  ]) {
    for (const fieldRule of Object.values(contract)) {
      assert.equal(fieldRule.purposeCode, 'N15_PHASE1A_UNASSIGNED');
      assert.equal(fieldRule.legalBasisCode, 'DPO_VALIDATION_REQUIRED');
      assert.notEqual(fieldRule.legalBasisCode, 'CONSENT');
      assert.notEqual(fieldRule.legalBasisCode, 'PRE_CONTRACTUAL_MEASURES');
      assert.notEqual(fieldRule.legalBasisCode, 'LEGITIMATE_INTEREST');
    }
  }
  assert.doesNotThrow(() => assertClassifiedFields(
    'communication_intent_v1',
    SYNTHETIC_COMMUNICATION_INTENT_V1,
  ));
  assert.throws(
    () => assertClassifiedFields('communication_intent_v1', {
      ...SYNTHETIC_COMMUNICATION_INTENT_V1,
      recipient: { ...SYNTHETIC_COMMUNICATION_INTENT_V1.recipient, email: 'n15@example.invalid' },
    }),
    (error: unknown) => error instanceof UnclassifiedDataFieldError
      && error.fieldPath === 'recipient.email',
  );
});

test('N15 dependency closure has zero I/O and no runtime call-site, persistence or migration', () => {
  const contractPath = 'src/lib/communication-backbone-contract.ts';
  const contractSource = readFileSync(contractPath, 'utf8');
  const imports = [...contractSource.matchAll(/from\s+'([^']+)'/gu)].map((match) => match[1]).sort();
  assert.deepEqual(imports, ['./canonical-json', './data-classification']);
  for (const pattern of [
    /@prisma|PrismaClient|DATABASE_URL|business-event-backbone|Business(?:InboxEvent|OutboxEvent|QueueAttempt)/u,
    /\bprocess\s*(?:\.\s*env|\[\s*['"]env['"]\s*\])|\bimport\.meta\.env\b/u,
    /\bfetch\s*\(|\bnew\s+(?:WebSocket|EventSource|XMLHttpRequest)\b/u,
    /from\s+['"](?:node:)?(?:fs|https?|http2|net|tls|dns|dgram|child_process|worker_threads)/u,
    /\b(?:Date\.now|Math\.random|performance\.now|randomUUID|randomBytes|randomInt)\s*\(/u,
    /\bnew\s+Date\s*\(\s*\)/u,
    /\b(?:setTimeout|setInterval|console\.)/u,
    /\b(?:async|Promise)\b/u,
    /https?:\/\/|wss?:\/\//u,
  ]) {
    assert.doesNotMatch(contractSource, pattern);
  }
  assert.doesNotMatch(readFileSync('src/lib/canonical-json.ts', 'utf8'), /node:(?:fs|https?|net|tls|dns)/u);
  assert.doesNotMatch(readFileSync('src/lib/data-classification.ts', 'utf8'), /^import\s/mu);

  const runtimeFiles = [
    ...sourceFilesUnder('src').filter((path) => path !== contractPath),
    ...sourceFilesUnder('prisma'),
    ...sourceFilesUnder('scripts'),
    ...sourceFilesUnder('deploy'),
  ].filter(existsSync);
  for (const path of runtimeFiles) {
    assert.doesNotMatch(readFileSync(path, 'utf8'), /communication-backbone-contract/u, path);
  }
  assert.equal(existsSync('src/lib/communication-backbone-mock.ts'), false);
  assert.match(readFileSync('tests/fixtures/n15-communication-mock.ts', 'utf8'), /outcome: 'HELD'/u);
  assert.doesNotMatch(readFileSync('Dockerfile.prod.example', 'utf8'), /COPY[^\n]*\/app\/tests/u);
  const migrations = readdirSync('prisma/migrations').filter((name) => /^\d/u.test(name));
  assert.equal(migrations.length, 43);
  const prismaFiles = [
    'prisma/schema.prisma',
    ...sourceFilesUnder('prisma'),
    ...migrations
      .map((migration) => `prisma/migrations/${migration}/migration.sql`)
      .filter(existsSync),
  ];
  for (const path of prismaFiles) {
    assert.doesNotMatch(
      readFileSync(path, 'utf8'),
      /fai\.communication-intent\.v1|COMMUNICATION_INTENT|Communication(?:Intent|Held|Audit)/u,
      path,
    );
  }
});

test('N15 gate code list is closed and never inferred from arbitrary caller keys', () => {
  assert.deepEqual(COMMUNICATION_GATE_CODES, [
    'CAPABILITY', 'WORKER', 'DISPATCH', 'EGRESS', 'CHANNEL', 'PROVIDER', 'TENANT',
  ] satisfies CommunicationGateCode[]);
  const observations = Object.fromEntries(COMMUNICATION_GATE_CODES.map((code) => [code, 'DISABLED']));
  assert.equal(evaluateCommunicationGatesV1({ ...observations, APPLICABLE: 'ENABLED' }).reasonCode, 'N15_GATE_ERROR');
});
