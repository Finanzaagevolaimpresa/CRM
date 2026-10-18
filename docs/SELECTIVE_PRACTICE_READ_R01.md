# Selective practice access — candidate R01

This increment lets the personally bound Admin select the fields of one technical practice for one existing internal recipient, preview the exact result, confirm with step-up, set expiry and revoke. The recipient uses `/shared-practices/[id]`. The closed catalogue contains `title`, `practiceType`, `status`, `priority`, `dueDate` and `clientVisibleStatus`. No private notes, parent details, amounts, documents, communications, editing or uploads are included.

The baseline is PR201 merge `b7f9702d32382ede9b1a43076cf4378979f01b82`, tree `81db2f264c0ea76e5d20cc73e861f6dba2182411`, schema57. Lead and client read increments remain separate completed releases. This candidate requires its own exact-source qualification and does not inherit their PASS.

## Personal decision and persistence

`SelectivePracticeAuthority` has its own `practice-sharing` binding. Another Admin, the email authority and the lead/client/project authorities cannot inherit it. Management rereads the current registry session, active canonical Admin, authority revision and actual permissions. Explicit permission denials apply to Admin too. Preview and GET create no authority or grant. Confirmation and revocation require the current step-up key and the actual session token.

The signed preview binds the exact field selection, practice, recipient, command, prior revision, expiry, session, authority, user generations, practice generation, parent context and current content. It lasts five minutes. Changes followed by restoration do not revive a prior grant. The grant is checked against its immutable revision, command, signed receipt and minimized audit before any selected field is returned.

Grant, command, revision and audit commit atomically. An exact command replay returns the same receipt; a different use of the command is rejected. A lost response is reconciled by reading the persisted receipt. The browser does not silently repeat a grant. Audit stores the operation, version and selected field count, without selected content or recipient addresses. Revocation remains possible after archive or a parent hold; new grants and selected reads remain denied in that state.

## Record and parent boundaries

A historical practice grant, including a revoked or expired one, excludes the recipient from ordinary full access to that practice. The check precedes Admin, ownership and broad roles. A practice selection does not grant or remove independent permissions on its client, project, service or sibling practices. A selected parent client/project cannot be bypassed by granting a child practice.

| Surface | Enforcement |
| --- | --- |
| Manager and recipient | Native sharing form, shared list/detail and `selective-practice-access.ts` reread registry, authority, resource, generations and signed history. Only the closed scalar projection is returned. |
| Ordinary lists, detail, edit, search, counters and parent panels | Fresh session scope supplies historical selected practice IDs. `canViewTechnicalPractice` and `canEditTechnicalPractice` deny before ordinary roles. Search also excludes legacy practice communication rows in its query. Parent pages retain their independent access while filtering the selected practice. |
| Communications, record updates and audit | `selective-practice-scope.ts` collects related communication versions, attempts, events, replies, ordinary email decisions, attachments, record-update rules/events/commands/deliveries and history identifiers for existing current-context checks. Selection never becomes email, AI or notification authority. |
| Assignments and purchased-service handoff | Assignment lists filter selected practices; responsibility mutations reread the exclusion under the user lock. Handoff checks both the existing receipt and the current practice linked to the service, including an Admin requester. |
| Ordinary pending writes | Native practice and legacy communication actions reload the registry session and the exact operation permission inside the transaction. User → client → practice locks serialize the decision against writes, ownership moves and archive. A grant after the page precheck prevents the write; a write already holding the user lock completes before a later grant can inspect its state. |

The sharing transaction locks key → directory → lead-conversion identity → authority → ordered users → session → client → practice → service → ordered projects. IDs read before locks select the lock order only; values and identity are reread after acquiring locks. Each request revalidates access. Previously delivered content cannot be recalled from a browser.

## Additive schema58 and separate enrollment

`20261018220000_selective_practice_read_v1` adds `User.selectivePracticeEpoch` and four initially empty tables: authority, grant, command and revision. It preserves the 57 prior migrations and all historical rows. Eight restrictive foreign keys and immutable/deferred consistency triggers protect the ledger. No authority or recipient is seeded.

`scripts/selective-practices/schema-binding.json` pins SQL, Prisma schema and the exact baseline. Historical migration qualifiers retain their actual prior schemas; client qualification stops at archived schema57 before this qualifier advances it to schema58. Exact-schema email guards recognize the new ledger without adding a provider, scheduler, cron or email.

`ops/selective-practice-authority-enrollment.sql` is a separate operational template requiring the exact approved target, canonical profile and authorization hash, current checksums and an empty authority state. Existing lead/client enrollment templates receive schema58 guards only; their frozen release packages and already committed enrollments must not be rerun.

Production requires the exact reviewed release plan, green CI, separately authorized migration58 and personal practice binding, fresh preflight and a schema58-compatible image and recovery path. No down-migrate, schema57 fallback, new backup, database restore, real grant or email is included.

## Qualification implemented, execution status

- Sixteen pure tests cover the closed projection, proof domains, tampering, generations, expiry, parent independence and denial before broad roles. These pass locally and do not prove PostgreSQL concurrency.
- The dedicated CI requires 43 PostgreSQL cases without skips: operational enrollment and canonical N04 audit, exact/stale decisions, replay, atomic audit failure, session and permission changes, concurrent decisions/writes, expiry/revocation, parent lifecycle/identity changes, ordinary exclusions and independent siblings.
- The actual-action harness extracts unchanged native action bodies. Only the cookie boundary and transaction timing are supplied by the test; session, permission, context, mutation and audit code execute normally. Status, archive and legacy communication draft each cover positive access, historical restriction, a grant after precheck, revoked session, revoked operation permission, a write already holding the lock and audit failure rollback.
- Three native browser cases exercise real forms, preview invalidation, exact confirmation, ordinary denial, parent/sibling access, revocation in an open session, lost-response reconciliation and a revoked confirmation session. Desktop/mobile screenshots and overflow checks cover the changed manager/recipient UI. Empty list smoke checks are not populated-resource denial evidence.
- The additive migration qualifier uses populated schema57, compares every legacy table and all 57 checksums, injects a pre-COMMIT failure, checks full rollback and empty new tables, denies replay and verifies restrictive foreign keys and Prisma parity.
- PR140 includes synthetic live/revoked practice selections and native reads before restart, after restart and after resume of the same qualified image. The image/schema/source tree and preserved rows remain required; an incompatible prior image is not a recovery option.

Local full typecheck, full lint with final targeted lint, the sixteen pure cases and corrected historical N15 migration checks pass. The full Windows test suite is not a PASS: it retains Unix tooling, line-ending and filesystem assumptions. Turbopack cannot create its Prisma junction under the local Windows permissions. Linux build, PostgreSQL, native browser, screenshot inspection and image recovery remain pending until results are acquired for the exact published commit.

## Remaining mandate

This increment closes only selected scalar reading of a practice when fully released. Additional selected fields, editing/upload operations and the three remaining communication flows require their own concrete increments. It does not correct or erase the unrelated erroneous manually declared email outcome. No real recipient grant, message or provider activation is implied by synthetic qualification.
