# Qualified replacement of picomatch (PR260)

The 17 November 2026 advisory GHSA-fc5q-39xc-vjpf affects picomatch through
4.0.7. No patched picomatch release was available when this candidate was
prepared. The complete pinned OSV gate rejected PR260 R07; that result remains
a failure. The owner explicitly authorized qualifying a replacement.

## Published dependencies and narrow compatibility

npm generates the lock using genuine published glob 14.0.6 aliases for the
Next ESLint plugin's fast-glob and the two tinyglobby consumers. Minimatch
11.0.5 supplies the nonrecursive matcher. The lock contains no picomatch,
fdir, tinyglobby, micromatch, braces or chokidar implementation. Registry
names, URLs and integrity remain visible to the unchanged inventory parser;
470 entries represent 461 distinct package/version coordinates.

The project-owned lint-glob-compat module provides only globSync, glob and
isDynamicPattern to the exact CommonJS aliases used by the installed lint
configuration. It does not claim general fast-glob/tinyglobby equivalence,
rewrite installed dependencies, intercept the module loader, or affect
application imports. Bootstrap verifies the package versions and every source
file importing those aliases against a committed hash contract. New importers,
changed consumers, unrecognized options, or prior loading fail closed.

The bridge preserves explicit files and directory expansion, default file-only
results, dot/case behavior, negative patterns, ignores, absolute paths,
Windows separators and symlinks for the qualified consumers. Results are
unique and sorted by code point; the TypeScript parser retains its outer
project-pattern order. Patterns and option arrays have explicit bounds.

The existing Next single-root contract remains: custom rootDir configurations
are rejected, and the original Next rule must still detect an invalid link.
The existing callable minimatch adapter uses the new published matcher and
retains its bounded test method, without recreating regular expressions.

## Executable qualification

Run with the repository Node version after npm ci:

```text
node scripts/verify-next-glob-contract.mjs
node scripts/qualify-next-glob-guard.mjs
node --import tsx --test tests/lint-minimatch-compat.test.ts tests/tooling-glob-compat.test.ts tests/npm-audit-gate.test.ts
node scripts/qualify-tooling-glob.mjs
```

The new qualifier creates only synthetic files outside node_modules (the real
resolver deliberately excludes that directory). It exercises actual TypeScript
project discovery and parsing, two real import aliases, missing-import denial
through the CRM ESLint configuration, directory links, exclusions, deterministic
results, source-drift rejection and bounded repeated-extglob counterexamples.
Windows and Linux CI run the same consumer checks. The fresh fixture path is
canonicalized with fs.realpathSync.native: Windows TEMP can contain ancestor
casing that differs from the filesystem. The original import rule correctly
rejects that mismatch. A reproduced before/after counterexample qualifies the
fixture correction; a wrong-case import remains denied on both platforms. Optional
FAI_TOOLING_GLOB_TRACE=1 emits stage timestamps to stderr for diagnosis.

The preexisting genuine Next-rule counterproofs, minimatch parity checks, CSS
comparison in three browsers/four widths, full unit suite, native persistence,
image compatibility and application gates remain required. Security admission
still uses canonical npm 11.16.0 and checksum-pinned OSV 2.5.1 with the original
low threshold, complete inventory, empty ignore configuration and vulnerable
alias counterproof. A preliminary OSV API query is diagnostic, not admission.

## Scope and release

This dependency change does not change schema, roles, provider settings or
production data. It accompanies the VAE attribution change in the same PR260.
The actual final HEAD needs green CI and the existing independent reviewer;
prior R07 successes do not qualify the new lock. A return to the previous
lock restores the known audit failure and cannot be presented as a secure fix.
Production release and the two authorized Meta/ChatGPT submissions have their
separate recorded gates. Synthetic fixtures do not establish real acquisition.

Sources: [GitHub advisory](https://github.com/advisories/GHSA-fc5q-39xc-vjpf),
[published glob implementation](https://github.com/isaacs/node-glob),
[published minimatch implementation](https://github.com/isaacs/minimatch).
