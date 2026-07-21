import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { visibleNavItemsForTest } from '../src/components/nav-links';
import {
  AI_ORCHESTRATOR_ADMIN_CONTROL_TARGETS,
  AI_ORCHESTRATOR_ADMIN_GENESIS_GLOBAL_POLICY,
  createAiOrchestratorAdminPolicyHash,
  getAiOrchestratorAdminControlTarget,
  type AiOrchestratorAdminGlobalPolicy,
} from '../src/lib/ai-orchestrator/admin-control-policy-v1';
import type { AiOrchestratorAdminRevisionSnapshot } from '../src/lib/ai-orchestrator/admin-control-plane-v1';
import {
  AI_ORCHESTRATOR_ADMIN_EMERGENCY_CONFIRMATION_PHRASE,
  AI_ORCHESTRATOR_ADMIN_POLICY_CONFIRMATION_PHRASE,
  AI_ORCHESTRATOR_ADMIN_UI_RESULT_CODES,
  AI_ORCHESTRATOR_ADMIN_UI_RESULT_MESSAGES,
  buildAiOrchestratorAdminGlobalPolicyFromForm,
  buildAiOrchestratorAdminScopePolicyFromForm,
  getAiOrchestratorAdminUiPermissions,
  parseAiOrchestratorAdminEmergencyStopForm,
  parseAiOrchestratorAdminGlobalPolicyForm,
  parseAiOrchestratorAdminScopePolicyForm,
  parseAiOrchestratorAdminUiResultCode,
  projectAiOrchestratorAdminAuditRevision,
  projectAiOrchestratorAdminReadRevision,
  resolveAiOrchestratorAdminScopeSelection,
} from '../src/lib/ai-orchestrator/admin-ui-contract-v1';

const root = resolve(import.meta.dirname, '..');
const requestId = '018f47a0-7b2c-4d1e-8a90-1234567890ab';
const hash = 'a'.repeat(64);
const reason = 'Manutenzione programmata verificata nel perimetro interno.';

function asFormData(entries: readonly (readonly [string, string])[]) {
  const formData = new FormData();
  for (const [key, value] of entries) formData.append(key, value);
  return formData;
}

const globalFormEntries = Object.freeze([
  ['requestId', requestId],
  ['expectedVersion', '1'],
  ['expectedRevisionHash', hash],
  ['reasonCode', 'MAINTENANCE'],
  ['reason', reason],
  ['confirmationPhrase', AI_ORCHESTRATOR_ADMIN_POLICY_CONFIRMATION_PHRASE],
  ['confirmationChecked', 'confirmed'],
  ['desiredMode', 'STOPPED'],
  ['desiredStateMachineEnabled', 'false'],
  ['emergencyStopEngaged', 'true'],
  ['globalKillSwitch', 'true'],
  ['maxConcurrentGlobal', '0'],
  ['maxConcurrentPerWorkflow', '0'],
  ['maxConcurrentPerAgent', '0'],
  ['maxRetryableFailures', '0'],
  ['leaseDurationMs', '120000'],
  ['heartbeatIntervalMs', '30000'],
  ['maxAttemptDurationMs', '600000'],
  ['dailyJobLimit', '0'],
  ['operatingWindowEnabled', 'false'],
  ['operatingWindowStartUtc', ''],
  ['operatingWindowEndUtc', ''],
] as const);

function firstJobTarget() {
  const target = AI_ORCHESTRATOR_ADMIN_CONTROL_TARGETS.find(({ scopeType }) => scopeType === 'JOB');
  if (target && target.scopeType === 'JOB') return target;
  throw new Error('Target JOB canonico non disponibile per il test UI.');
}

