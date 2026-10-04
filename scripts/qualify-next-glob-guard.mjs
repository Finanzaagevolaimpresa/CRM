import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { ESLint } from 'eslint';
import { receipt, verifyConsumerSource } from './next-glob-guard.mjs';

const require = createRequire(import.meta.url);
const consumer = require.resolve('@next/eslint-plugin-next/dist/utils/get-root-dirs.js');
const source = readFileSync(consumer);
verifyConsumerSource(source);
assert.throws(() => verifyConsumerSource(Buffer.concat([source, Buffer.from('\n// changed consumer\n')])), /qualified Next glob consumer has changed/);

const code = 'export default function SyntheticPage() { return <a href="/dashboard">Dashboard</a>; }';
const options = { filePath: 'src/app/tooling-contract-probe.tsx' };
const original = await new ESLint().lintText(code, options);
assert.ok(original[0].messages.some(message => message.ruleId === '@next/next/no-html-link-for-pages'), 'The genuine Next rule must still detect a broken internal link.');

for (const rootDir of ['src', ['src', 'packages/*'], '/synthetic/crm', 'C:\\synthetic\\crm']) {
  const eslint = new ESLint({ overrideConfig: { settings: { next: { rootDir } } } });
  await assert.rejects(eslint.lintText(code, options), /Custom Next rootDir requires compatibility qualification/);
}
const valid = await new ESLint().lintText('export default function SyntheticPage() { return <main>CRM</main>; }', options);
assert.equal(valid[0].errorCount, 0);
console.log(JSON.stringify({ ...receipt, directEslintChecks: 7, customRootCounterproofs: 4, changedConsumerRejected: true, originalRuleActive: true }));
