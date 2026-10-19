import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { AuthSession } from '../../src/lib/auth';
import { hasPermission } from '../../src/lib/permission-evaluator';
import { technicalPracticeStatusUpdateSchema, technicalPracticeIdSchema, practiceCommunicationDraftSchema } from '../../src/lib/validation';
import { redactAuditPayload } from '../../src/lib/data-classification';
import { requireTechnicalPracticeEditAccess, requireTechnicalPracticeMutationAccess, denyWriteAccess } from '../../src/lib/write-access';
import { assertTechnicalPracticeOperational } from '../../src/lib/client-operational-hold';
import { UserFacingActionError } from '../../src/lib/action-errors';

export const practiceWriteActions = ['updateTechnicalPracticeStatus', 'archiveTechnicalPractice', 'createPracticeCommunicationDraft'] as const;
export type PracticeWriteAction = typeof practiceWriteActions[number];
const source = ts.createSourceFile('actions.ts', readFileSync('src/lib/actions.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const names = ['clean', 'audit', 'comparableValue', 'hasTechnicalPracticeChanges', 'technicalPracticeComparableFields', ...practiceWriteActions];
const bodies = names.map(name => {
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) ? node.name?.text === name
    : ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(source) === name));
  assert.ok(declaration, 'Actual action dependency absent: ' + name);
  return declaration.getText(source);
}).join('\n');
const javascript = ts.transpileModule(bodies, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
type Work = (tx: Prisma.TransactionClient) => Promise<unknown>;
export function actualPracticeActions(db: PrismaClient, session: AuthSession,
  schedule: (work: Work) => Promise<unknown> = work => db.$transaction(work)) {
  // The actual action bodies remain unchanged. Only cookies and transaction
  // timing are injectable; parsing, locks, permission checks and writes are real.
  const database = new Proxy(db, { get(target, property) {
    if (property === '$transaction') return schedule;
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const dependencies = { prisma: database, requirePermission: async () => session, hasPermission,
    technicalPracticeStatusUpdateSchema, technicalPracticeIdSchema, practiceCommunicationDraftSchema,
    redactAuditPayload, assertTechnicalPracticeOperational, UserFacingActionError, denyWriteAccess,
    requireTechnicalPracticeMutationAccess,
    requireTechnicalPracticeEditAccess: (actor: AuthSession, id: string) => requireTechnicalPracticeEditAccess(actor, id, db) };
  const result: Record<string, unknown> = {};
  new Function('exports', ...Object.keys(dependencies), javascript)(result, ...Object.values(dependencies));
  return result as Record<PracticeWriteAction, (form: FormData) => Promise<unknown>>;
}
