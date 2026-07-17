import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FAI_AUDIT_AUTOMATION_STOP_STATE,
  FAI_AUDIT_STATES,
  FAI_AUDIT_TRANSITION_CODES,
  FAI_AUDIT_TRANSITIONS,
  FAI_AUDIT_WORKFLOW_DEFINITION,
  FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
  FAI_AUDIT_WORKFLOW_ID,
  FAI_AUDIT_WORKFLOW_KEY,
  FAI_AUDIT_WORKFLOW_VERSION,
  assertAuditWorkflowDefinitionInvariants,
  createAuditWorkflowDefinitionHash,
  evaluateAuditWorkflowTransition,
  getAuditWorkflowDefinitionInvariantReport,
  type AuditWorkflowTransitionRequest,
  type FaiAuditTransitionDefinition,
} from '../src/lib/ai-orchestrator/audit-workflow-v1-1';

function validRequestFor(
  transition: FaiAuditTransitionDefinition,
  overrides: Partial<AuditWorkflowTransitionRequest> = {},
): AuditWorkflowTransitionRequest {
  const executionMode = transition.actorKind === 'HUMAN'
    ? 'INTERACTIVE'
    : transition.actorKind === 'AGENT'
      ? 'WORKER'
      : 'SYSTEM';

  return {
    workflowId: FAI_AUDIT_WORKFLOW_ID,
    workflowVersion: FAI_AUDIT_WORKFLOW_VERSION,
    definitionHash: FAI_AUDIT_WORKFLOW_DEFINITION_HASH,
    transitionCode: transition.transitionCode,
    currentState: transition.from,
    actor: {
      actorId: `${transition.actorKind.toLowerCase()}-1`,
      kind: transition.actorKind,
      executionMode,
    },
    gateResults: { [transition.gate]: 'PASS' },
    preconditions: Object.fromEntries(transition.preconditions.map((precondition) => [precondition, true])),
    grantedPermissions: transition.requiredPermission ? [transition.requiredPermission] : [],
    provider: transition.mockProviderRequired ? 'mock' : undefined,
    externalProvidersEnabled: false,
    correctionCycle: transition.transitionCode === 'WF-015' || transition.transitionCode === 'WF-019'
      ? 0
      : transition.transitionCode === 'WF-016'
        ? 1
        : undefined,
    manualReleaseConfirmed: transition.manualReleaseOnly ? true : undefined,
    reasonCode: transition.reasonCodeRequired ? 'TEST_REASON' : undefined,
    ...overrides,
  };
}

function transition(code: string) {
  const result = FAI_AUDIT_TRANSITIONS.find((candidate) => candidate.transitionCode === code);
  assert.ok(result, `Transizione ${code} non trovata`);
  return result;
}

