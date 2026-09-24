# R05 M1 — controlled intake enters the administrative queue

This increment follows PR147 at `5fe601fd677ece3f5bd08d81fa5bdd461490da3c`.
It closes the controlled-intake ownership exception documented in that PR;
the remaining M1 department, acceptance, origin and continuity work is separate.

## Behavior

All four controlled channels create a lead with no assignee, including when an
administrator registers the request. Source metadata, catalog classification,
financial-reference checks, duplicate candidates and N14 enrollment are retained.
Registration never accepts an ownership field from the server-action payload.

An operator receives only the queued receipt identifiers and flag; the HTTP
action redirects to a generic registration confirmation. This receipt confers no
right to list, edit, classify or inspect the queued request. An identical retry
from its actual creator returns the same minimal receipt while the lead is still
unassigned. Another operator cannot replay it. A changed payload conflicts, an
archived lead is denied, and reassignment to another person revokes the creator's
replay access. The service locks and revalidates the actual registry session.

Administrators may inspect the unassigned record. After explicit assignment,
the current operator may read and work on it, including duplicate decisions and
classification. Authorized replay still filters duplicate candidates against
current access. Neither registration nor assignment records an operator's
acceptance; that distinct M1 feature remains to implement.

## Verification

The PostgreSQL qualification retains its four-channel, catalog, financial,
archive, concurrency and rollback cases. Positive operator fixtures now receive
an explicit administrative assignment. Added checks cover minimal receipts,
foreign and changed retries, hidden administrator updates, forged ownership,
and an administrator's own unassigned registration.

The browser qualification registers all four channels as a commercial operator,
checks the queued confirmation and an identical HTTP retry, verifies absence
from the operator's list, then assigns each request through the administrator's
real N14 UI with enforced step-up. The original operator's already-open session
sees the record only after assignment and loses it after reassignment. Existing
classification, duplicate-decision and direct HTTP permission-denial tests remain;
an altered creation form cannot establish ownership.

The controlled-intake CI job alone provisions an ephemeral privileged key and
synthetic administrator. No production configuration or key is read or changed.
Local checks supplement canonical CI; local tsx and Playwright limitations remain
documented by PR147. No test result is presumed before the candidate run finishes.

## Compatibility and release boundary

No migration is added; all 47 historical migration files remain unchanged.
The internal TypeScript creation result adds a minimal queued-receipt branch.
The sole production caller handles that branch explicitly; authenticated 1265
classification retains its separate assigned-scope contract. Historical records
and assignments are not rewritten. Existing gates remain necessary; this change
does not activate a controlled intake, connector, dispatch, provider or worker.

A software revert does not change previously stored records and would again
allow implicit ownership on later controlled registrations. Any operational
rollback must account for that weaker policy. This software delivery does not
qualify production or authorize new execution; prior specific authorizations
remain bounded by their scope, target and gates. R06 evidence, the two consumed
backup attempts and the already-completed F: checks are preserved.
