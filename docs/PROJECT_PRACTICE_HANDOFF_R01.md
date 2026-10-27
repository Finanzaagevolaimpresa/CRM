# Project to practice preparation

The Admin project page opens **Passaggio all’Ufficio Tecnico**. Existing practices,
including links through purchased services, are listed first. Archived or trashed
practices remain visible to the authorized Admin and prevent silent replacement.
GET requests never create a practice or an assignment.

When no practice is linked, the form binds the current project and client. Current
commercial ownership and project responsibility are suggestions that the Admin
confirms separately. A signed, expiring summary binds the exact form, current
context, actor and session. Confirmation requires current permissions and step-up.

The result is only a practice in `da_progettare` with initial responsibility history.
It is not acceptance, service activation, payment qualification or presentation.
Purchased-service readiness remains unchanged. No documents, personal assignments,
access grants, tasks, notifications or email messages are copied or created.

The serializable command locks the canonical client/project and rechecks current
actors, recipients and context. Practice, initial responsibility and a minimal
audit receipt commit atomically. The existing immutable AuditLog primary key holds
the UUID command; no migration is required. A response lost after commit is resolved
by reading the original receipt. Its lookup requires the same original session and
current access. An unobserved receipt never enables a blind retry.

The command UUID is retained in the page URL before submission, without form
contents or secrets. Reloading that URL keeps creation disabled until the outcome
is reconciled. Known transaction rejection allows a fresh summary; unknown failures
retain the uncertain state. Generic project creation and purchased-service handoff
share the project lock. Multiple distinct purchased services retain their distinct
contexts; this shortcut never invents a service or duplicates an existing practice.

Qualification is isolated: strict contracts, 14 PostgreSQL cases and three native
browser scenarios, including two commercial and two technical accounts, concurrent
creation, indirect service links, revoked sessions, stale summaries, audit failure,
actual native POST replay and response loss. Screenshots cover desktop/mobile.
No synthetic fixture or real send is permitted in production.

This increment does not reconcile or repeat a real unobserved technical assignment.
It does not implement scheduled reminders. Those remain separate work items in the
operational QA matrix, subject to the existing release and production gates.