test('la definizione canonica v1.1 contiene esattamente 16 stati e 23 transizioni coerenti', () => {
  assert.equal(FAI_AUDIT_WORKFLOW_KEY, 'FAI-AUDIT-WORKFLOW@1.1');
  assert.match(FAI_AUDIT_WORKFLOW_DEFINITION_HASH, /^[a-f0-9]{64}$/);
  assert.equal(FAI_AUDIT_WORKFLOW_DEFINITION_HASH, '6b31ebbe050314afe397ccf61b8fc6a2c1ca8620cb08cb9cdb37c42a62a5024c');
  assert.equal(FAI_AUDIT_WORKFLOW_DEFINITION_HASH, createAuditWorkflowDefinitionHash());
  assert.equal(FAI_AUDIT_WORKFLOW_DEFINITION.definitionHash, FAI_AUDIT_WORKFLOW_DEFINITION_HASH);
  assert.equal(FAI_AUDIT_WORKFLOW_DEFINITION.initialState, 'CREATED');
  assert.equal(FAI_AUDIT_AUTOMATION_STOP_STATE, 'HUMAN_APPROVAL');
  assert.equal(Object.isFrozen(FAI_AUDIT_STATES), true);
  assert.equal(Object.isFrozen(FAI_AUDIT_TRANSITION_CODES), true);
  assert.equal(Object.isFrozen(FAI_AUDIT_TRANSITIONS), true);
  assert.equal(FAI_AUDIT_STATES.length, 16);
  assert.equal(FAI_AUDIT_TRANSITION_CODES.length, 23);
  assert.equal(FAI_AUDIT_TRANSITIONS.length, 23);
  assert.deepEqual(
    FAI_AUDIT_TRANSITIONS.map(({ transitionCode }) => transitionCode),
    FAI_AUDIT_TRANSITION_CODES,
  );
  assert.doesNotThrow(() => assertAuditWorkflowDefinitionInvariants());

  const report = getAuditWorkflowDefinitionInvariantReport();
  assert.equal(report.valid, true, report.errors.join('; '));
  assert.equal(report.stateCount, 16);
  assert.equal(report.transitionCount, 23);
  assert.deepEqual(
    FAI_AUDIT_TRANSITIONS.map(({ transitionCode, event }) => `${transitionCode}:${event}`),
    [
      'WF-001:CASE_STARTED',
      'WF-002:PAYMENT_VERIFIED',
      'WF-003:AUTHORITY_VERIFIED',
      'WF-004:CHECKLIST_RESOLVED',
      'WF-005:DOCUMENT_INGESTED',
      'WF-006:DOCUMENT_CLASSIFIED',
      'WF-007:EVIDENCE_EXTRACTED',
      'WF-008:BLOCKING_CONFLICT_DETECTED',
      'WF-009:CLARIFICATION_RESOLVED',
      'WF-010:DATASET_READY',
      'WF-011:ANALYSIS_BUNDLE_COMPLETED',
      'WF-012:FINDINGS_DRAFTED',
      'WF-013:REPORT_DRAFTED',
      'WF-014:REVIEW_BUNDLE_COMPLETED',
      'WF-015:CORRECTION_OPENED',
      'WF-016:CORRECTION_COMPLETED',
      'WF-017:REVIEW_GATE_PASSED',
      'WF-018:REPORT_APPROVED',
      'WF-019:APPROVAL_CHANGES_REQUESTED',
      'WF-020:DELIVERABLE_RELEASED',
      'WF-021:VERSION_SUPERSEDED',
      'WF-022:CASE_CLOSED',
      'WF-023:DELETION_REQUESTED',
    ],
  );
});

test('workflow id, versione e definition hash sono obbligatori e verificati fail-closed', () => {
  const base = validRequestFor(transition('WF-001'));
  const cases = [
    [{ ...base, workflowId: undefined }, 'WORKFLOW_ID_MISMATCH'],
    [{ ...base, workflowId: 'OTHER-WORKFLOW' }, 'WORKFLOW_ID_MISMATCH'],
    [{ ...base, workflowVersion: undefined }, 'WORKFLOW_VERSION_MISMATCH'],
    [{ ...base, workflowVersion: '1.0' }, 'WORKFLOW_VERSION_MISMATCH'],
    [{ ...base, definitionHash: undefined }, 'DEFINITION_HASH_MISMATCH'],
    [{ ...base, definitionHash: '0'.repeat(64) }, 'DEFINITION_HASH_MISMATCH'],
  ] as const;

  for (const [request, expectedCode] of cases) {
    const result = evaluateAuditWorkflowTransition(request);
    assert.equal(result.allowed, false);
    if (!result.allowed) assert.equal(result.code, expectedCode);
  }
});

test('il motore canonico conserva tutte le 23 transizioni, incluse quelle oltre la porta foundation', async (t) => {
  for (const definition of FAI_AUDIT_TRANSITIONS) {
    await t.test(`${definition.transitionCode} ${definition.event}`, () => {
      const result = evaluateAuditWorkflowTransition(validRequestFor(definition));
      assert.equal(result.allowed, true, result.allowed ? undefined : `${result.code}: ${result.reason}`);
      if (!result.allowed) return;
      assert.equal(result.nextState, definition.to);
      assert.equal(result.effect, definition.from === definition.to ? 'STEP_COMPLETION' : 'STATE_CHANGE');
      assert.equal(result.stateChanged, definition.from !== definition.to);
    });
  }
});

