import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { PrismaClient } from '@prisma/client';
import type { AuthSession } from '../../src/lib/auth';
import { commercialOfferSchema, commercialOfferUpdateSchema, clientSchema } from '../../src/lib/validation';
import { redactAuditPayload } from '../../src/lib/data-classification';
import { withProjectResources } from '../../src/lib/project-resource-guard';
import { lockLeadActor, lockLeadWriteActor, assertLeadOperational, assertLeadActorLive } from '../../src/lib/lead-lifecycle-lock';
import { requireLeadEditAccess, requireCommercialOfferEditAccess, requireCommercialOfferTargetAccess } from '../../src/lib/write-access';

export const leadWriteActions = ['createCommercialOffer', 'updateCommercialOffer', 'createClient'] as const;
export type LeadWriteAction = typeof leadWriteActions[number];

// Execute the unchanged public action bodies (including parsing and audit).
// Only the Next cookie boundary and the transaction scheduling boundary are
// injectable. Every access helper, lock, query and write uses real PostgreSQL.
const sourceText = readFileSync('src/lib/actions.ts', 'utf8');
const source = ts.createSourceFile('actions.ts', sourceText, ts.ScriptTarget.Latest, true);
const bodies = ['clean', 'audit', ...leadWriteActions].map(name => {
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `Public action not found: ${name}`);
  return declaration.getText(source);
}).join('\n');
const javascript = ts.transpileModule(bodies, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

export function actualLeadWriteActions(db: PrismaClient, session: AuthSession, schedule: typeof withProjectResources = withProjectResources) {
  const dependencies = {
    prisma: db, requirePermission: async () => session,
    commercialOfferSchema, commercialOfferUpdateSchema, clientSchema, redactAuditPayload,
    withProjectResources: schedule, lockLeadActor, lockLeadWriteActor, assertLeadOperational, assertLeadActorLive,
    requireLeadEditAccess: (actor: AuthSession, id: string, tx = db) => requireLeadEditAccess(actor, id, tx),
    requireCommercialOfferEditAccess: (actor: AuthSession, id: string, tx = db) => requireCommercialOfferEditAccess(actor, id, tx),
    requireCommercialOfferTargetAccess: (actor: AuthSession, target: { leadId?: string | null; clientId?: string | null }, tx = db) => requireCommercialOfferTargetAccess(actor, target, tx),
  };
  const result: Record<string, unknown> = {};
  new Function('exports', ...Object.keys(dependencies), javascript)(result, ...Object.values(dependencies));
  return result as Record<LeadWriteAction, (form: FormData) => Promise<unknown>>;
}
