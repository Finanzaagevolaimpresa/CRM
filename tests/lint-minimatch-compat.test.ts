import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { readFileSync } from 'node:fs';

test('the lock retains only the patched matcher and legacy lint calls use the same implementation', () => {
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as { packages: Record<string, { version: string }> };
  const matchers = Object.entries(lock.packages).filter(([path]) => path.endsWith('/minimatch'));
  assert.equal(matchers.length, 1); assert.equal(matchers[0][1].version, '11.0.1');
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import { installLegacyMinimatchCall } from './scripts/lint-minimatch-compat.mjs';
    import { minimatch as esmMatch } from 'minimatch';
    installLegacyMinimatchCall(); installLegacyMinimatchCall();
    const require = createRequire(import.meta.url), match = require('minimatch');
    for (const [value, pattern, options, expected] of [
      ['src/app/page.tsx', '**/*.{ts,tsx}', {}, true], ['.hidden.ts', '**/*.ts', {}, false],
      ['.hidden.ts', '**/*.ts', {dot:true}, true], ['renderPanel', 'render*', {}, true],
      ['src/app/page.tsx', '**/*.js', {}, false], ['src/app/page.tsx', '*.tsx', {matchBase:true}, true],
      ['Foo', 'foo', {nocase:true}, true], ['foo', '!bar', {}, true]
    ]) {
      assert.equal(match(value, pattern, options), expected);
      assert.equal(match(value, pattern, options), esmMatch(value, pattern, options));
      assert.equal(new match.Minimatch(pattern, options).match(value), expected);
    }
    assert.equal(match.defaults({dot:true})('.a', '*'), true);
    assert.equal(match.makeRe('src/**/*.tsx').test('src/app/page.tsx'), true);
    const { ESLint } = require('eslint');
    const lint = new ESLint({ overrideConfig: { rules: {
      'react/jsx-handler-names': ['error', { eventHandlerPrefix: 'handle', eventHandlerPropPrefix: 'on' }],
      'react/forbid-component-props': ['error', { forbid: [{ propNamePattern: 'private*' }] }],
      'import/no-internal-modules': ['error', { forbid: ['restricted/**'] }]
    } } });
    const [result] = await lint.lintText('export function Sample(){return <Panel privateToken="synthetic"/>}', {filePath:'src/lint-minimatch-synthetic.tsx'});
    assert(result.messages.some(message => message.ruleId === 'react/forbid-component-props'));
    const [blocked] = await lint.lintText('import "restricted/private";', {filePath:'src/lint-minimatch-synthetic.tsx'});
    assert(blocked.messages.some(message => message.ruleId === 'import/no-internal-modules'));
  `], { stdio: 'pipe', timeout: 60_000 });
});