test('WF-018..WF-023 restano valide solo come contratto canonico e non autorizzano dispatch', () => {
  const postFoundation = FAI_AUDIT_TRANSITIONS.slice(17);
  assert.deepEqual(
    postFoundation.map(({ transitionCode }) => transitionCode),
    ['WF-018', 'WF-019', 'WF-020', 'WF-021', 'WF-022', 'WF-023'],
  );
  for (const definition of postFoundation) {
    const result = evaluateAuditWorkflowTransition(validRequestFor(definition));
    assert.equal(result.allowed, true, definition.transitionCode);
    if (result.allowed) assert.equal(result.automaticDispatchAllowed, false, definition.transitionCode);
  }
});

test('ogni stato è raggiungibile da CREATED e gli stati terminali non hanno uscite', () => {
  const report = getAuditWorkflowDefinitionInvariantReport();
  assert.deepEqual(report.unreachableStates, []);
  assert.deepEqual(new Set(report.reachableStates), new Set(FAI_AUDIT_STATES));

  for (const terminalState of FAI_AUDIT_WORKFLOW_DEFINITION.terminalStates) {
    assert.equal(
      FAI_AUDIT_TRANSITIONS.some((candidate) => candidate.from === terminalState),
      false,
      `${terminalState} non deve avere transizioni in uscita`,
    );
  }
});

test('stato, transizione e stato sorgente sconosciuti o incoerenti sono negati fail-closed', () => {
  const wf001 = transition('WF-001');

  assert.deepEqual(
    evaluateAuditWorkflowTransition({ ...validRequestFor(wf001), currentState: 'UNKNOWN' }),
    {
      allowed: false,
      code: 'UNKNOWN_STATE',
      reason: 'Stato workflow non riconosciuto: UNKNOWN',
      transition: undefined,
      missingPrecondition: undefined,
    },
  );

  const unknownTransition = evaluateAuditWorkflowTransition({
    ...validRequestFor(wf001),
    transitionCode: 'WF-999',
  });
  assert.equal(unknownTransition.allowed, false);
  if (!unknownTransition.allowed) assert.equal(unknownTransition.code, 'UNKNOWN_TRANSITION');

  const mismatch = evaluateAuditWorkflowTransition({
    ...validRequestFor(transition('WF-002')),
    currentState: 'CREATED',
  });
  assert.equal(mismatch.allowed, false);
  if (!mismatch.allowed) assert.equal(mismatch.code, 'STATE_MISMATCH');
});

test('STATE_MISMATCH viene negato per ognuna delle 23 transizioni', () => {
  for (const definition of FAI_AUDIT_TRANSITIONS) {
    const wrongState = FAI_AUDIT_STATES.find((state) => state !== definition.from);
    assert.ok(wrongState);
    const result = evaluateAuditWorkflowTransition({
      ...validRequestFor(definition),
      currentState: wrongState,
    });
    assert.equal(result.allowed, false, definition.transitionCode);
    if (!result.allowed) assert.equal(result.code, 'STATE_MISMATCH', definition.transitionCode);
  }
});

