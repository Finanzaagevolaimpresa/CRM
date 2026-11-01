import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { AuthSession } from '../src/lib/auth';
import { technicalActionAllowed } from '../src/lib/technical-surface-policy';

// Execute the real server guard. Only its cookie/session boundary is supplied;
// the mandatory technical policy is identical to the application policy.
const source = ts.createSourceFile('technical-server-guards.ts',
  readFileSync('src/lib/technical-server-guards.ts', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'assertTechnicalServerAction');
assert(declaration);
const javascript = ts.transpileModule(declaration.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
export function technicalActionBoundary(session: AuthSession) {
  const exports: { assertTechnicalServerAction?: (action: string) => Promise<void> } = {};
  new Function('exports', 'getSession', 'technicalActionAllowed', javascript)(exports, async () => session, technicalActionAllowed);
  assert(exports.assertTechnicalServerAction);
  return exports.assertTechnicalServerAction;
}
