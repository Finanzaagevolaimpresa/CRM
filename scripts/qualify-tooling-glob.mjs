import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { installLegacyMinimatchCall } from './lint-minimatch-compat.mjs';
import { installToolingGlobCompatibility, verifyGlobConsumerSource } from './lint-glob-compat.mjs';

installLegacyMinimatchCall();
const receipt = installToolingGlobCompatibility();
installToolingGlobCompatibility();
const require = createRequire(import.meta.url);
const packageFile = require.resolve('@typescript-eslint/typescript-estree/package.json');
const parserRequire = createRequire(packageFile);
const glob = parserRequire('tinyglobby');
const cache = join(tmpdir(), 'fai-tooling-glob'); mkdirSync(cache, { recursive: true });
// Windows TEMP may have non-canonical ancestor casing; preserve the real rule,
// and address the synthetic fixture by the filesystem's canonical path.
const fixture = realpathSync.native(mkdtempSync(join(cache, 'synthetic-')));
const slash = p => p.replaceAll('\\', '/');
function put(name, contents = 'export const synthetic = 1;\n') {
  const path = join(fixture, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, contents);
}
for (const name of ['app/src/a.ts', 'app/src/b.ts', 'app/src/nested/c.ts', 'app/src/.hidden.ts',
  'app/generated/skip.ts', 'app/node_modules/vendor/skip.ts', 'other/src/item.ts',
  'spaces and [brackets]/value.ts', 'app/src/UPPER.TS']) put(name);
