import assert from 'node:assert/strict';
import test from 'node:test';
import { pageTechnicalDocuments, selectedTechnicalDocuments, technicalDocumentCatalogueQuery,
  type TechnicalDocumentChoices, type TechnicalDocumentOption } from '../src/lib/technical-document-catalog';

function version(index: number): TechnicalDocumentOption {
  return { documentId: `document-${index}`, fileId: `version-${String(index).padStart(3, '0')}`, version: 1,
    contentSha256: 'a'.repeat(64), contextSha256: 'b'.repeat(64), allowDownload: false,
    title: `Relazione tecnica ${index}`, fileName: `relazione-${index}.pdf`, mimeType: 'application/pdf' };
}

test('document query rejects unbounded/unknown inputs; normalized names and punctuation stay literal', () => {
  assert.deepEqual(technicalDocumentCatalogueQuery.parse({}), { query: '', page: 1 });
  for (const raw of [{ page: 0 }, { page: 14 }, { page: 1.5 }, { page: '2' }, { query: 'a'.repeat(201) }, { take: 999 }])
    assert.equal(technicalDocumentCatalogueQuery.safeParse(raw).success, false);
  const option = { ...version(1), title: 'Relazione è pronta', fileName: 'Documento %_[+].pdf' };
  for (const query of ['RELAZIONE', 'e\u0300 pronta', ' %_[+] ', '.PDF'])
    assert.deepEqual(pageTechnicalDocuments([option], technicalDocumentCatalogueQuery.parse({ query })).options, [option]);
  assert.equal(pageTechnicalDocuments([option], { query: '.*', page: 1 }).options.length, 0);
});

test('all 256 admitted versions remain reachable; offsets and continuation follow the admitted search', () => {
  const options = Array.from({ length: 256 }, (_, i) => version(i));
  const visited: string[] = [];
  for (let page = 1; page <= 13; page++) {
    const result = pageTechnicalDocuments(options, { query: '', page });
    assert.equal(result.options.length, page === 13 ? 16 : 20);
    assert.equal(result.hasNext, page < 13);
    visited.push(...result.options.map(row => row.fileId));
    assert.deepEqual(Object.keys(result).sort(), ['hasNext', 'options', 'query']);
  }
  assert.deepEqual(visited, options.map(row => row.fileId));
  const found = pageTechnicalDocuments(options, { query: 'relazione-255.pdf', page: 1 });
  assert.deepEqual(found.options, [options[255]]); assert.equal(found.hasNext, false);
  assert.deepEqual(pageTechnicalDocuments(options, { query: 'relazione-255.pdf', page: 2 }).options, []);
});

test('off-page selections retain their exact old version/context and explicit download choice', () => {
  const a = version(0), b = version(255);
  const choices: TechnicalDocumentChoices = { [a.fileId]: { option: a, download: false }, [b.fileId]: { option: b, download: true } };
  const before = structuredClone(choices);
  pageTechnicalDocuments([{ ...a, contextSha256: 'c'.repeat(64), version: 2 }], { query: '', page: 1 });
  const result = selectedTechnicalDocuments(choices);
  assert.deepEqual(result, [a, b].map((row, i) => ({ documentId: row.documentId, fileId: row.fileId,
    version: 1, contentSha256: row.contentSha256, contextSha256: row.contextSha256, allowDownload: i === 1 })));
  assert.deepEqual(choices, before);
  assert(!JSON.stringify(result).includes('fileName')); assert(!JSON.stringify(result).includes('Relazione'));
});