test('attore assente, sconosciuto, errato o nel contesto errato viene negato', () => {
  const wf001 = transition('WF-001');
  const base = validRequestFor(wf001);

  const missing = evaluateAuditWorkflowTransition({ ...base, actor: null });
  assert.equal(missing.allowed, false);
  if (!missing.allowed) assert.equal(missing.code, 'ACTOR_REQUIRED');

  const unknown = evaluateAuditWorkflowTransition({
    ...base,
    actor: { actorId: 'actor-1', kind: 'ROBOT', executionMode: 'WORKER' },
  });
  assert.equal(unknown.allowed, false);
  if (!unknown.allowed) assert.equal(unknown.code, 'UNKNOWN_ACTOR_KIND');

  const wrong = evaluateAuditWorkflowTransition({
    ...base,
    actor: { actorId: 'agent-1', kind: 'AGENT', executionMode: 'WORKER' },
  });
  assert.equal(wrong.allowed, false);
  if (!wrong.allowed) assert.equal(wrong.code, 'ACTOR_NOT_ALLOWED');

  const wrongContext = evaluateAuditWorkflowTransition({
    ...base,
    actor: { actorId: 'human-1', kind: 'HUMAN', executionMode: 'SYSTEM' },
  });
  assert.equal(wrongContext.allowed, false);
  if (!wrongContext.allowed) assert.equal(wrongContext.code, 'ACTOR_CONTEXT_INVALID');
});

test('il mapping RBAC è versionato e ogni transizione umana fallisce senza il permesso richiesto', () => {
  assert.deepEqual(
    FAI_AUDIT_TRANSITIONS.map(({ transitionCode, requiredPermission }) => [transitionCode, requiredPermission]),
    [
      ['WF-001', 'ai.run'],
      ['WF-002', 'ai.run'],
      ['WF-003', 'ai.run'],
      ['WF-004', 'ai.run'],
      ['WF-005', null],
      ['WF-006', null],
      ['WF-007', null],
      ['WF-008', null],
      ['WF-009', 'ai.run'],
      ['WF-010', 'ai.run'],
      ['WF-011', null],
      ['WF-012', null],
      ['WF-013', null],
      ['WF-014', null],
      ['WF-015', null],
      ['WF-016', null],
      ['WF-017', 'ai.review'],
      ['WF-018', 'ai.approve'],
      ['WF-019', 'ai.approve'],
      ['WF-020', 'ai.approve'],
      ['WF-021', 'ai.approve'],
      ['WF-022', 'ai.approve'],
      ['WF-023', 'ai.approve'],
    ],
  );

  for (const definition of FAI_AUDIT_TRANSITIONS.filter(({ actorKind }) => actorKind === 'HUMAN')) {
    const result = evaluateAuditWorkflowTransition({
      ...validRequestFor(definition),
      grantedPermissions: [],
    });
    assert.equal(result.allowed, false, definition.transitionCode);
    if (!result.allowed) assert.equal(result.code, 'PERMISSION_NOT_GRANTED', definition.transitionCode);
  }
});

test('gate mancante, FAIL o con nome diverso viene negato esplicitamente', () => {
  const wf005 = transition('WF-005');
  const base = validRequestFor(wf005);

  for (const gateResults of [undefined, { [wf005.gate]: 'FAIL' }, { UNKNOWN_GATE: 'PASS' }]) {
    const result = evaluateAuditWorkflowTransition({ ...base, gateResults });
    assert.equal(result.allowed, false);
    if (!result.allowed) assert.equal(result.code, 'GATE_NOT_PASSED');
  }
});

test('ogni precondizione è obbligatoria ed è accettata solo con valore booleano true', () => {
  const wf017 = transition('WF-017');
  for (const required of wf017.preconditions) {
    const preconditions = { ...(validRequestFor(wf017).preconditions ?? {}), [required]: false };
    const result = evaluateAuditWorkflowTransition({ ...validRequestFor(wf017), preconditions });
    assert.equal(result.allowed, false);
    if (!result.allowed) {
      assert.equal(result.code, 'PRECONDITION_NOT_MET');
      assert.equal(result.missingPrecondition, required);
    }
  }
});

