# R05 M1 — current ownership and document provenance

This increment depends on PR149 at dd7200ea47e77e77dd9b1250a72cf0bdf0151d02.
It tightens the existing commercial, consultant and backoffice record rules;
it is not completion of M1 or qualification of production.

## Current access

Creating a client-related task, checklist or offer, or uploading a document,
records provenance. It does not grant the creator perpetual access. The current
explicit assignee or an authorized current parent context supplies access.
Reassigning a client therefore revokes the former owner's inherited access on
the next request, including from an already authenticated session. A distinct
explicit assignment on a child record remains valid until separately changed.
Historical creator/uploader fields and all stored data remain unchanged.

Backoffice no longer receives unrestricted client, service, task, checklist or
document access from its role alone. It may work through explicit technical
responsibility, with the same current-context checks used by consultants.
Technical-practice reads require current practice/client responsibility for
these three operational roles; edits require actual technical ownership.
Admin/direction retain their existing valid-context scope. Sensitive document
permission remains necessary and does not itself grant access to another client.
Truly unscoped personal records retain their existing creator/uploader rule;
assigning a personal task to another person supersedes that creator rule.

Document upload and context mutations use the shared write guard without the
former unconditional backoffice exception. Document selectors agree with that
guard. Existing detail, private-download and report routes continue to call
the canonical object policy. Client search applies scope before its preview
limit; the dashboard's offer query only admits creator-only unscoped offers.

Notifications now resolve current minimal parent/owner metadata first, then
query accessible tasks, offers and practices before preview limits. They check
the hydrated contexts before rendering. Practice communications must match the
current practice's client/project/service bindings; historical creator and
owner snapshots in a communication cannot grant access. This change does not
turn bounded notification/search previews into complete work queues.

## Verification

Unit regressions cover all three operational roles, before/after reassignment,
sensitive permission, personal records, explicit child assignment, stale
communication snapshots and missing/archived/inconsistent parents. Existing
ABAC, query parity and dashboard counter tests remain in the suite; expectations
that formerly granted unconditional backoffice/consultant access are tightened.

The account browser suite adds a real HTTP path for each operational role on
the guarded ephemeral PostgreSQL database. Each uploads a sensitive private text
file, downloads its exact bytes and exports an authorized report. A second
authenticated account is denied record pages, document/checklist lists, tasks,
search, dashboard, notifications, download and Markdown/Word report endpoints.
A captured upload with a forged foreign client is rejected without creating a
document. In enforced mode, the admin uses real step-up and the assignment UI;
the old owner's still-open session then loses the same surfaces and cannot
replay its former upload. The new owner downloads the original bytes while
creator/uploader history remains unchanged. Disabled mode covers isolation and
forged requests; it does not claim a successful privileged reassignment.

Local checks supplement canonical CI. Playwright is absent locally and the
local tsx launcher is restricted by os.userInfo; no local browser/database PASS
is inferred. Final qualification must name the actual CI HEAD/tree and results.

## Remaining M1 and release boundary

Existing reviewer/accounting read perimeters are deliberately unchanged here;
their replacement with explicit administrator-controlled scopes remains M1
work, alongside commercial origin, departments, individual acceptance and the
purchased-service route to a technician. No claim is made that this increment
completes every legacy surface or serializes every existing authorization check
against an in-flight reassignment. M2 must separately make work lists complete
and navigable beyond preview limits.

No schema or migration changes: all 47 historical migrations remain intact.
A software revert restores the old broad/provenance-based grants; it does not
alter data or reconstruct previous owners. No merge, deploy, live backup,
production mutation, provider or dormant-feature activation is included.
R06 evidence, the two consumed attempts and the completed F: proofs are retained.
