import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export function installLegacyMinimatchCall() {
  if (require('minimatch/package.json').version !== '11.0.1') throw new Error('Requalify the pinned lint matcher');
  const id = require.resolve('minimatch');
  const current = require(id);
  if (typeof current === 'function') return;
  if (typeof current.minimatch !== 'function' || typeof current.Minimatch !== 'function') {
    throw new Error('Unsupported minimatch lint API');
  }
  // Preserve the named API used by modern consumers while exposing the callable
  // CommonJS API expected by eslint-plugin-import/react/jsx-a11y.
  const makeRe = (pattern, options) => {
    const matcher = new current.Minimatch(pattern, options);
    // eslint-plugin-import/no-internal-modules only calls .test(). Version 11
    // deliberately removed RegExp generation; retain its bounded matcher.
    return Object.freeze({ test: value => matcher.match(value) });
  };
  require.cache[id].exports = Object.assign(current.minimatch, current, { makeRe });
}
