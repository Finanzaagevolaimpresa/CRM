# Braces: isolated backport qualification R105

This harness qualifies a candidate for GHSA-vfj7-8cjw-p6xm on the repository's
Node 22 runtime. It does **not** install the candidate into CRM, update its lock,
change audit policy, or confer a merge/release decision. The original CRM audit
workflow remains mandatory and can fail while this technical job passes.

The source reference is [upstream PR 72](https://github.com/micromatch/braces/pull/72),
base `e53730e6f935498326c72d768889ac194eedc0e0`, head
`28d440b5dd449dbf1fe6f3506cf94ecca4d02660`. It remains an unmerged candidate as
observed on 2026-10-03. The [advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
lists no corrected release at that observation. Recheck publication before adoption.

## Reproduction

Run `.github/workflows/braces-backport-qualification.yml` through a pull request.
It installs the unchanged CRM lock with `npm ci --ignore-scripts` in a clean
checkout, verifies npm 3.0.3 source hashes, and prepares two **separate test copies**
under `node_modules/.cache/braces-qualification`. The candidate changes only the
five library files listed in `provenance.json`, applying only the security diff
from the pinned upstream commit pair. Its other, unreleased parser changes are
excluded. The zero-context patch is checked against that commit pair;
`backport.patch` anchors those same additions/removals to the published npm source
line numbers. Both patch hashes, identical change payloads and resulting file
hashes are verified before testing.
`prototypePatchSha256` preserves the earlier R104 patch representation. MIT
license and unchanged package metadata remain in both copies.

All 12 files in the complete upstream **3.0.3 release** test tree are copied
unchanged into both variants. The full proposed upstream reference (including
its other parser fixes) is tested separately with its complete 14-file suite. Mocha
and bash-path come from a separate upstream installation. Its genuine generated
lock is retained before `npm ci`, hashed again after the tests, and uploaded for
reproduction. Upstream does not provide a committed lock; subsequent first-time
resolution may therefore differ. To repeat exactly, use the retained lock.

The runner executes the original Mocha assertions, including Bash comparisons;
it requires nonzero tests, zero failures and zero pending tests. Upstream has
pre-existing case-table exclusions; runner counts do not claim those omitted
cases were executed. The original and minimal candidate must run equal release
test counts; the reference must include its larger, complete test inventory.

Ten additional tests demonstrate the original unbounded recursion/parent-cycle
failure and bounded rejection after patching, parser limits, ordinary syntax,
and equivalent results through actual CRM micromatch/chokidar/fast-glob modules.
Both locked fast-glob copies are covered. Substitution uses a process-local
module hook, explicitly **not** a package-manager installation of a fork.
Candidate adoption and complete application compatibility are separate work.

The job also records public registry metadata for the currently used compatible
major lines, without upgrading anything. A published parent update only solves
the issue after all vulnerable paths disappear from a genuine clean installation.
Tailwind 4 migration, ESLint downgrade, package renaming, audit exceptions and
weaker thresholds are outside this candidate.

## Evidence and limits

The 30-day GitHub artifact retains provenance, exact source/test hashes, upstream
tool lock, Node/npm versions, compatible registry observations, full suite counts,
before/after consumer results, TAP, and a final `TECHNICAL_QUALIFICATION_PASS_NOT_ADOPTED`
receipt. The final receipt verifies that the installed braces package and CRM
package/lock, application, migrations, and audit controls remain unchanged.
No private configuration or production data is used. No provider, scheduler,
worker, container or external email is activated by this harness.

The existing general CI continues to lint/typecheck/test/build and enforce its
unchanged runtime and complete audits. Green technical evidence does not resolve
an advisory, prove audit coverage of a renamed/vendor package, or authorize merge.
Rollback for this unadopted candidate is to leave the PR unmerged; no runtime
change needs reversing and all prior branches/evidence are preserved.
