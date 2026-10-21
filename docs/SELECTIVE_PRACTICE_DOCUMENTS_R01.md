# Selected document versions for technical practices — R01

Candidate extension of the personal practice-sharing decision. Not production activation.
Baseline: 64d8f4e4d761fdae6429f019f249f8f1fb3c55be (schema59).

## User flow

The bound personal Admin opens Technical office → Practices → Share selective access.
They choose an existing person, zero or more practice fields and exact document versions.
At least one field or version is required. Each file has a separate download choice,
off by default. Preview identifies the recipient, selected fields and versions, expiry
and replacement of prior practice access. Confirmation requires fresh personal step-up.

The confirmed, signed V2 selection is the explicit association between this technical
practice and the exact versions. Its immutable revision, command receipt and minimized
audit are persisted in one transaction. A common client, project or service never
creates access by itself. PracticeReadiness IDs are not TechnicalPractice IDs.

The recipient sees only the selected practice fields and versions on Shared practices.
Authenticated private routes recheck the decision, context, session, recipient,
permissions, exact version and bytes before returning inline content or a permitted
download. Viewing delivers bytes and cannot prevent screenshots or copies already
made. Revocation prevents later openings, not recall of an acquired copy.

## Scope and invariants

- Up to 20 explicit versions, PDF/PNG/JPEG/UTF-8 plain text; maximum 25 MiB per file.
  No wildcard, future-version inheritance, upload, edit or new provider.
- Source document belongs to the same client; any project/service binding must match
  the technical practice's canonical project/service. The personal decision records
  the exact practice association; no fake client or practice is created.
- Independent parent/sibling permissions remain independent. A practice selection
  does not silently grant or revoke an existing client/project selection.
- Contracts, payments and their canonical linked documents remain restricted to
  Admin and Amministrazione, even with explicit allow overrides for other roles.
- Current sensitive-document restrictions, lifecycle, perimeters, explicit denials,
  version checksum and monotonic document/context generations are enforced.
- Metadata change followed by restoration does not revive an old decision. New
  versions require a fresh personal choice. Archived practice/parent blocks reading;
  explicit revocation remains possible and does not revive ordinary access.
- V1 decisions without documents remain byte-compatible. No existing binding is
  changed and no user is automatically enrolled. Existing practice-sharing authority
  is reused.
- Success audits contain only version/grant/revision identifiers. Denied bytes and
  a failed audit produce no successful read. Receipt recovery does not resend a
  command after a lost response.

## Schema and production boundary

New migration: 20261021110000_selective_practice_documents_v1.
SQL SHA256: 3c5be559feca7757ed3e3e9ff56a312489303b896f5a984cc99c571cbc3be791.

Schema59 → schema60 modifies the practice payload CHECK and deferred atomic validation,
and adds a V1/V2 payload validation function. It creates no tables, business rows,
documents, grants or authorities. Prisma datamodel remains unchanged.

Historical qualification applies schema59 from the integrated baseline before testing
the exact new SQL. The new CI qualifier preserves populated V1 practice grant, command,
revision and audit plus all other rows and migration checksums, injects failure before
commit, verifies rollback of the constraint/functions, verifies replay denial and
unchanged datamodel drift. DB access is restricted to CI's marked ephemeral database.

Production remains schema59 until exact-head CI, independent PASS, concrete release
plan and specific human authorization of this SQL/target. No authorization for schema60
is inferred from PR207. Future cutover must suspend/resume only the existing inbound
service, preserve cursor/history and qualify the exact merge image. Recovery admits
only compatible schema60 code with document selections, generations and uncertain
email attempts retained. No down-migration, new backup or database restore is qualified.

## Qualification

The candidate workflow retains 43 existing practice DB scenarios and adds 17 document
scenarios: 60 in total. Native tests retain 9 existing flows and add 5 document flows:
14 in total, including actual PDF and PNG rendering, stale confirmation, role change,
download denial, sibling-practice denial, revocation with an open session and responsive
screenshots. No production record is a fixture.

PR140 package tests retain live/revoked V2 selected files and legacy V1 fields across
candidate/restart/resume, compare exact file bytes and persistent state, and reject
unselected/sibling URLs and nonapproved downloads. These are planned CI assertions;
a passing result is attributed only to its actual source/tree and run, not this document.
