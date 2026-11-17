import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(join(root, 'package.json'));
const marker = Symbol.for('fai.crm.qualified.glob.adapter.v1');
const contract = JSON.parse(readFileSync(join(root, 'scripts/lint-glob-contract.json'), 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export function verifyGlobConsumerSource(bytes, expectedHash) {
  assert.equal(sha(bytes), expectedHash, 'Qualified tooling glob consumer changed');
}

export function verifyToolingGlobConsumers() {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.overrides.tinyglobby, 'npm:glob@14.0.6');
  assert.equal(manifest.overrides['@next/eslint-plugin-next@16.4.5']['fast-glob'], 'npm:glob@14.0.6');
  assert.equal(manifest.overrides.minimatch, '11.0.5');
  const result = [];
  for (const entry of contract.consumers) {
    const packageFile = require.resolve(entry.package + '/package.json');
    const packageRoot = dirname(packageFile);
    assert.equal(JSON.parse(readFileSync(packageFile, 'utf8')).version, entry.version);
    const importers = [];
    function inspect(dir) {
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, item.name);
        if (item.isDirectory()) inspect(path);
        else if (/\.(?:c|m)?js$/.test(item.name)) {
          const source = readFileSync(path);
          if (new RegExp('["\x27]' + entry.request + '["\x27]').test(source.toString('utf8'))) {
            importers.push({ path: relative(packageRoot, path).replaceAll('\\', '/'), sha256: sha(source) });
          }
        }
      }
    }
    inspect(join(packageRoot, entry.scanDirectory));
    importers.sort((a, b) => a.path.localeCompare(b.path, 'en'));
    assert.deepEqual(importers, entry.importers, 'New or changed glob importers require qualification');
    const fromConsumer = createRequire(packageFile);
    const replacement = fromConsumer(entry.request + '/package.json');
    assert.equal(replacement.name, 'glob', 'Only the real published replacement is admitted');
    assert.equal(replacement.version, '14.0.6');
    result.push({ ...entry, id: fromConsumer.resolve(entry.request) });
  }
  return result;
}

function strings(value, name) {
  const values = typeof value === 'string' ? [value] : value ?? [];
  assert.ok(Array.isArray(values) && values.length <= 256, 'Unsupported ' + name);
  assert.ok(values.every(p => typeof p === 'string' && p.length <= 4096 && !p.includes('\0')), 'Unsupported ' + name);
  return values;
}
const allowedOptions = new Set(['cwd', 'absolute', 'dot', 'expandDirectories', 'ignore',
  'onlyDirectories', 'onlyFiles', 'followSymbolicLinks', 'caseSensitiveMatch']);
function optionsFor(patterns, options = {}) {
  assert.ok(options && typeof options === 'object' && !Array.isArray(options));
  for (const [key, value] of Object.entries(options)) {
    assert.ok(allowedOptions.has(key), 'Unqualified glob option: ' + key);
    if (key === 'cwd') assert.equal(typeof value, 'string');
    else if (key !== 'ignore') assert.equal(typeof value, 'boolean');
  }
  const positives = [], excludes = [];
  const expand = pattern => {
    const p = pattern.endsWith('/') && pattern !== '/' ? pattern.slice(0, -1) : pattern;
    // glob does not treat a trailing /** as matching a file itself. Preserve
    // both the explicit file and directory expansion used by the resolver.
    return options.expandDirectories === false || p.endsWith('*') ? [p] : [p, p + '/**'];
  };
  for (const p of strings(options.ignore, 'ignore')) {
    if (p && (!p.startsWith('!') || p.startsWith('!('))) excludes.push(...expand(p));
  }
  for (const p of strings(patterns, 'patterns')) {
    if (!p) continue;
    if (!p.startsWith('!') || p.startsWith('!(')) positives.push(...expand(p));
    else if (!p.startsWith('!!') || p.startsWith('!!(')) excludes.push(...expand(p.slice(1)));
  }
  return { patterns: [...new Set(positives)], options: {
    cwd: options.cwd ?? process.cwd(), absolute: options.absolute ?? false,
    dot: options.dot ?? false, nocase: options.caseSensitiveMatch === false,
    follow: options.followSymbolicLinks !== false, nodir: !options.onlyDirectories && options.onlyFiles !== false,
    ignore: [...new Set(excludes)], posix: true,
  }, onlyDirectories: options.onlyDirectories === true };
}
function normalize(paths, config) {
  const values = paths.map(p => p.replace(/^\/\/\?\/([A-Za-z]:\/)/, '$1'));
  const selected = config.onlyDirectories ? values.filter(p => {
    try { return statSync(resolve(config.options.cwd, p)).isDirectory(); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }) : values;
  // Deterministic within each input pattern. The parser retains its explicit
  // outer project-pattern order; neither filesystem enumeration nor locale wins.
  return [...new Set(selected)].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}
function adapter(engine) {
  return Object.freeze({
    [marker]: true,
    globSync(patterns, options) {
      const config = optionsFor(patterns, options);
      return config.patterns.length ? normalize(engine.globSync(config.patterns, config.options), config) : [];
    },
    async glob(patterns, options) {
      const config = optionsFor(patterns, options);
      return config.patterns.length ? normalize(await engine.glob(config.patterns, config.options), config) : [];
    },
    isDynamicPattern(pattern, options = {}) {
      strings(pattern, 'pattern'); assert.equal(typeof pattern, 'string');
      assert.ok(Object.keys(options).every(k => k === 'caseSensitiveMatch'), 'Unqualified dynamic-pattern option');
      if (Object.hasOwn(options, 'caseSensitiveMatch')) assert.equal(typeof options.caseSensitiveMatch, 'boolean');
      return options.caseSensitiveMatch === false || pattern.startsWith('!')
        || engine.hasMagic(pattern, { magicalBraces: true, nonegate: true, nocomment: true });
    },
  });
}

export function installToolingGlobCompatibility() {
  const consumers = verifyToolingGlobConsumers();
  for (const { id } of consumers) {
    if (require.cache[id]?.exports?.[marker]) continue;
    assert.ok(!require.cache[id], 'Glob consumer loaded before compatibility bootstrap');
    const engine = require(id);
    assert.equal(typeof engine.globSync, 'function'); assert.equal(typeof engine.hasMagic, 'function');
    // Like the existing minimatch adapter, only these exact CommonJS aliases
    // receive the scoped API bridge. No module loader hook or dependency edit.
    require.cache[id].exports = adapter(engine);
  }
  return { status: 'PASS', replacement: 'glob@14.0.6', matcher: 'minimatch@11.0.5',
    consumers: consumers.map(({ package: name, version, importers }) => ({ name, version, importers })),
    originalConsumersUnmodified: true, scannerExceptions: 0 };
}
