import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Execute the actual admission service with deterministic boundary dependencies.
// Database permissions, locks and real canonical snapshots are tested in CI.
const source = readFileSync('src/lib/technical-document-catalog-source.ts', 'utf8');
const ast = ts.createSourceFile('catalog-source.ts', source, ts.ScriptTarget.Latest, true);
const declarations = ['denied', 'readAdmittedTechnicalDocumentOptions'].map(name => {
  const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert(node); return node.getText(ast);
});
const compiled = ts.transpileModule(declarations.join('\n'), { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
class TechnicalAssignmentError extends Error { constructor(readonly code: string) { super(code); } }
type Option = { fileId: string; documentId: string; title: string; allowDownload: boolean };
type Result = { options: Option[]; validUntil: number };
type Exports = { readAdmittedTechnicalDocumentOptions: (tx: object, state: object, context: object) => Promise<Result> };
async function read(count: number, options: { denied?: Set<string>; failure?: Error; missingMetadata?: boolean; restricted?: boolean; limited?: boolean; financialDenied?: Set<string>; financialFailure?: Error; missingDocument?: boolean; missingRecipient?: boolean } = {}) {
  const batches: string[][] = [], ids = Array.from({ length: count }, (_, i) => `version-${String(i).padStart(3, '0')}`);
  const sandbox = { exports: {} as Exports, Error, TechnicalAssignmentError,
    listTechnicalDocumentCandidates: async () => ({ documentsLimited: options.limited === true,
      documentOptions: ids.slice().reverse().map(versionId => ({ versionId, documentId: `doc-${versionId}` })) }),
    filterFinancialDocuments: async (_tx: object, target: { id: string }, documents: Array<{ id: string }>) => {
      assert.equal(target.id, 'technical-recipient');
      if (options.financialFailure) throw options.financialFailure;
      return documents.filter(row => !options.financialDenied?.has(row.id.slice(4)));
    },
    snapshotTechnicalAssignmentDocuments: async (_tx: object, _state: object, _context: object, choices: Array<{ fileId: string; allowDownload: boolean }>) => {
      assert(choices.length > 0 && choices.length <= 20); assert(choices.every(row => row.allowDownload === false));
      const batch = choices.map(row => row.fileId); batches.push(batch);
      if (options.failure) throw options.failure;
      if (batch.some(id => options.denied?.has(id))) throw new TechnicalAssignmentError('DENIED');
      return { documents: choices.map(row => ({ ...row, documentId: `doc-${row.fileId}` })),
        excludedVersionIds: options.restricted ? new Set(batch) : new Set(),
        metadata: options.missingMetadata || options.restricted ? [] : choices.map(row => ({ fileId: row.fileId, title: `Admitted ${row.fileId}` })),
        paths: new Map(batch.map(id => [id, '/PRIVATE_STORAGE_DO_NOT_PROJECT'])), validUntil: 10_000 - Number(batch[batch.length - 1].slice(-3)) };
    },
  };
  runInNewContext(compiled, sandbox);
  const tx = { document: { findMany: async () => ids.slice(options.missingDocument ? 1 : 0).map(id => ({ id: `doc-${id}` })) } };
  const result = await sandbox.exports.readAdmittedTechnicalDocumentOptions(tx, { actor: {},
    recipient: options.missingRecipient ? null : { id: 'technical-recipient' } }, { clientId: 'client' });
  return { result: JSON.parse(JSON.stringify(result)) as Result, batches };
}

test('complete source capacity fails before reading a single version; empty source stays read-only', async () => {
  await assert.rejects(read(257, { limited: true }), error => error instanceof TechnicalAssignmentError && error.code === 'UNAVAILABLE');
  const empty = await read(0); assert.deepEqual(empty.result.options, []); assert.deepEqual(empty.batches, []);
});
test('256 admitted versions use bounded canonical batches and retain earliest expiry without storage paths', async () => {
  const { result, batches } = await read(256);
  assert.equal(batches.length, 13); assert.equal(result.options.length, 256);
  assert.equal(new Set(result.options.map(row => row.fileId)).size, 256);
  assert.equal(result.validUntil, 9745); assert(!JSON.stringify(result).includes('PRIVATE_STORAGE'));
});
test('mixed denials are bisected without losing valid neighbours or duplicating snapshots', async () => {
  const denied = new Set(['version-000', 'version-019', 'version-020', 'version-037']);
  const { result } = await read(41, { denied });
  assert.equal(result.options.length, 37); assert.equal(new Set(result.options.map(row => row.fileId)).size, 37);
  assert(result.options.every(row => !denied.has(row.fileId)));
  const allDenied = await read(41, { denied: new Set(Array.from({ length: 41 }, (_, i) => `version-${String(i).padStart(3, '0')}`)) });
  assert.deepEqual(allDenied.result.options, []);
});
test('storage, serialization and missing metadata abort the whole catalogue rather than looking empty', async () => {
  for (const message of ['STORAGE_FAILURE', '40001', '40P01']) await assert.rejects(read(1, { failure: new Error(message) }), new RegExp(message));
  await assert.rejects(read(1, { missingMetadata: true }), /UNAVAILABLE/);
  assert.deepEqual((await read(3, { restricted: true })).result.options, []);
  for (const message of ['SELECTIVE_CLIENT_DOCUMENT_UNAVAILABLE', 'SELECTIVE_PRACTICE_DOCUMENT_UNAVAILABLE'])
    assert.deepEqual((await read(3, { failure: new Error(message) })).result.options, []);
});

test('financial exclusions never enter canonical admission while the remaining versions still do', async () => {
  const financialDenied = new Set(['version-000', 'version-019', 'version-020', 'version-037']);
  const { result, batches } = await read(41, { financialDenied });
  assert.equal(result.options.length, 37); assert.equal(batches.length, 2);
  assert.equal(new Set(batches.flat()).size, 37);
  assert(batches.flat().every(id => !financialDenied.has(id)));
  assert.deepEqual(result.options.map(row => row.fileId).sort(), batches.flat().sort());
});
test('missing recipient, incomplete source or failed financial reads never produce an apparently empty catalogue', async () => {
  await assert.rejects(read(1, { missingRecipient: true }), /DENIED/);
  await assert.rejects(read(1, { missingDocument: true }), /UNAVAILABLE/);
  for (const message of ['STORAGE_FAILURE', '40001', '40P01'])
    await assert.rejects(read(1, { financialFailure: new Error(message) }), new RegExp(message));
});