function scopeFormEntries() {
  const target = firstJobTarget();
  return Object.freeze([
    ['requestId', requestId],
    ['expectedVersion', '1'],
    ['expectedRevisionHash', hash],
    ['reasonCode', 'MAINTENANCE'],
    ['reason', reason],
    ['confirmationPhrase', AI_ORCHESTRATOR_ADMIN_POLICY_CONFIRMATION_PHRASE],
    ['confirmationChecked', 'confirmed'],
    ['scopeType', target.scopeType],
    ['scopeCode', target.scopeCode],
    ['desiredEnabled', 'false'],
    ['killSwitch', 'true'],
  ] as const);
}

test('i form UI accettano soltanto il contratto allowlisted e rifiutano chiavi duplicate', () => {
  assert.equal(parseAiOrchestratorAdminGlobalPolicyForm(asFormData(globalFormEntries)).expectedVersion, 1);
  assert.equal(parseAiOrchestratorAdminScopePolicyForm(asFormData(scopeFormEntries())).desiredEnabled, false);
  assert.equal(parseAiOrchestratorAdminEmergencyStopForm(asFormData([
    ['requestId', requestId],
    ['reasonCode', 'EMERGENCY_STOP'],
    ['reason', 'Arresto immediato per anomalia tecnica interna confermata.'],
    ['confirmationPhrase', AI_ORCHESTRATOR_ADMIN_EMERGENCY_CONFIRMATION_PHRASE],
    ['confirmationChecked', 'confirmed'],
  ])).reasonCode, 'EMERGENCY_STOP');

  const withReactActionMetadata = asFormData(globalFormEntries);
  withReactActionMetadata.append('$ACTION_ID_server_reference', 'framework-owned');
  withReactActionMetadata.append('$ACTION_KEY', 'framework-owned');
  assert.equal(
    parseAiOrchestratorAdminGlobalPolicyForm(withReactActionMetadata).expectedVersion,
    1,
  );

  const duplicated = asFormData(globalFormEntries);
  duplicated.append('requestId', requestId);
  assert.throws(
    () => parseAiOrchestratorAdminGlobalPolicyForm(duplicated),
    /AI_ORCHESTRATOR_ADMIN_DUPLICATE_FORM_KEY/,
  );

  for (const forgedField of [
    'actorUserId',
    'actorRole',
    'permissionGranted',
    'operationCode',
    'confirmed',
    'policy',
    'schemaVersion',
    'policyVersion',
    'activationEpoch',
    'targetDefinitionHash',
    'desiredDispatchEnabled',
    'provider',
    'syntheticDataOnly',
  ]) {
    const forged = asFormData(globalFormEntries);
    forged.append(forgedField, 'forged');
    assert.throws(
      () => parseAiOrchestratorAdminGlobalPolicyForm(forged),
      `${forgedField} non deve essere accettato dal form globale`,
    );
  }
});

test('booleani, interi, orari e conferme non usano coercizioni permissive', () => {
  for (const unsafeBoolean of ['on', '1', 'FALSE', 'false ']) {
    const entries = globalFormEntries.map(([key, value]) => (
      key === 'desiredStateMachineEnabled' ? [key, unsafeBoolean] as const : [key, value] as const
    ));
    assert.throws(() => parseAiOrchestratorAdminGlobalPolicyForm(asFormData(entries)));
  }

  for (const unsafeInteger of ['', '-1', '01', '1e0', '1.0', ' 1']) {
    const entries = globalFormEntries.map(([key, value]) => (
      key === 'dailyJobLimit' ? [key, unsafeInteger] as const : [key, value] as const
    ));
    assert.throws(() => parseAiOrchestratorAdminGlobalPolicyForm(asFormData(entries)));
  }

  const windowWithoutTimes = globalFormEntries.map(([key, value]) => (
    key === 'operatingWindowEnabled' ? [key, 'true'] as const : [key, value] as const
  ));
  assert.throws(() => parseAiOrchestratorAdminGlobalPolicyForm(asFormData(windowWithoutTimes)));

  const missingPhrase = globalFormEntries.filter(([key]) => key !== 'confirmationPhrase');
  const missingCheckbox = globalFormEntries.filter(([key]) => key !== 'confirmationChecked');
  assert.throws(() => parseAiOrchestratorAdminGlobalPolicyForm(asFormData(missingPhrase)));
  assert.throws(() => parseAiOrchestratorAdminGlobalPolicyForm(asFormData(missingCheckbox)));
});

