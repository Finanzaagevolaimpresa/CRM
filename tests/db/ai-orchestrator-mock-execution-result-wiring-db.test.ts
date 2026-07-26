import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');

test('PR83 keeps the PostgreSQL contract at 29 migrations and delegates atomic writes to PR77', () => {
  const migrations = readdirSync(resolve(root, 'prisma/migrations'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory());
  assert.equal(migrations.length, 29);
  const runtime = readFileSync(resolve(root, 'src/lib/ai-orchestrator/worker-runtime.ts'), 'utf8');
  const preflight = runtime.match(/export async function preflightAiWorkflowJobExecution\([\s\S]*?\n\}/)?.[0];
  assert.ok(preflight);
  assert.match(preflight, /SET TRANSACTION READ ONLY/);
  assert.doesNotMatch(preflight, /FOR UPDATE|\.create\(|\.update|\.delete/);
  const completion = runtime.match(/export async function completeAiWorkflowJob\([\s\S]*?\n\}/)?.[0];
  assert.ok(completion);
  assert.match(completion, /TransactionIsolationLevel\.Serializable/);
  assert.match(completion, /aiWorkflowJobResult\.create/);
  assert.match(completion, /aiWorkflowJobArtifact\.create/);
});
