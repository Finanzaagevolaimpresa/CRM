import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { PrismaClient } from '@prisma/client';
import type { AuthSession } from '../../src/lib/auth';
import { companySchema, projectSchema } from '../../src/lib/validation';
import { redactAuditPayload } from '../../src/lib/data-classification';
import { withProjectResources } from '../../src/lib/project-resource-guard';
import { lockLeadWriteActor, assertLeadActorLive } from '../../src/lib/lead-lifecycle-lock';
import { requireClientContextWriteAccess } from '../../src/lib/write-access';

export const clientWriteActions = ['createCompany', 'createProject'] as const;
export type ClientWriteAction = typeof clientWriteActions[number];
const text = readFileSync('src/lib/actions.ts', 'utf8');
const source = ts.createSourceFile('actions.ts', text, ts.ScriptTarget.Latest, true);
const bodies = ['clean', 'audit', ...clientWriteActions].map(name => {
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, 'Public action absent: ' + name);
  return declaration.getText(source);
}).join('\n');
const javascript = ts.transpileModule(bodies, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText;

// Unchanged actual action bodies. Only the cookie boundary and transaction
// scheduling are injectable; parsing, access, locks, writes and audit use PostgreSQL.
export function actualClientWriteActions(db: PrismaClient, session: AuthSession, schedule: typeof withProjectResources = withProjectResources) {
  const dependencies = {
    prisma: db, requirePermission: async () => session, companySchema, projectSchema, redactAuditPayload,
    withProjectResources: schedule, lockLeadWriteActor, assertLeadActorLive,
    requireClientContextWriteAccess: (actor: AuthSession, target: Parameters<typeof requireClientContextWriteAccess>[1], tx = db) =>
      requireClientContextWriteAccess(actor, target, tx),
  };
  const result: Record<string, unknown> = {};
  new Function('exports', ...Object.keys(dependencies), javascript)(result, ...Object.values(dependencies));
  return result as Record<ClientWriteAction, (form: FormData) => Promise<unknown>>;
}