test('i payload policy sono deterministici e ricostruiscono sempre i campi canonici server-side', () => {
  const parsedOne = parseAiOrchestratorAdminGlobalPolicyForm(asFormData(globalFormEntries));
  const parsedTwo = parseAiOrchestratorAdminGlobalPolicyForm(asFormData(globalFormEntries));
  const policyOne = buildAiOrchestratorAdminGlobalPolicyFromForm(parsedOne);
  const policyTwo = buildAiOrchestratorAdminGlobalPolicyFromForm(parsedTwo);

  assert.deepEqual(policyOne, policyTwo);
  assert.equal(createAiOrchestratorAdminPolicyHash(policyOne), createAiOrchestratorAdminPolicyHash(policyTwo));
  assert.equal(policyOne.foundationLocked, true);
  assert.equal(policyOne.desiredDispatchEnabled, false);
  assert.equal(policyOne.provider, 'mock');
  assert.equal(policyOne.syntheticDataOnly, true);
  assert.equal(policyOne.activationEpoch, AI_ORCHESTRATOR_ADMIN_GENESIS_GLOBAL_POLICY.activationEpoch);

  const scopeOne = buildAiOrchestratorAdminScopePolicyFromForm(
    parseAiOrchestratorAdminScopePolicyForm(asFormData(scopeFormEntries())),
  );
  const scopeTwo = buildAiOrchestratorAdminScopePolicyFromForm(
    parseAiOrchestratorAdminScopePolicyForm(asFormData(scopeFormEntries())),
  );
  const target = getAiOrchestratorAdminControlTarget(scopeOne.scopeType, scopeOne.scopeCode);
  assert.ok(target);
  assert.deepEqual(scopeOne, scopeTwo);
  assert.equal(scopeOne.targetDefinitionHash, target.targetDefinitionHash);
  assert.equal(createAiOrchestratorAdminPolicyHash(scopeOne), createAiOrchestratorAdminPolicyHash(scopeTwo));
});

test('la proiezione read elimina attore, motivazione, richiesta e prova RBAC; audit li espone separatamente', () => {
  const revision: AiOrchestratorAdminRevisionSnapshot = {
    id: 'revision-secret-marker',
    scopeType: 'GLOBAL',
    scopeCode: 'global',
    targetDefinitionHash: hash,
    version: 2,
    policy: AI_ORCHESTRATOR_ADMIN_GENESIS_GLOBAL_POLICY as AiOrchestratorAdminGlobalPolicy,
    policyHash: hash,
    previousRevisionHash: 'b'.repeat(64),
    revisionHash: 'c'.repeat(64),
    requestId,
    requestHash: 'd'.repeat(64),
    requestedPolicyHash: 'e'.repeat(64),
    expectedVersion: 1,
    expectedRevisionHash: 'f'.repeat(64),
    operationCode: 'SET_GLOBAL_POLICY',
    requiredPermissions: ['ai.orchestrator.configure'],
    permissionDecisions: [{ permission: 'ai.orchestrator.configure', allowed: true, source: 'ADMIN' }],
    actorUserId: 'actor-secret-marker',
    actorRole: 'admin',
    reasonCode: 'MAINTENANCE',
    reason: 'reason-secret-marker sufficientemente lungo per il ledger.',
    confirmed: true,
    createdAt: new Date('2026-07-21T12:00:00.000Z'),
  };

  const readView = projectAiOrchestratorAdminReadRevision(revision);
  const serializedRead = JSON.stringify(readView);
  for (const forbidden of [
    'revision-secret-marker',
    'actor-secret-marker',
    'reason-secret-marker',
    requestId,
    'permissionDecisions',
    'requiredPermissions',
    'previousRevisionHash',
    'requestHash',
  ]) assert.doesNotMatch(serializedRead, new RegExp(forbidden));

  const auditView = projectAiOrchestratorAdminAuditRevision(revision);
  assert.equal(auditView.actorUserId, 'actor-secret-marker');
  assert.match(auditView.reason, /reason-secret-marker/);
  assert.equal(auditView.reasonCode, 'MAINTENANCE');
  assert.equal(auditView.operationCode, 'SET_GLOBAL_POLICY');
  assert.doesNotMatch(JSON.stringify(auditView), /requestHash|permissionDecisions|requiredPermissions/);
});