test('ogni transizione richiede provider esterni disabilitati e gli step agente sono mock-only', () => {
  const wf005 = transition('WF-005');
  const base = validRequestFor(wf005);

  const unknownStatus = evaluateAuditWorkflowTransition({ ...base, externalProvidersEnabled: undefined });
  assert.equal(unknownStatus.allowed, false);
  if (!unknownStatus.allowed) assert.equal(unknownStatus.code, 'EXTERNAL_PROVIDER_STATUS_UNKNOWN');

  const enabled = evaluateAuditWorkflowTransition({ ...base, externalProvidersEnabled: true });
  assert.equal(enabled.allowed, false);
  if (!enabled.allowed) assert.equal(enabled.code, 'EXTERNAL_PROVIDERS_ENABLED');

  for (const provider of [undefined, null, 'openai', 'MOCK']) {
    const result = evaluateAuditWorkflowTransition({ ...base, provider });
    assert.equal(result.allowed, false);
    if (!result.allowed) assert.equal(result.code, 'MOCK_PROVIDER_REQUIRED');
  }

  assert.equal(evaluateAuditWorkflowTransition(base).allowed, true);

  const humanTransition = transition('WF-001');
  for (const externalProvidersEnabled of [undefined, true]) {
    const result = evaluateAuditWorkflowTransition({
      ...validRequestFor(humanTransition),
      externalProvidersEnabled,
    });
    assert.equal(result.allowed, false);
    if (!result.allowed) {
      assert.equal(
        result.code,
        externalProvidersEnabled === undefined
          ? 'EXTERNAL_PROVIDER_STATUS_UNKNOWN'
          : 'EXTERNAL_PROVIDERS_ENABLED',
      );
    }
  }
});

test('il worker si arresta al gate HUMAN_APPROVAL e non può approvare o rilasciare', () => {
  const intoHumanApproval = evaluateAuditWorkflowTransition(validRequestFor(transition('WF-017')));
  assert.equal(intoHumanApproval.allowed, true);
  if (intoHumanApproval.allowed) {
    assert.equal(intoHumanApproval.nextState, 'HUMAN_APPROVAL');
    assert.equal(intoHumanApproval.workerDirective, 'STOP_AT_HUMAN_APPROVAL');
    assert.equal(intoHumanApproval.automaticDispatchAllowed, false);
  }

  const approvalFromWorker = evaluateAuditWorkflowTransition({
    ...validRequestFor(transition('WF-018')),
    actor: { actorId: 'system-1', kind: 'SYSTEM', executionMode: 'WORKER' },
  });
  assert.equal(approvalFromWorker.allowed, false);
  if (!approvalFromWorker.allowed) assert.equal(approvalFromWorker.code, 'WORKER_STOP_REQUIRED');

  const releaseFromWorker = evaluateAuditWorkflowTransition({
    ...validRequestFor(transition('WF-020')),
    actor: { actorId: 'agent-1', kind: 'AGENT', executionMode: 'WORKER' },
  });
  assert.equal(releaseFromWorker.allowed, false);
  if (!releaseFromWorker.allowed) assert.equal(releaseFromWorker.code, 'WORKER_STOP_REQUIRED');
});

test('nessun percorso composto solo da AGENT o SYSTEM può raggiungere APPROVED o RELEASED', () => {
  const protectedStates = new Set(['APPROVED', 'RELEASED']);
  const automaticTransitions = FAI_AUDIT_TRANSITIONS.filter(({ actorKind }) => actorKind !== 'HUMAN');

  for (const startingState of FAI_AUDIT_STATES.filter((state) => !protectedStates.has(state))) {
    const reached = new Set([startingState]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const definition of automaticTransitions) {
        if (reached.has(definition.from) && !reached.has(definition.to)) {
          reached.add(definition.to);
          changed = true;
        }
      }
    }
    assert.equal(reached.has('APPROVED'), false, `APPROVED raggiunto automaticamente da ${startingState}`);
    assert.equal(reached.has('RELEASED'), false, `RELEASED raggiunto automaticamente da ${startingState}`);
  }
});

