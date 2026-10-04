# R106: actual removal of the braces dependency

This is an isolated migration candidate, not an adopted release. Base: `85fa76d3d1c110da44c892859a70f9151b79cb7f`.

## Before and proposed after

The canonical lock has four paths to `braces@3.0.3`:

| Direct consumer | Dependency path |
| --- | --- |
| Tailwind 3.4.19 | chokidar 3.6.0 -> braces |
| Tailwind 3.4.19 | micromatch 4.0.8 -> braces |
| Tailwind 3.4.19 | fast-glob 3.3.3 -> micromatch -> braces |
| eslint-config-next 16.3.8 | @next/eslint-plugin-next 16.3.8 -> fast-glob 3.3.1 -> micromatch -> braces |

The proposal replaces the Tailwind compiler with the published `tailwindcss@4.3.3` and `@tailwindcss/postcss@4.3.3`. Only the Next lint plugin's `fast-glob` dependency is replaced with the published, independently implemented `tinyglobby@0.2.17`. This does not vendor or rename the vulnerable braces implementation. npm must generate the actual lock, and the existing complete audit must pass without any exception or threshold change.

## Deliberately bounded lint compatibility

An unqualified alias is unsafe: on this workstation `globSync('src', { onlyDirectories: true })` returned one directory with fast-glob and 77 with tinyglobby. Static/absolute paths and advanced brace patterns also differ. This proposal does **not** claim generic API equivalence.

The CRM uses the default single project root and no `settings.next.rootDir`. In this mode the pinned Next consumer returns `context.cwd` without calling a glob implementation. Before every lint, and in the normal unit suite, the new contract verifies the exact plugin version, exact consumer hash, sole import site, genuine replacement identity, effective configuration entries, default-root result, and absence of braces/micromatch/chokidar from the lock. Custom roots or a changed consumer fail closed and require fresh qualification. No ESLint rule is disabled or downgraded.

## CSS and browser impact

Tailwind 4 is a major compiler migration. The old published RGB palette and generated base CSS are retained as static compatibility data with the MIT notice. No executable Tailwind 3 compiler, matcher, watcher, or parser is copied. Small class-name migrations preserve the previous shadows and focus outlines and request sRGB gradient interpolation. Application permissions, data access and business behavior are untouched.

The PostCSS configuration and mobile navigation fixture must use the new plugin. Qualify utility output, mobile navigation, incremental rebuild, lint, typecheck, production build and all existing functional workflows before considering the candidate ready.

Tailwind 4 requires Firefox 128+, compared with the current Next default of Firefox 111+. Chrome/Edge 111+ and Safari 16.4+ remain aligned. Supporting Firefox 111–127 would require a different solution; current-browser CI does not prove compatibility with those older releases.

## Verification and adoption boundary

The short-lived lock-resolution workflow is restricted to `codex/braces-removal-r106`; it can commit only the genuine generated package lock to that branch after a clean installation, contract checks and the unchanged low-threshold npm audit. It has no production access and cannot merge. Before review, replace this bootstrap with read-only qualification.

No main update, merge, production deploy, migration, real-data write, or closure of other PRs is included. Reverting the candidate diff restores the old toolchain and its known audit blocker; no database rollback is involved. Record actual before/after lock and CI evidence, not just this proposed graph.

Sources: [Tailwind upgrade guide](https://tailwindcss.com/docs/upgrade-guide), [Next consumer](https://github.com/vercel/next.js/blob/v16.3.8/packages/eslint-plugin-next/src/utils/get-root-dirs.ts), [tinyglobby compatibility](https://superchupu.dev/tinyglobby/comparison), [Next browser support](https://nextjs.org/docs/architecture/supported-browsers).
