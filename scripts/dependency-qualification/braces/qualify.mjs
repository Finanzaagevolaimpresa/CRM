import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { work } from './paths.mjs';

const loadModule = createRequire(import.meta.url);
const baseline = loadModule(join(work, 'baseline'));
const candidate = loadModule(join(work, 'candidate'));
const deepString = '{'.repeat(4998) + 'a' + '}'.repeat(4998);
const deepAst = depth => {
  let node = { type: 'text', value: 'a' };
  for (let i = 0; i < depth; i++) node = { type: 'brace', nodes: [node] };
  return { type: 'root', nodes: [node] };
};

for (const method of ['compile', 'expand', 'stringify']) {
  test(`${method}: original accepts excessive depth; candidate bounds input before recursion`, () => {
    assert.ok(deepString.length < 10000);
    // V8 optimization changes the exact stack-overflow threshold. Demonstrate the
    // missing original bound independently; deep caller ASTs below reproduce it.
    assert.doesNotThrow(() => baseline[method]('{'.repeat(101) + 'a' + '}'.repeat(101)));
    assert.throws(() => candidate[method](deepString), /Input depth .* exceeds max depth/);
  });
  test(`${method}: caller-built deep AST and child cycle rejected`, () => {
    assert.throws(() => baseline[method](deepAst(12000)), /Maximum call stack size exceeded/);
    assert.throws(() => candidate[method](deepAst(12000)), /AST depth .* exceeds max depth/);
    const cyclic = { type: 'brace', nodes: [] }; cyclic.nodes.push(cyclic);
    assert.throws(() => candidate[method](cyclic), /AST depth .* exceeds max depth/);
  });
}
test('parser: braces, parentheses, fractional and capped limits', () => {
  for (const [open, close] of [['{', '}'], ['(', ')']]) {
    assert.doesNotThrow(() => candidate.parse(open.repeat(100) + 'a' + close.repeat(100)));
    for (const maxDepth of [undefined, 101, 1e9, Infinity, NaN])
      assert.throws(() => candidate.parse(open.repeat(101) + 'a' + close.repeat(101), { maxDepth }), /exceeds max depth/);
    assert.doesNotThrow(() => candidate.parse(open + 'a' + close, { maxDepth: 1.5 }));
    assert.throws(() => candidate.parse(open.repeat(2) + 'a' + close.repeat(2), { maxDepth: 1.5 }), /exceeds max depth/);
    assert.throws(() => candidate.parse(open + 'a' + close, { maxDepth: 0 }), /exceeds max depth/);
  }
});
test('expander: parent self-cycle and multi-node cycle terminate with an explicit error', () => {
  for (const twoNodes of [false, true]) {
    const ast = { type: 'paren', nodes: [{ type: 'text', value: 'a' }] };
    ast.parent = twoNodes ? { type: 'paren', parent: ast } : ast;
    assert.throws(() => vm.runInNewContext('expand(ast)', { expand: baseline.expand, ast }, { timeout: 100 }), /Script execution timed out/);
    assert.throws(() => vm.runInNewContext('expand(ast)', { expand: candidate.expand, ast }, { timeout: 100 }), /AST parent chain contains a cycle/);
  }
});
test('ordinary parsed parent links and expansion remain compatible', () => {
  assert.deepEqual(candidate.expand('foo/({a,b})'), ['foo/(a)', 'foo/(b)']);
  assert.deepEqual(candidate.expand('src/{lib,app}/*.{ts,tsx}'), ['src/lib/*.ts', 'src/lib/*.tsx', 'src/app/*.ts', 'src/app/*.tsx']);
  assert.deepEqual(candidate.expand('x{01..03}'), ['x01', 'x02', 'x03']);
  const patterns = ['a', '{a,b}', '{a,{b,c}}', '{1..9..2}', '{a..f}', '{x,y}/**/*.{ts,tsx}',
    '{{a}}', '{a,{b}}', '{{x}y}', '{a,{b,{c}}', '{}{a}', 'foo/({a,b})', '*(a|{b|c,d})',
    String.raw`a\{b,c\}`, '{unclosed', '[{x,y}]', '${x,y}', '{,x}', 'x{a,b}{1,2}'];
  for (const pattern of patterns) for (const options of [{}, { escapeInvalid: true }])
    for (const method of ['compile', 'expand', 'stringify'])
      assert.deepEqual(candidate[method](pattern, options), baseline[method](pattern, options), `${method}: ${pattern}`);
});
test('real micromatch/chokidar/fast-glob consumers preserve fixture results with injected candidate', () => {
  // A test-only module hook simulates substitution; installed modules/lock are untouched.
  const results = ['baseline', 'candidate'].map(variant => {
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('./consumers.mjs', import.meta.url)), variant], { encoding: 'utf8', timeout: 10000 });
    assert.equal(run.status, 0, run.stderr || run.error?.message);
    return JSON.parse(run.stdout);
  });
  assert.deepEqual(results[1].outputs, results[0].outputs);
  assert.deepEqual(results[1].outputs.expansion, ['src/a.ts', 'src/a.tsx', 'src/b.ts', 'src/b.tsx']);
  assert.equal(results[1].outputs.globs.length, 2);
  for (const glob of results[1].outputs.globs) assert.deepEqual(glob.files, ['a.txt', 'b.txt']);
  assert.deepEqual(results[1].outputs.watched, ['a.txt', 'b.txt']);
  assert.ok(results[1].consumers.includes('micromatch'));
  assert.ok(results[1].consumers.includes('chokidar'));
});
