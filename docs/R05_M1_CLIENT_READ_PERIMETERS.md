# R05 M1 — administrator-controlled client consultation

This dependent increment adds explicit client consultation to the current
assignment rules. It does not complete M1 or authorize any production operation.

## Operator behaviour

An administrator opens an account's **Perimetro di consultazione**, searches a
client, and grants or revokes consultation after a current privileged step-up.
The page supports client search in pages of 25 and decisions in pages of 50;
continuation links expose the remaining rows. Each decision shows its current
state, revision, author and time. Earlier decisions remain in the audit ledger.
Removed/inactive accounts and archived clients cannot receive new consultation;
their existing decisions remain visible and revocable.

The grant applies to commerciale, consulente, backoffice, revisore,
amministrazione and collaboratore_limitato. It permits the canonical client
read context and its consistently linked records, subject to function-specific
permissions and the separate permission for sensitive documents. It does not
assign operational responsibility or make the ordinary client/project/service
edit policies true. Specialized review/approval commands still require their
own permission, authoritative session and separation-of-duties checks.

Revisore and amministrazione no longer receive global client scope from their
role alone. Existing admin/direction scope and explicit current child assignments
remain separate. Revoking an additional grant does not revoke those independent
assignments. The initial migration grants nobody access automatically.

The session loader reads active grants from the database on every request, in
both existing session modes. The authoritative dossier and readiness services
also refresh consultation scope inside their transaction. The client search
predicate and readiness page use that same scope. A revocation applies on the
next request in an already open session; no claim is made to cancel a response
already admitted or to serialize every legacy read against concurrent changes.

## Decision integrity

The server verifies current admin identity and registry session under lock,
requires the privileged mutation gate, locks the recipient, checks a live client
for activation and verifies the expected decision version. Grant/revoke and the
minimal before/after audit are one serializable transaction. Duplicate, stale,
foreign-session and concurrent requests fail without silently overwriting a
decision. A failed audit rolls back the grant. Logical account removal keeps
the decision rows; inactive/deleted identities receive no scope.

## Additive schema48 qualification

Migration `20260924100000_admin_client_read_perimeters_v1` creates only
`ClientReadGrant` and its indexes/constraints. Recipient, creator, updater and
client references use RESTRICT; the user/client pair is unique and revisions
must be positive. Schema and migration hashes are pinned by
`scripts/r05/verify-perimeter-schema.mjs`. All 47 migration files from merged
baseline `8d87d7c0c1377e686ad9c3a9e15a48de6a7ec749` must remain byte-identical.

CI qualifies historical 46→47 separately, injects a transaction-ending error
into migration48 on the isolated schema47 database, proves rollback and the
unchanged ledger, then applies the exact migration and verifies schema48 with
an empty grant table. Existing historical schema43/44/46 banks stay historical.
The new N14 profile binds the exact candidate HEAD/tree to schema48; the old
strict schema47 guard remains and is not relaxed. Negative fixtures reject wrong
identity, dirty source, changed historical bytes, altered additive DDL/schema,
and an unapproved further migration.

The packaged bank retains its previous data/document/session checks and adds
populated grant rows to its preserved footprint. **The old recovery image does
not enforce these new perimeters.** Its schema48 result is explicitly
`CI_SCHEMA48_COMPATIBILITY_ONLY`, with `legacyRecoveryAdmitted=false` and
`legacyRecoveryEnforcesClientPerimeters=false`. Storage compatibility is not a
safe operational rollback qualification. A perimeter-aware recovery target must
be independently prepared and qualified before any release admission. Neither
the old image nor a software revert is an admissible rollback merely because
the table and its bytes survive.

## Evidence and remaining work

Tests cover all six recipient roles, query-policy parity, sensitive/foreign
contexts, stale and concurrent decisions, audit failure, removed recipients and
archived clients. Browser cases use actual admin UI, step-up, HTTP actions and
private document bytes on a sentinel-bound ephemeral database: no grant without
step-up or in disabled mode, no non-admin grant with a forged action, consultation
and revocation in the same open session, denied upload despite function permission,
stale replay, unchanged owners and both pagination boundaries. Read-only reviewer
fixtures in existing dossier/preanalysis tests receive explicit synthetic grants.

Local lint/policy/guard checks are supplementary. Local Playwright is unavailable;
the broad local runner also lacks some application alias resolution. The legacy
schema47 guard encountered a Windows temporary Git-object permission error;
no permission changes or local browser/database PASS are inferred. Canonical
CI results must be recorded against the published HEAD/tree before review.

Commercial origin, departments, individual acceptance and the purchased-service
route remain M1 work. M2–M5 continue in the same Desktop task. No merge, live
backup, SSH, production migration/deploy or activation is included. R06 receipts,
the two consumed backup attempts and the already verified F: proofs are unchanged.