test('RELEASED è raggiungibile una sola volta, solo da APPROVED e con conferma manuale', () => {
  const releaseTransitions = FAI_AUDIT_TRANSITIONS.filter((candidate) => candidate.to === 'RELEASED');
  assert.equal(releaseTransitions.length, 1);
  assert.equal(releaseTransitions[0]?.transitionCode, 'WF-020');
  assert.equal(releaseTransitions[0]?.from, 'APPROVED');
  assert.equal(releaseTransitions[0]?.actorKind, 'HUMAN');
  assert.equal(releaseTransitions[0]?.manualReleaseOnly, true);

  const withoutConfirmation = evaluateAuditWorkflowTransition({
    ...validRequestFor(transition('WF-020')),
    manualReleaseConfirmed: false,
  });
  assert.equal(withoutConfirmation.allowed, false);
  if (!withoutConfirmation.allowed) assert.equal(withoutConfirmation.code, 'MANUAL_RELEASE_REQUIRED');
});

test('il limite di due cicli di correzione vale sia dopo review sia dopo richiesta modifiche', () => {
  for (const code of ['WF-015', 'WF-019']) {
    const openCorrection = transition(code);
    for (const correctionCycle of [2, 3]) {
      const result = evaluateAuditWorkflowTransition({
        ...validRequestFor(openCorrection),
        correctionCycle,
      });
      assert.equal(result.allowed, false);
      if (!result.allowed) assert.equal(result.code, 'CORRECTION_LIMIT_REACHED');
    }
  }

  for (const correctionCycle of [undefined, -1, 0, 3, 1.5]) {
    const result = evaluateAuditWorkflowTransition({
      ...validRequestFor(transition('WF-016')),
      correctionCycle,
    });
    assert.equal(result.allowed, false);
    if (!result.allowed) assert.equal(result.code, 'CORRECTION_CYCLE_INVALID');
  }
});

test('le transizioni motivate falliscono senza un reason code stabile', () => {
  for (const code of ['WF-015', 'WF-019', 'WF-021', 'WF-023']) {
    const definition = transition(code);
    for (const reasonCode of [undefined, null, '', 'test libero', 'aa']) {
      const result = evaluateAuditWorkflowTransition({
        ...validRequestFor(definition),
        reasonCode,
      });
      assert.equal(result.allowed, false);
      if (!result.allowed) assert.equal(result.code, 'REASON_CODE_REQUIRED');
    }
    assert.equal(evaluateAuditWorkflowTransition(validRequestFor(definition)).allowed, true);
  }
});

test('le self-transition sono step completion e non falsi cambi di stato', () => {
  const selfTransitions = FAI_AUDIT_TRANSITIONS.filter((candidate) => candidate.from === candidate.to);
  assert.deepEqual(
    selfTransitions.map((candidate) => candidate.transitionCode),
    ['WF-005', 'WF-006', 'WF-007', 'WF-012', 'WF-014'],
  );

  for (const definition of selfTransitions) {
    const result = evaluateAuditWorkflowTransition(validRequestFor(definition));
    assert.equal(result.allowed, true);
    if (!result.allowed) continue;
    assert.equal(result.nextState, definition.from);
    assert.equal(result.effect, 'STEP_COMPLETION');
    assert.equal(result.stateChanged, false);
  }

  const actualStateChange = evaluateAuditWorkflowTransition(validRequestFor(transition('WF-004')));
  assert.equal(actualStateChange.allowed, true);
  if (actualStateChange.allowed) {
    assert.equal(actualStateChange.effect, 'STATE_CHANGE');
    assert.equal(actualStateChange.stateChanged, true);
  }
});

test('la foundation non emette mai una autorizzazione implicita al dispatch', () => {
  for (const definition of FAI_AUDIT_TRANSITIONS) {
    const result = evaluateAuditWorkflowTransition(validRequestFor(definition));
    assert.equal(result.allowed, true);
    if (result.allowed) assert.equal(result.automaticDispatchAllowed, false);
  }
});
