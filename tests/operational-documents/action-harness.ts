import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { PrismaClient } from '@prisma/client';
import type { AuthSession } from '../../src/lib/auth';
import type { UpdateCredentials } from '../../src/lib/record-updates';
import { PrivilegedAdmissionRequired, privilegedStepUpCookieName } from '../../src/lib/privileged-access';
import { OperationalArchiveTimeError, resolveProformaArchiveTime } from '../../src/lib/operational-document-time';
import { recordOperationalProformaArchive } from '../../src/lib/operational-document-delivery';
import { readOperationalDocument } from '../../src/lib/operational-documents';
import { canUseOperationalDocuments, documentKindLabels } from '../../src/lib/operational-document-contract';
import { renderOperationalPdf, renderOperationalProformaPdf } from '../../src/lib/operational-document-pdf';
import { technicalActionBoundary } from '../technical-action-boundary';

function actualFunctions(path: string, names: string[]) {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const bodies = names.map(name => {
    const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert(declaration, 'Function absent: ' + name); return declaration.getText(source);
  });
  return ts.transpileModule(bodies.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
}
const archiveAction = actualFunctions('src/lib/operational-document-delivery-actions.ts', ['save', 'recordProformaArchiveAction']);
const pdfRoute = actualFunctions('src/app/document-library/[id]/pdf/route.ts', ['GET']);
export class DocumentActionRedirect extends Error { constructor(readonly location: string) { super('SYNTHETIC_REDIRECT'); } }

/** Actual action and parser; inject only HTTP cookies/navigation. The default
 * archive command still checks live DB authority, proof, folder and timestamp. */
export function actualArchiveAction(db: PrismaClient, session: AuthSession, proof: UpdateCredentials,
  record: typeof recordOperationalProformaArchive = recordOperationalProformaArchive) {
  const dependencies = { prisma: db, requireSession: async () => session,
    assertTechnicalServerAction: technicalActionBoundary(session),
    requireEnforcedPrivilegedMutation: async () => undefined, loadActivePrivilegedStepUpKey: async () => proof.key,
    cookies: async () => ({ get: (name: string) => ({ value: name === privilegedStepUpCookieName ? proof.stepUpToken : proof.sessionToken }) }),
    privilegedStepUpCookieName, PrivilegedAdmissionRequired, OperationalArchiveTimeError, resolveProformaArchiveTime,
    recordOperationalProformaArchive: record, revalidatePath: () => undefined,
    redirect: (location: string) => { throw new DocumentActionRedirect(location); }, unstable_rethrow: () => undefined,
  };
  const exports: { recordProformaArchiveAction?: (state: { error: string | null }, form: FormData) => Promise<{ error: string | null }> } = {};
  new Function('exports', ...Object.keys(dependencies), archiveAction)(exports, ...Object.values(dependencies));
  assert(exports.recordProformaArchiveAction); return exports.recordProformaArchiveAction;
}

/** Unchanged PDF route; DB admission/rendering are real, with a supplied cookie session. */
export function actualDocumentPdfRoute(db: PrismaClient, session: AuthSession) {
  const dependencies = { prisma: db, getSession: async () => session, assertTechnicalFileRoute: async () => undefined,
    canUseOperationalDocuments, readOperationalDocument, documentKindLabels, renderOperationalPdf, renderOperationalProformaPdf };
  const exports: { GET?: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response> } = {};
  new Function('exports', ...Object.keys(dependencies), pdfRoute)(exports, ...Object.values(dependencies));
  assert(exports.GET); return (id: string) => exports.GET!(new Request('http://localhost/document-library/' + id + '/pdf'), { params: Promise.resolve({ id }) });
}
