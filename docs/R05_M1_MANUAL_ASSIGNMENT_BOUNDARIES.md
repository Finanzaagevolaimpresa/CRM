# R05 M1 — Administrative assignment boundaries

This delta follows the account candidate PR146 at
2dd8ec00aa4f9c2f124576bfbad1a1e64ac24325. It is a separate software increment,
not completion of M1 or production qualification.

## Behavior

- The ordinary manual lead form creates an unassigned lead. Website projection already persists a
  null assignee. Only administrators see the unassigned lead queue; direction
  retains visibility of assigned leads and commercial users see their own.
- Public assignment commands are admin-only, including assignment at creation of
  tasks, services and technical practices. Permission overrides, self-assignment
  and the direction role do not grant this authority.
- Client and project creation no longer infer an owner from the caller.
  Administrators assign their owners explicitly from their detail pages.
  Lead conversion preserves its existing assigned commercial; an unassigned lead
  never falls back to the converting caller.
- Omitted or unchanged assignee fields are excluded from ordinary write patches.
  An explicit clear is distinct from an omitted field. Administrative changes
  compare the previously observed owner (or form revision for client/project).
- Assignment transactions lock and revalidate the actual registry session/admin
  and active target users; writes and assignment audits commit together.
  Existing N14 protected commands still require their enforced step-up.
- Public N14 self-claim is denied, including direct HTTP invocation, and removed
  from the UI. Manager commands carry a server-owned requireManualAdmin context
  checked against the locked authoritative session. The historical internal
  N14/N15 library contract and strictly synthetic qualification remain unchanged;
  they are not an alternative public assignment endpoint or an activation.
- Revocation of lead/client ownership affects subsequent list/detail/export
  requests from already-open sessions. Creator-based document/task access and
  full technical scope continuity are a subsequent M1 delta, not qualified here.

## Verification

Targeted PostgreSQL tests cover current role and session authority, inactive and
removed targets, ownership/list consistency, rollback, and stale form preservation.
Browser tests cover explicit client/project assignment, old-session/direct HTTP
denial, unassigned manual intake and self-assignment tampering. Lead notifications
use the canonical list policy; browser checks cover notifications, search and
direct detail access before assignment and after reassignment in an existing session.
Global lead search applies the same database visibility predicate before its
12-result limit. A browser regression inserts 13 newer unassigned matches and
an older assigned lead, then verifies that commercial and direction sessions
still find the authorized lead without seeing the unassigned matches.

The existing VNX03 isolated WordPress-to-CRM test is updated to exercise admin
assignment with real ephemeral step-up, double-submit conflict, commercial
visibility and first response. Its production-image profile receives a new
ephemeral test key; the historical base profile and production configuration do
not change. Existing N14/N15 database contracts continue to run.

The historical VNX03 job in `ci.yml` checks out schema44 commit
`c49b18ccc4df713e212e8e4f2f05100638aee317`. Its green result is historical evidence,
not proof of this candidate's changed N14 browser path. Review P2 therefore adds
`r05-n14-candidate.yml`: it checks out the exact event head, binds its tree, and
runs both authentic WPForms and the admin N14 browser scenario on schema47.
The candidate guard requires a clean checkout, unchanged schema and all migration
bytes against baseline `8d87d7c0c1377e686ad9c3a9e15a48de6a7ec749`, and exactly 47
migrations. Commit/tree mismatches, dirty files, schema/migration modifications
and a further migration fail closed. The historical job and scope guard remain
byte-identical. Unknown harness profiles are rejected; no numeric count override
is accepted. Candidate preflight/runtime/N14 receipts identify the profile,
commit, tree and migration count, and CI validates them before declaring success.

Local tsx cannot initialize os.userInfo under this Windows host. Targeted tests
can additionally run through TypeScript in-process transpilation; canonical
tests, the dependency lock and browser qualification are checked in CI.
No claim of current production health or backup success follows from these tests.

## Limits and lifecycle

M1 remains partial: original/current commercial responsibility, departments,
explicit acceptance distinct from assignment/notification, full removal/suspension
continuity and all-surface technical isolation remain to complete.
The separately gated controlled-intake service still assigns its creator; that
residual entry point must be changed and qualified before M1 can be complete.
M2–M5 follow in sequence in the same task.

No schema changes or historical migration edits. Existing 47 migration bytes,
N14/N15 admission, dispatch/provider/worker/scheduler settings and R06 historical
backup evidence remain unchanged. Two backup attempts remain consumed.

deploy_required=YES; migration_required=NO for this delta;
production_change_required=YES for a future release;
runtime_revalidation_required=YES; execution_authorized=NO for this software
delivery. This statement grants no new authority and does not revoke prior
specific authorizations within their scope, target and gates.

Rollback is a software revert of this increment. It does not undo administrative
assignments or reconstruct prior owners. A release rollback must consider that
the preceding version again admits broader ownership mutations; any production
rollback therefore remains a separate authorized operation.
