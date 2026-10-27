import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Exercise the actual shared candidate loader. These bounded-query tests also
// protect the existing client/practice catalogue from the new technical mode.
const source = readFileSync('src/lib/selective-client-documents.ts', 'utf8');
const ast = ts.createSourceFile('documents.ts', source, ts.ScriptTarget.Latest, true);
const compiled = ts.transpileModule(['listClientDocumentOptions', 'listTechnicalDocumentCandidates', 'readClientDocumentOptions'].map(name => {
  const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert(node); return node.getText(ast);
}).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
class TechnicalAssignmentError extends Error { constructor(readonly code: string) { super(code); } }
type Document = { id: string; visibilityLevel: string; validUntil: Date | null; sizeBytes: number; mimeType: string;
  projectId: null; companyId: null; clientServiceId: null; title: string; fileName: string; documentCategory: string; serviceArea: string };
type Result = { documentsLimited: boolean; documentOptions: Array<{ versionId: string }> };
type Exports = Record<'listClientDocumentOptions' | 'listTechnicalDocumentCandidates', (tx: object, manager: object, clientId: string) => Promise<Result>>;
async function catalogue(documents: number, versions: number, technical = true, privateError?: Error) {
  const rows: Document[] = Array.from({ length: documents }, (_, i) => ({ id: `doc-${i}`,
    visibilityLevel: privateError ? 'privato-tecnico' : 'interno', validUntil: null, sizeBytes: 5, mimeType: 'text/plain',
    projectId: null, companyId: null, clientServiceId: null, title: `Doc ${i}`, fileName: `file-${i}.txt`, documentCategory: 'altro', serviceArea: 'progetto_investimento' }));
  const files = Array.from({ length: versions }, (_, i) => ({ id: `version-${i}`, documentId: rows[i % rows.length].id,
    version: i + 1, checksum: 'a'.repeat(64) }));
  const takes: number[] = [];
  const tx = { document: { findMany: async (args: { take: number }) => { takes.push(args.take); return rows.slice(0, args.take); } },
    documentVersion: { findMany: async (args: { take: number; where: { documentId: { in: string[] } } }) => {
      takes.push(args.take); return files.filter(row => args.where.documentId.in.includes(row.documentId)).slice(0, args.take);
    } }, company: { findMany: async () => [] }, project: { findMany: async () => [] }, clientService: { findMany: async () => [] },
    $queryRaw: async () => [{ now: new Date(0) }] };
  const sandbox = { exports: {} as Exports, TechnicalAssignmentError, unavailable: () => { throw new Error('SELECTIVE_CLIENT_DOCUMENT_UNAVAILABLE'); },
    loadIndependentProjectExclusions: async () => ({}), technicalDocumentPrivateVisibility: 'privato-tecnico',
    selectedTechnicalAcquisition: async () => { throw privateError; }, filterFinancialDocuments: async (_tx: object, _actor: object, candidates: Document[]) => candidates,
    isSensitiveDocument: () => false, hasPermission: () => true, maxClientDocumentBytes: 100,
    clientDocumentSnapshotSchema: { shape: { mimeType: { safeParse: () => ({ success: true }) } } }, selectedDocumentMode: () => 'preview' };
  runInNewContext(compiled, sandbox);
  const loader = technical ? sandbox.exports.listTechnicalDocumentCandidates : sandbox.exports.listClientDocumentOptions;
  return { result: JSON.parse(JSON.stringify(await loader(tx, { role: 'admin', active: true, permissionOverrides: [] }, 'client'))) as Result, takes };
}

test('technical complete budget checks both raw documents and versions with one lookahead, before filtering', async () => {
  for (const [documents, versions] of [[256, 256], [257, 257], [1, 256], [1, 257]]) {
    const { result, takes } = await catalogue(documents, versions);
    assert.deepEqual(takes, [257, 257]);
    const limited = documents > 256 || versions > 256;
    assert.equal(result.documentsLimited, limited); assert.equal(result.documentOptions.length, limited ? 0 : versions);
  }
});
test('ordinary client/practice limits remain 100 documents and 200 versions', async () => {
  const normal = await catalogue(1, 201, false);
  assert.deepEqual(normal.takes, [101, 201]); assert.equal(normal.result.documentOptions.length, 200); assert(normal.result.documentsLimited);
  assert.equal((await catalogue(101, 101, false)).result.documentOptions.length, 100);
});
test('a denied private candidate is omitted; a complete technical read propagates storage failures', async () => {
  assert.deepEqual((await catalogue(1, 1, true, new TechnicalAssignmentError('DENIED'))).result.documentOptions, []);
  await assert.rejects(catalogue(1, 1, true, new Error('PRIVATE_STORAGE_FAILURE')), /PRIVATE_STORAGE_FAILURE/);
  // Unchanged legacy catalogue behavior, not a new technical guarantee.
  assert.deepEqual((await catalogue(1, 1, false, new Error('PRIVATE_STORAGE_FAILURE'))).result.documentOptions, []);
});
