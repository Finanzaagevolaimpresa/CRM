# Operational navigation R01

The dashboard's **Apri elenco** opens the corresponding complete, filtered list.
The separate **Anteprima** link selects the three-item detail panel. Selecting the
same preview again focuses and scrolls to that panel; changing the selection
retains server navigation and current permission checks.

Both active-practice counters use `/technical-office/practices?dashboard=attive`.
The list intersects this predicate with any additional filters and applies the
existing current record and parent access checks. An invalid or repeated filter
returns no practice rows and an explicit message, rather than broadening a query.

The nine technical-office status cards are ordinary keyboard-accessible links to
their exact status filter. The list shows its current accessible count and an
explicit empty state. Navigation does not create, change or assign a practice.

## Verification

Pure tests cover the shared active predicate, exact statuses and malformed or
repeated filters. The isolated Dashboard R02 workflow retains its six PostgreSQL
checks and runs eight native browser scenarios. Added scenarios cover complete
lists, both active counters, repeated preview selection, all nine status links,
empty filters, permission revocation in an open session and responsive layouts.
All fixtures are synthetic and remain inside the ephemeral CI database.

This increment changes no schema, dependency, provider, scheduler or grant.
Project editing, project-to-practice handoff, assignment-outcome reconciliation
and reminder delivery are separate increments; this navigation change does not
claim to complete them. A production release still requires exact-candidate CI,
independent review, an exact-merge image and its own authorized release plan.