mkdirSync(join(fixture, 'empty'), { recursive: true });
const trace = label => { if (process.env.FAI_TOOLING_GLOB_TRACE === '1') console.error(new Date().toISOString(), label); };
let assertions = 0;
const check = (pattern, options, expected) => {
  trace('glob ' + JSON.stringify(pattern));
  assert.deepEqual(glob.globSync(pattern, { cwd: fixture, ...options }), expected, JSON.stringify({ pattern, options }));
  assertions++;
};
check('app/src/**/*.ts', {}, ['app/src/a.ts', 'app/src/b.ts', 'app/src/nested/c.ts']);
check('app/src/**/*.ts', { dot: true }, ['app/src/.hidden.ts', 'app/src/a.ts', 'app/src/b.ts', 'app/src/nested/c.ts']);
check('app/src', {}, ['app/src/UPPER.TS', 'app/src/a.ts', 'app/src/b.ts', 'app/src/nested/c.ts']);
check('app/src', { expandDirectories: false }, []);
check('app/src/a.ts', {}, ['app/src/a.ts']);
check(['app/src/**/*.ts', '!**/nested/**'], {}, ['app/src/a.ts', 'app/src/b.ts']);
check('app/**/*.ts', { ignore: ['**/node_modules/**', '**/generated/**'] }, ['app/src/a.ts', 'app/src/b.ts', 'app/src/nested/c.ts']);
check('app/src/{a,b}.ts', { expandDirectories: false }, ['app/src/a.ts', 'app/src/b.ts']);
check('app/src/+(a|b).ts', { expandDirectories: false }, ['app/src/a.ts', 'app/src/b.ts']);
check(['app/src/b.ts', 'app/src/a.ts', 'app/src/a.ts'], {}, ['app/src/a.ts', 'app/src/b.ts']);
check('missing/**/*', {}, []);
check([], {}, []);
check('app/src/**/*.ts', { absolute: true }, ['app/src/a.ts', 'app/src/b.ts', 'app/src/nested/c.ts'].map(p => slash(join(fixture, p))));
check(slash(join(fixture, 'app/src/a.ts')), { absolute: true, expandDirectories: false }, [slash(join(fixture, 'app/src/a.ts'))]);
check('app/src/*.TS', {}, ['app/src/UPPER.TS']);
check('app/src/*.TS', { caseSensitiveMatch: false }, ['app/src/UPPER.TS', 'app/src/a.ts', 'app/src/b.ts']);
for (const [pattern, expected] of [['a.ts', false], ['src/**/*.ts', true], ['{a,b}.ts', true], ['!a.ts', true], ['+(a|b).ts', true]]) {
  assert.equal(glob.isDynamicPattern(pattern), expected); assertions++;
}
assert.throws(() => glob.globSync('**/*', { cwd: fixture, fakeOption: true }), /Unqualified glob option/); assertions++;
assert.throws(() => glob.globSync('x'.repeat(4097)), /Unsupported patterns/); assertions++;
assert.throws(() => glob.globSync(Array(257).fill('*.ts')), /Unsupported patterns/); assertions++;
assert.throws(() => glob.globSync('a\0b'), /Unsupported patterns/); assertions++;
assert.deepEqual(await glob.glob('app/src/*.ts', { cwd: fixture }), ['app/src/a.ts', 'app/src/b.ts']); assertions++;
symlinkSync(join(fixture, 'app/src/nested'), join(fixture, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
check('linked/*.ts', {}, ['linked/c.ts']);
const source = readFileSync(join(dirname(packageFile), 'dist/parseSettings/resolveProjectList.js'));
const expected = receipt.consumers.find(p => p.name === '@typescript-eslint/typescript-estree').importers[0].sha256;
verifyGlobConsumerSource(source, expected);
assert.throws(() => verifyGlobConsumerSource(Buffer.concat([source, Buffer.from('\n// drift')]), expected), /consumer changed/); assertions++;

for (const name of ['app', 'other']) put(name + '/tsconfig.json', JSON.stringify({
  compilerOptions: { target: 'ES2022', module: 'CommonJS', strict: true, baseUrl: '.', paths: { '@local/*': ['src/*'] } },
  include: ['src/**/*.ts'], exclude: ['node_modules', 'generated'],
}));
put('app/node_modules/vendor/tsconfig.json', '{"include":["*.ts"]}');
const { resolveProjectList, clearGlobResolutionCache } = parserRequire('./dist/parseSettings/resolveProjectList.js');
clearGlobResolutionCache();
trace('parser projects');
const projects = resolveProjectList({ project: ['*/tsconfig.json', '**/node_modules/**/tsconfig.json'], tsconfigRootDir: fixture, singleRun: true });
assert.deepEqual([...projects.values()].map(slash), ['app/tsconfig.json', 'other/tsconfig.json'].map(p => slash(join(fixture, p)))); assertions++;
const parser = require('@typescript-eslint/parser');
trace('parser parse');
const parsed = parser.parseForESLint(readFileSync(join(fixture, 'app/src/a.ts'), 'utf8'), {
  filePath: join(fixture, 'app/src/a.ts'), project: ['*/tsconfig.json'], tsconfigRootDir: fixture,
});
assert.ok(parsed.services.program.getSourceFile(join(fixture, 'app/src/a.ts'))); assertions++;
trace('resolver');
const resolver = require('eslint-import-resolver-typescript');
for (const [file, request, target] of [['app/src/a.ts', '@local/b', 'app/src/b.ts'], ['other/src/item.ts', '@local/item', 'other/src/item.ts']]) {
  trace('resolve ' + file);
  const result = resolver.resolve(request, join(fixture, file), { project: [slash(join(fixture, '*/tsconfig.json'))] });
  assert.equal(result.found, true); assert.equal(slash(result.path), slash(join(fixture, target))); assertions++;
}
assert.equal(resolver.resolve('@local/missing', join(fixture, 'app/src/a.ts'), { project: [slash(join(fixture, '*/tsconfig.json'))] }).found, false); assertions++;
trace('eslint import');
const { ESLint } = require('eslint');
const { default: crmConfig } = await import('../eslint.config.mjs');
const lint = new ESLint({ cwd: fixture, overrideConfigFile: true, overrideConfig: [...crmConfig, {
  settings: { react: { version: require('react/package.json').version }, 'import/resolver': { typescript: { project: [slash(join(fixture, '*/tsconfig.json'))] } } },
  rules: { 'import/no-unresolved': 'error' },
}] });
trace('eslint good');
const [valid] = await lint.lintText('import { synthetic } from "@local/b"; export const value = synthetic;', { filePath: join(fixture, 'app/src/a.ts') });
assert.ok(!valid.messages.some(m => m.ruleId === 'import/no-unresolved'), JSON.stringify(valid.messages)); assertions++;
trace('eslint bad');
const [invalid] = await lint.lintText('import "@local/missing";', { filePath: join(fixture, 'app/src/a.ts') });
assert.ok(invalid.messages.some(m => m.ruleId === 'import/no-unresolved')); assertions++;
const [wrongCase] = await lint.lintText('import "@local/B";', { filePath: join(fixture, 'app/src/a.ts') });
assert.ok(wrongCase.messages.some(m => m.ruleId === 'import/no-unresolved')); assertions++;
trace('bounded');
const bounded = spawnSync(process.execPath, ['--input-type=module', '-e', `
  import assert from 'node:assert/strict';
  import { Minimatch } from 'minimatch';
  for(const pattern of ['+(*)','+(*a)','*(a|aa)','+(*?a)'])
    assert.equal(new Minimatch(pattern).match('a'.repeat(128)+'!'), pattern === '+(*)');
`], { cwd: process.cwd(), timeout: 3000, encoding: 'utf8' });
assert.equal(bounded.status, 0, bounded.stderr || bounded.error?.message); assertions++;
console.log(JSON.stringify({ ...receipt, assertions, actualParserProjects: projects.size,
  actualAliasResolutions: 2, actualEslintPositiveAndNegative: true, symbolicLinkQualified: true,
  repeatedExtglobBounded: true, fixtureOnly: true, productionContact: false, platform: process.platform }));
