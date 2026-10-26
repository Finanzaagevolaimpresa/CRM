import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { z } from 'zod';
import { adminRequestQueueKind } from '../src/lib/admin-request-queue-query';

// Execute the actual service function, with controlled SQL/admission/session
// dependencies. This is a deterministic boundary regression, not a DB test.
const source = readFileSync(resolve('src/lib/admin-request-service.ts'), 'utf8');
const ast = ts.createSourceFile('admin-request-service.ts', source, ts.ScriptTarget.Latest, true);
const parts = ['AdminRequestQueueLimitError', 'readAdminRequestQueue'].map(name => {
  const declaration = ast.statements.find(node => (ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name?.text === name);
  assert(declaration); return declaration.getText(ast);
});
const compiled = ts.transpileModule(parts.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
type Row = { id: string; title: string; kind: 'DOCUMENT' | 'INTEGRATION'; author: string; allowed: boolean; until: number };
const row = (index: number, allowed = false): Row => ({ id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  title: 'private alpha %_', kind: 'INTEGRATION', author: 'actor', allowed, until: Infinity });
type Result = { isAdmin: boolean; items: Array<{ id: string; title: string; kind: string }>; hasNext: boolean };
type Exports = { readAdminRequestQueue: (db: object, user: object, page: number, q: string, kind?: string) => Promise<Result>;
  AdminRequestQueueLimitError: new (isAdmin: boolean) => Error };
async function run(rows: Row[], options: { q?: string; kind?: string; page?: number; admin?: boolean; now?: number; storageFailure?: boolean } = {}) {
  const byId = new Map(rows.map(item => [item.id, item])); let admissions = 0, finished = false;
  const tx = { $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?'); assert.match(sql, /^SELECT id FROM "AdminRequest"/);
    let selected = rows.filter(item => values[0] || item.author === values[1]);
    // Model both the old filtered-window SQL and the corrected bounded SQL,
    // so these assertions fail against the reviewed defective function.
    if (sql.includes('position(')) {
      const term = values[2] as string, kind = values[4] as string, offset = values[6] as number;
      selected = selected.filter(item => (!term || item.title.toLocaleLowerCase('it-IT').includes(term)) && (!kind || item.kind === kind));
      return selected.slice(offset, offset + 60).map(item => ({ id: item.id }));
    }
    assert.equal(values.length, 2); assert.match(sql, /LIMIT 6001$/);
    return selected.slice(0, 6001).map(item => ({ id: item.id }));
  } };
  const sandbox = { exports: {} as Exports, Error, z, adminRequestQueueKind,
    readRequestTransaction: async (_db: object, read: (client: typeof tx) => Promise<Result>) => read(tx),
    session: async () => ({ actor: { id: 'actor' }, isAdmin: !!options.admin }),
    admittedRequest: async (_tx: object, _auth: object, id: string) => {
      z.string().uuid().parse(id); admissions++; const item = byId.get(id)!;
      if (options.storageFailure) throw new Error('STORAGE_FAILURE');
      if (!item.allowed) throw Object.assign(new Error('DENIED'), { code: 'DENIED' });
      return { state: { requestId: item.id, submitted: { title: item.title, kind: item.kind }, status: 'OPEN' },
        origin: { accessUntil: item.until }, createdAt: new Date(0) };
    },
    isRequestUnavailable: (error: { code?: string }) => error.code === 'DENIED',
    finish: async (_tx: object, _auth: object, until = Infinity) => {
      finished = true; if ((options.now ?? 0) >= until) throw new Error('EXPIRED');
    },
  };
  runInNewContext(compiled, sandbox);
  try {
    const result = await sandbox.exports.readAdminRequestQueue({}, {}, options.page ?? 1, options.q ?? '', options.kind);
    return { status: 'RESULT', result: JSON.parse(JSON.stringify(result)) as Result, admissions, finished };
  } catch (error) {
    if (!(error instanceof sandbox.exports.AdminRequestQueueLimitError)) throw error;
    return { status: 'LIMIT', result: null, admissions, finished };
  }
}

for (const admin of [false, true]) {
  for (const size of [5999, 6000, 6001]) test(`queue boundary ${size}, ${admin ? 'personal Admin' : 'author'}: denied titles/types cannot distinguish queries`, async () => {
    const denied = Array.from({ length: size }, (_, i) => row(i));
    const changed = denied.map(item => ({ ...item, title: 'different private beta', kind: 'DOCUMENT' as const }));
    for (const corpus of [denied, changed]) {
      for (const query of [{ q: 'alpha', kind: 'INTEGRATION' }, { q: 'beta', kind: 'DOCUMENT' },
        { q: 'absent' }, { q: '', page: 2 }, { q: '%_', kind: 'INTEGRATION', page: 200 }]) {
        const result = await run(corpus, { ...query, admin });
        assert.equal(result.status, size > 6000 ? 'LIMIT' : 'RESULT'); assert.equal(result.finished, true);
        if (size > 6000) { assert.equal(result.result, null); assert.equal(result.admissions, 0); }
        else { assert.deepEqual(result.result, { isAdmin: admin, items: [], hasNext: false }); assert.equal(result.admissions, size); }
      }
    }
  });
  test(`mixed current admissions at capacity, ${admin ? 'personal Admin' : 'author'}: exact pages, literals and no denied hints`, async () => {
    const denied = Array.from({ length: 5967 }, (_, i) => row(i));
    const valid = Array.from({ length: 33 }, (_, i) => ({ ...row(7000 + i, true), title: 'visible %_' }));
    for (const corpus of [denied, denied.map(item => ({ ...item, title: 'visible %_', kind: 'DOCUMENT' as const }))]) {
      const rows = [...corpus, ...valid];
      const first = await run(rows, { q: 'visible %_', kind: 'INTEGRATION', admin });
      const second = await run(rows, { q: 'visible %_', kind: 'INTEGRATION', page: 2, admin });
      assert.equal(first.result?.items.length, 30); assert.equal(first.result?.hasNext, true);
      assert.equal(second.result?.items.length, 3); assert.equal(second.result?.hasNext, false);
      assert.deepEqual([...first.result!.items, ...second.result!.items].map(item => item.id), valid.map(item => item.id));
      assert.equal((await run(rows, { q: 'visible __', admin })).result?.items.length, 0);
      assert.equal((await run(rows, { q: 'visible %_', kind: 'DOCUMENT', admin })).result?.items.length, 0);
      for (const q of ['', 'visible', 'absent']) assert.equal((await run([...rows, row(9000)], { q, admin })).status, 'LIMIT');
    }
  });
}
test('foreign requests do not consume the author budget; personal Admin still checks every origin', async () => {
  const foreign = Array.from({ length: 6001 }, (_, i) => ({ ...row(i), author: 'other' }));
  const own = { ...row(7000, true), title: 'own visible' };
  const result = await run([...foreign, own]);
  assert.deepEqual(result.result?.items.map(item => item.id), [own.id]); assert.equal(result.result?.hasNext, false);
  assert.equal((await run([...foreign, own], { admin: true, q: 'own' })).status, 'LIMIT');
});
test('last instant expiry includes page offset and lookahead admissions', async () => {
  const rows = Array.from({ length: 33 }, (_, i) => row(i, true)); rows[0].until = 10; rows[30].until = 10;
  for (const page of [1, 2]) await assert.rejects(run(rows, { page, now: 10 }), /EXPIRED/);
});
test('unexpected storage failure cannot become an empty page or a limit result', async () => {
  await assert.rejects(run([row(1, true)], { storageFailure: true }), /STORAGE_FAILURE/);
});