test('codici e messaggi UI sono chiusi, minimizzati e non riflettono valori arbitrari', () => {
  assert.equal(new Set(AI_ORCHESTRATOR_ADMIN_UI_RESULT_CODES).size, AI_ORCHESTRATOR_ADMIN_UI_RESULT_CODES.length);
  assert.deepEqual(
    Object.keys(AI_ORCHESTRATOR_ADMIN_UI_RESULT_MESSAGES).sort(),
    [...AI_ORCHESTRATOR_ADMIN_UI_RESULT_CODES].sort(),
  );
  for (const code of AI_ORCHESTRATOR_ADMIN_UI_RESULT_CODES) {
    assert.equal(parseAiOrchestratorAdminUiResultCode(code), code);
    assert.ok(AI_ORCHESTRATOR_ADMIN_UI_RESULT_MESSAGES[code].length > 0);
  }
  for (const value of [null, undefined, '', 'UNKNOWN', reason, requestId, { code: 'UPDATED' }]) {
    assert.equal(parseAiOrchestratorAdminUiResultCode(value), null);
  }
});

test('la matrice UI e la navigazione applicano i permessi Orchestrator senza hard-code di ruolo', () => {
  assert.deepEqual(getAiOrchestratorAdminUiPermissions([]), {
    canRead: false,
    canAudit: false,
    canConfigure: false,
    canEmergencyStop: false,
    canEnable: false,
    canDisable: false,
    canManageLimits: false,
    canManageRetry: false,
    canManageAgents: false,
  });
  assert.deepEqual(getAiOrchestratorAdminUiPermissions([
    'ai.orchestrator.read',
    'ai.orchestrator.audit',
    'ai.orchestrator.configure',
    'ai.orchestrator.kill',
  ]), {
    canRead: true,
    canAudit: true,
    canConfigure: true,
    canEmergencyStop: true,
    canEnable: false,
    canDisable: false,
    canManageLimits: false,
    canManageRetry: false,
    canManageAgents: false,
  });

  const readOverride = visibleNavItemsForTest({
    role: 'collaboratore_limitato',
    effectivePermissions: ['ai.orchestrator.read'],
  });
  assert.ok(readOverride.includes('/settings/ai-orchestrator'));
  for (const permissions of [[], ['ai.orchestrator.audit'], ['ai.orchestrator.configure'], ['ai.orchestrator.kill']] as const) {
    assert.ok(!visibleNavItemsForTest({
      role: 'admin',
      effectivePermissions: [...permissions],
    }).includes('/settings/ai-orchestrator'));
  }
});

