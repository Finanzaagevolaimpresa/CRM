import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
const root = process.cwd();
const migration = readFileSync(resolve(root, 'prisma/migrations/20260803100000_ai_manual_authorization_corrective_lifecycle_exact_input_hash_v1/migration.sql'), 'utf8');
const schema = readFileSync(resolve(root, 'prisma/schema.prisma'), 'utf8');
const canonical = readFileSync(resolve(root, 'src/lib/canonical-json.ts'), 'utf8');
const service = readFileSync(resolve(root, 'src/lib/ai-execution-authorization.ts'), 'utf8');
const actions = readFileSync(resolve(root, 'src/lib/actions.ts'), 'utf8');
const formActions = readFileSync(resolve(root, 'src/lib/form-actions.ts'), 'utf8');
const authorizationDetail = readFileSync(resolve(root, 'src/app/settings/ai-authorizations/[id]/page.tsx'), 'utf8');
const diagnosticPage = readFileSync(resolve(root, 'src/app/settings/ai-diagnostics/page.tsx'), 'utf8');
const quickRunPage = readFileSync(resolve(root, 'src/app/ai/page.tsx'), 'utf8');
const clientPage = readFileSync(resolve(root, 'src/app/clients/[id]/page.tsx'), 'utf8');

test('PR86 aggiunge una sola migration 31 additiva senza riscrivere i canonicalizzatori v1', () => {
  assert.equal(readdirSync(resolve(root, 'prisma/migrations')).length, 31);
  assert.match(migration, /^BEGIN;/m); assert.match(migration, /^COMMIT;/m);
  assert.doesNotMatch(migration, /\b(?:DROP TABLE|TRUNCATE|DELETE FROM|UPDATE "AiExecution(?:Request|Decision|AuthorizationGrant))\b/i);
  assert.match(canonical, /export function canonicalJson[\s\S]*return canonicalize\(value, '\$'\)/);
  assert.match(canonical, /export function canonicalSha256[\s\S]*return sha256\(canonicalJson\(value\)\)/);
  assert.match(canonical, /export function createAiRequestFingerprint[\s\S]*return canonicalSha256\(value\)/);
});

test('schema e trigger vincolano versione, supersession e terminalità', () => {
  assert.match(schema, /hashCanonicalizationVersion\s+Int\?/);
  assert.match(schema, /supersedesRequestId\s+String\?\s+@unique/);
  for (const evidence of ['NEEDS_INFORMATION is terminal', 'Replacement request continuity mismatch',
    'Replacement source cannot have a grant or run', 'AiRun hash canonicalization version is missing, unknown or mismatched',
    'assert_ai_execution_pr85_rollback_safe_v2']) assert.match(migration, new RegExp(evidence));
  assert.doesNotMatch(service, /'PENDING_ADMIN_APPROVAL', 'NEEDS_INFORMATION', 'APPROVED'/);
  assert.match(service, /createAiExecutionReplacementRequest/);
});

test('i tre flussi CRM instradano le sostitutive attraverso il helper dedicato', () => {
  assert.match(actions, /createAiExecutionReplacementRequest/);
  assert.match(actions, /runAiProviderDiagnosticTest[\s\S]*createAiExecutionReplacementRequest/);
  assert.match(actions, /runClientAiAgent[\s\S]*createAiExecutionReplacementRequest/);
  assert.match(actions, /runMockAgent[\s\S]*createAiExecutionReplacementRequest/);
  assert.match(formActions, /runMockAgent\([\s\S]*supersedesRequestId/);
  for (const page of [diagnosticPage, quickRunPage, clientPage]) {
    assert.match(page, /name="supersedesRequestId"/);
  }
  assert.match(authorizationDetail, /replacementHref/);
  assert.match(authorizationDetail, /Integra e crea richiesta sostitutiva/);
});

test('il rollback guard PR85 rifiuta ogni NEEDS_INFORMATION senza dipendere dalla scadenza', () => {
  const guardStart = migration.indexOf('CREATE FUNCTION "assert_ai_execution_pr85_rollback_safe_v2"');
  const guardEnd = migration.indexOf('DO $verify$', guardStart);
  const guard = migration.slice(guardStart, guardEnd);
  assert.match(guard, /"status" = 'NEEDS_INFORMATION'/);
  assert.doesNotMatch(guard, /"status" = 'NEEDS_INFORMATION'[\s\S]*"expiresAt"/);
  assert.match(guard, /any NEEDS_INFORMATION rows exist/);
});
