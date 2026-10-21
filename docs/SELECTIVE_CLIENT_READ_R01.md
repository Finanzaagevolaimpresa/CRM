# Selective client access — candidate R01

The schema59 extension for personally selected document versions is described in [SELECTIVE_CLIENT_DOCUMENTS_R01.md](SELECTIVE_CLIENT_DOCUMENTS_R01.md). The text below preserves the original schema57 boundary and its qualification history; later evidence must identify its own exact commit.

This increment gives the personally bound Admin a client-specific selection, preview, expiry and revocation workflow. The recipient reads only explicitly selected scalar fields at `/shared-clients/[id]`. The initial closed catalogue is `displayName`, `type`, `status`. Notes, tax identifiers, contacts, companies, people, documents, practices, payments and write/upload operations are not in this catalogue.

The local preparation snapshot in `SELECTIVE_CLIENT_READ_PREPARATION_R02.md` is historical. This document describes the integrated schema57 candidate; qualification results must identify the exact source commit and tree. PR200's frozen release and enrollment receipts remain separate.

## Personal authority and exact decision

`SelectiveClientAuthority` uses its own `client-sharing` binding. Project, lead and email authorities and another account's Admin role do not establish this authority. Management requires the current active canonical Admin, registry session and current permissions. Confirmation and revocation require enforced step-up tied to the real session token. A GET or preview never creates authority or access.

Client-specific HMAC domains bind the selected fields, recipient, client, expiry, command, prior revision, authority revision, actor/recipient generations and current client generation. Changed content, ownership, activity, identity, permissions or expiry invalidates an old preview. An identity/permission change followed by restoration does not restore an old grant.

Commands, immutable history, current grant and minimized audit commit together. Exact command replay returns the same receipt; incompatible replay is rejected. The browser preserves the command ID before submitting and offers receipt reconciliation after a lost response, without automatically resubmitting a decision. Audit records contain version, operation and field count, not selected values, recipient addresses or private notes.

## Ordinary access and related records

A historical selective-client record is an exclusion from ordinary full-client access, even when revoked or expired. It is evaluated before broad roles, current ownership or legacy `ClientReadGrant`. The latter may still be revoked, but cannot be newly activated for a selected client/recipient. Other independent clients retain their existing access.

| Surface | Enforcement in this candidate |
| --- | --- |
| Native manager and recipient | `selective-client-access.ts`, `selective-client-actions.ts`, native sharing form and shared-client routes reread current authority, registry, record, history, audit and receipt. |
| Lists, direct client routes, search and counters | `core-query-policy.ts` excludes historical recipient selections in the database query; `access-control.ts` applies exclusions before ordinary roles or grants. |
| Companies, people, converted leads, projects/services | `selective-client-scope.ts` builds an identifier-only graph loaded with current session admission; access-control, company people, responsibility and assignment surfaces consume it. Lead predicates also check the current client context, including a lead linked after the graph was loaded. |
| Documents, finance, dossiers, practices and communications | The graph adds associated resource identifiers to the existing scoped checks. Selected-client access itself never authorizes these child resources. Current and proposed client identities are checked for reassociation. |
| AI, notifications and audit children | Scope includes linked request/run/job, decision, delivery and audit entity IDs. UUID query domains remain separate from text IDs. Scoped records do not become AI context or notification content merely because three client fields were selected. |
| Writes and pending operations | `project-resource-guard.ts` reloads actor and linked client contexts inside the transaction under the recipient lock. Legacy company/project creation now uses that transaction for both write and audit. Full-client perimeter changes acquire directory and ordered user locks before session admission. |

Read admission is refreshed per request; copies already delivered cannot be recalled. The identifier graph is not a substitute for current authorization. Concurrent read/write behavior is subject to the PostgreSQL and native browser qualification below, not established by pure predicate tests.

## Schema57 and enrollment

`20261018190000_selective_client_read_v1` is additive on the exact schema56 predecessor. It adds `User.selectiveClientEpoch` and four initially empty tables: authority, grant, command and revision. Restrictive foreign keys, immutable history, increasing generations and deferred transaction consistency enforce the storage contract. It creates no personal authority, recipient or grant.

The binding in `scripts/selective-clients/schema-binding.json` pins the schema, SQL and main baseline `2734f1b548efa973c7a1c78661fb901b8edde743`, tree `52cf37cf12faa259d6e01edee45a9032e5e4e44a`. All 56 historical migrations must remain identical. Email activation and exact-schema qualification recognize schema57; no email provider, dispatcher, cron or recipient is created by this increment.

`ops/selective-client-authority-enrollment.sql` requires a separately authorized exact database/profile/approval binding, current schema checksums and an empty initial authority state. Its qualification checks the audit **after the actual canonical N04 trigger**, using the persisted `approvalHash` key. The future lead enrollment template is updated to the same audited convention and schema57 admission; PR200's frozen template and already committed enrollment must not be rerun.

Production requires a reviewed exact-source release plan, explicit migration57 and client-binding approval, current drift/invariants, schema57-compatible image and recoverability. No down-migration or fallback to schema56 code is allowed. No new backup, restore, credential, grant or real email is included.

## Qualification implemented

- Pure policy, proof, preview, selected access and identifier-graph tests use synthetic fixtures. They are not PostgreSQL concurrency evidence.
- The selective-client workflow requires 28 PostgreSQL tests with no failure or skip: no GET enrollment, exact operational SQL and N04 audit, selected-only output, stale decisions, session/role/permission changes, atomic audit failure, expiry/revocation, late-linked leads, legacy full-grant exclusion, receipt recovery, concurrent decisions and current actual company/project actions.
- Company/project action tests execute extracted, unchanged application function bodies with only the cookie boundary and transaction scheduling supplied by the harness. They verify the real permission checks, resource locks, writes and audit, including a decision committed after a precheck and a write already holding the recipient lock.
- Three native browser scenarios cover preview/confirmation, selected fields and ordinary denials, open-session revocation, lost-response receipt reconciliation, revoked confirmation session, and desktop/mobile screenshots. List routes without a corresponding populated fixture are smoke coverage, not proof of a populated child-resource denial.
- The additive migration qualifier starts from populated archived schema56, compares every legacy table, injects failure before COMMIT, checks rollback and empty new tables, preserves all 56 checksums, checks restrictive foreign keys and rejects replay.
- PR140 adds synthetic live/revoked client selections to source/image qualification, database footprints and native browser checks before restart, after restart and after resume. No old incompatible image is used as recovery.
- Existing lead/project/lifecycle/email/update/video and full CI regressions remain required on this candidate. Historical qualification results are not attributed to the new HEAD.

Local typecheck and lint passed during preparation. Targeted pure tests passed; the full Windows test run is not a PASS (Unix tooling/line-ending/platform assumptions remain, and the N15 migration-filter expectation was corrected). Local Turbopack build was denied creation of its Prisma junction. Linux CI build, PostgreSQL, native browser, screenshot inspection and image recovery remain pending until their exact-commit results are acquired.

## Remaining scope

This increment does not complete field-level sharing for all client information, practice sharing, edit/upload permissions, Stella, WhatsApp or the three remaining communication flows. Those remain distinct work after this read-only client increment. It does not correct or erase the unrelated manually declared email outcome.