test('page, storico, moduli e azioni hanno guardie server-side indipendenti', () => {
  const page = readFileSync(resolve(root, 'src/app/settings/ai-orchestrator/page.tsx'), 'utf8');
  const dashboard = readFileSync(resolve(root, 'src/components/ai-orchestrator-admin-dashboard.tsx'), 'utf8');
  const actions = readFileSync(resolve(root, 'src/lib/ai-orchestrator/admin-ui-actions-v1.ts'), 'utf8');

  assert.match(page, /requirePermission\('ai\.orchestrator\.read'\)/);
  assert.match(page, /if \(permissions\.canAudit\)[\s\S]*listAiOrchestratorAdminPolicyRevisions/);
  assert.match(page, /mutationIntegritySafe = false/);
  assert.match(dashboard, /canMutate && props\.permissions\.canConfigure/);
  assert.match(dashboard, /canMutate && props\.permissions\.canEmergencyStop/);
  assert.match(dashboard, /props\.permissions\.canAudit \?/);

  assert.match(actions, /requirePermission\('ai\.orchestrator\.read'\)/);
  assert.match(actions, /hasPermission\(session, 'ai\.orchestrator\.configure'\)/);
  assert.match(actions, /hasPermission\(session, 'ai\.orchestrator\.kill'\)/);
  assert.doesNotMatch(actions, /session\.role\s*===|role\s*===\s*['"]admin['"]/);
});

test('le action fissano attore, operation e conferma lato server e non riflettono messaggi/input', () => {
  const actions = readFileSync(resolve(root, 'src/lib/ai-orchestrator/admin-ui-actions-v1.ts'), 'utf8');

  for (const operationCode of ['SET_GLOBAL_POLICY', 'SET_SCOPE_POLICY', 'EMERGENCY_STOP']) {
    assert.match(actions, new RegExp(`actorUserId: session\\.userId,[\\s\\S]*operationCode: '${operationCode}'`));
  }
  assert.equal((actions.match(/confirmed: true/g) ?? []).length, 3);
  assert.doesNotMatch(actions, /formData\.get\(['"]actor(?:UserId|Role)['"]\)/);
  assert.doesNotMatch(actions, /actorUserId:\s*(?:form|formData)/);
  assert.doesNotMatch(actions, /permissionGranted|permissionDecisions|actorRole/);
  assert.doesNotMatch(actions, /result\.message|error\.message|String\(error\)|console\.(?:log|error|warn)/);
  assert.doesNotMatch(actions, /query\.(?:set|append)\(['"](?:reason|actorUserId|requestId|message)['"]/);
  assert.doesNotMatch(actions, /Object\.fromEntries\(formData\)|\.\.\.form(?:Data)?\b/);
});

test('scope selection e query tampered falliscono chiuse sul catalogo canonico', () => {
  const target = firstJobTarget();
  assert.deepEqual(
    resolveAiOrchestratorAdminScopeSelection({ scopeType: target.scopeType, scopeCode: target.scopeCode }),
    target,
  );
  assert.equal(resolveAiOrchestratorAdminScopeSelection({ scopeType: ['JOB'], scopeCode: target.scopeCode }), null);
  assert.equal(resolveAiOrchestratorAdminScopeSelection({ scopeType: 'GLOBAL', scopeCode: 'global' }), null);
  assert.equal(resolveAiOrchestratorAdminScopeSelection({ scopeType: 'JOB', scopeCode: 'non-canonico' }), null);
  assert.equal(resolveAiOrchestratorAdminScopeSelection({ scopeType: 'AGENT', scopeCode: target.scopeCode }), null);
});

test('la superficie PR80 non importa runtime/esecuzione e non usa rete, timer o HTML non sicuro', () => {
  const paths = [
    'src/app/settings/ai-orchestrator/page.tsx',
    'src/components/ai-orchestrator-admin-dashboard.tsx',
    'src/lib/ai-orchestrator/admin-ui-actions-v1.ts',
    'src/lib/ai-orchestrator/admin-ui-contract-v1.ts',
  ];
  const source = paths.map((path) => readFileSync(resolve(root, path), 'utf8')).join('\n');

  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /\bset(?:Interval|Timeout)\s*\(/);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
  assert.doesNotMatch(source, /child_process|worker_threads/);
  assert.doesNotMatch(source, /from ['"].*(?:worker-runtime|workflow-service|mock-handler-registry|job-planner)['"]/);
  assert.doesNotMatch(source, /\bOpenAI\b|AI_API_KEY|external provider call/i);
});
