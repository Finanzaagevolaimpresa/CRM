import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// The published replacement is intentionally qualified for this single-root CRM.
// tinyglobby is NOT a general drop-in replacement for fast-glob's directory API.
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(join(root, 'package.json'));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
assert.equal(manifest.overrides?.['@next/eslint-plugin-next@16.3.8']?.['fast-glob'], 'npm:tinyglobby@0.2.17', 'The qualified scoped replacement override has changed.');
const pluginFile = require.resolve('@next/eslint-plugin-next/package.json');
const pluginRequire = createRequire(pluginFile);
const plugin = JSON.parse(readFileSync(pluginFile, 'utf8'));
assert.equal(plugin.version, '16.3.8', 'Requalify the scoped glob replacement before upgrading the Next lint plugin.');
const replacement = pluginRequire('fast-glob/package.json');
assert.equal(replacement.name, 'tinyglobby', 'The old fast-glob implementation must not be installed for the Next lint plugin.');
assert.equal(replacement.version, '0.2.17');

const dist = join(dirname(pluginFile), 'dist');
const consumers = [];
function inspect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) inspect(file);
    else if (entry.name.endsWith('.js') && /["']fast-glob["']/.test(readFileSync(file, 'utf8'))) consumers.push(relative(dist, file).replaceAll('\\', '/'));
  }
}
inspect(dist);
assert.deepEqual(consumers, ['utils/get-root-dirs.js'], 'New glob consumers require compatibility review.');
const consumerFile = join(dist, consumers[0]);
const consumerHash = createHash('sha256').update(readFileSync(consumerFile)).digest('hex');
const contract = JSON.parse(readFileSync(join(root, 'scripts/next-glob-contract.json'), 'utf8'));
export function verifyConsumerSource(source = readFileSync(consumerFile)) {
  assert.equal(createHash('sha256').update(source).digest('hex'), contract.consumerSha256, 'The qualified Next glob consumer has changed.');
}
verifyConsumerSource();

const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const forbidden = ['braces', 'micromatch', 'chokidar'];
for (const [path, metadata] of Object.entries(lock.packages)) {
  assert.ok(!forbidden.some(name => metadata.name === name || path.endsWith(`/node_modules/${name}`) || path === `node_modules/${name}`), `Vulnerable dependency path remains: ${path}`);
  if (path.endsWith('/fast-glob')) assert.equal(metadata.name, 'tinyglobby', 'A genuine replacement, not a renamed vulnerable implementation, is required.');
}

export const receipt = { status: 'PASS', nextPlugin: plugin.version, replacement: `${replacement.name}@${replacement.version}`, consumerSha256: consumerHash, rootMode: 'default-only', removedPackages: forbidden };

export function guardNextConfigs(configs) {
  const guarded = new WeakMap();
  return configs.map(config => {
    assert.ok(!Object.hasOwn(config.settings?.next ?? {}, 'rootDir'), 'Custom Next rootDir requires compatibility qualification.');
    const original = config.plugins?.['@next/next'];
    if (!original) return config;
    if (!guarded.has(original)) {
      const rule = original.rules['no-html-link-for-pages'];
      assert.equal(typeof rule.create, 'function');
      guarded.set(original, {
        ...original,
        rules: {
          ...original.rules,
          'no-html-link-for-pages': {
            ...rule,
            create(context) {
              // Runs on the resolved context in direct ESLint and IDE integrations,
              // before Next can enter its incompatible custom-root glob branch.
              assert.ok(!Object.hasOwn(context.settings?.next ?? {}, 'rootDir'), 'Custom Next rootDir requires compatibility qualification.');
              verifyConsumerSource();
              return rule.create(context);
            },
          },
        },
      });
    }
    return { ...config, plugins: { ...config.plugins, '@next/next': guarded.get(original) } };
  });
}
