# N04 — Privacy, Consent & Data Classification Foundation v1

N04 introduces a dormant, fail-closed privacy foundation. It does not activate the website connector, alter WordPress/WPForms, publish an information notice, enable AI/provider traffic, send customer communications, or assign historical consent semantics. Migration 35 creates empty registries: production seed does not create notice versions or evidence.

## Contract

The website lead receiver accepts only the strict `website_lead_intake_v2` contract. In addition to the existing lead fields, every request must explicitly provide:

| Area | Required fields | Fixed semantics |
| --- | --- | --- |
| Origin | `sourceSystem`, `formCode`, `formVersion`, `submittedAt` | No inferred source or timestamp |
| Service/privacy notice | `privacyAccepted=true`, `privacyNoticeCode`, `privacyNoticeVersion`, `privacyPurposeCode`, `privacyLegalBasisCode` | Purpose `SERVICE_REQUEST_FOLLOW_UP`; basis `PRE_CONTRACTUAL_MEASURES`; evidence is an acknowledgement, not marketing consent |
| Marketing | `marketingAccepted` (explicit `true` or `false`), `marketingNoticeCode`, `marketingNoticeVersion`, `marketingPurposeCode`, `marketingLegalBasisCode` | Purpose `DIRECT_MARKETING`; basis `CONSENT`; absence is invalid and `false` is stored as a denial |

The referenced notice versions must already exist in `PrivacyNoticeVersion`, be `ACTIVE`, match purpose, legal basis and evidence kind exactly, and be effective at `submittedAt`. Unknown fields, missing fields, unregistered versions and mismatched semantics are denied. The current production configuration remains dormant and the registry remains empty, so no new acquisition is enabled by N04.

Privacy acknowledgement and marketing choice are written as two separate `PrivacyEvidenceReceipt` rows in the same transaction as the lead/receipt/audit effect. Evidence stores the originating form identity, source timestamp, purpose, legal basis, decision, catalog version and cryptographic digests. PostgreSQL binds the source digest to the originating website receipt and recomputes the canonical evidence hash before insert, so a forged or incorrectly bound receipt is rejected. It does not copy contact details, IP addresses, free text or notice content. Replays do not create more evidence; failures roll back lead, evidence, audit and receipt completion together.

Notice identity/content is immutable and lifecycle is monotonic (`DRAFT` → `ACTIVE` → `RETIRED`). Evidence is append-only. Withdrawal workflows, erasure, retention enforcement and DSR/DSAR are intentionally deferred to N21.

## Data classification

Catalog `n04-v1` classifies every field of:

- `website_lead_intake_v2`;
- the CRM lead projection `crm_lead_v1`;
- privacy notice and evidence records (`privacy_notice_version_v1`, `privacy_evidence_receipt_v1`);
- future AI authorization input `ai_execution_request_v1`;
- minimized external AI DTO `external_ai_payload_v1`.

Runtime inspection is fail-closed: a path absent from the selected catalog raises `UnclassifiedDataFieldError`. External AI payload rebuilding now validates the complete input before minimization, so an unclassified property cannot silently cross the boundary. This changes no AI activation state: provider, worker, dispatch and egress gates remain closed.

## Redaction and authorization

`redactAuditPayload` keeps only a small metadata allowlist, removes sensitive keys recursively, bounds arrays and text, and redacts e-mail addresses, Italian tax codes/IBANs, Italian/international phone numbers and labelled credentials/prompts in allowed text. Application audit helpers use it before persistence. Migration 35 adds the same protection as an `AuditLog` insert/update trigger and clears `ipAddress`, covering direct and legacy writers. Historical rows are not rewritten; the audit page redacts them again when rendered.

The minimized privacy registry requires `privacy.evidence.read`. Only `admin` (wildcard) and `direzione` receive it by default. Possessing `legal.read` does not grant access. The view exposes no lead identity, contact, IP or free text and has no mutation controls.

Bootstrap administration now requires an explicit `BOOTSTRAP_ADMIN_PASSWORD` of at least 16 characters and never prints the supplied credentials or administrator identity.

## Decisions requiring Legal/DPO approval

No value below is invented or seeded by N04. Before any separate connector activation, Legal/DPO and the business owner must approve and record:

1. exact notice codes, versions, rendered content and SHA-256 content hashes;
2. controller/joint-controller identity and the precise form wording;
3. the lawful basis and purpose mapping for service follow-up;
4. whether and how an explicit marketing refusal must be retained;
5. effective/retirement timestamps and the operational publication sequence;
6. retention periods, withdrawal handling and DSR/DSAR rules for N21;
7. whether form/version/source timestamps are trustworthy and how connector authenticity is maintained.

Activation must be a separate change with connector contract tests and a WordPress rollback plan. Placeholder values in README examples are illustrative only and must never be promoted as validated notice identities.

## Migration and rollback

Migration 35 is additive and contains no data backfill. It creates two tables, three enums, constraints, indexes and validation/redaction triggers. Qualification covers a fresh 1→35 chain, a 1→34 then 35 upgrade, and the exact PR90 application running against schema 35.

Migration-first rollback is application-only: keep migration 35 and its empty/new registries applied, close the integration gates, and restore the approved PR90 image. Do not use a down migration, `DROP`, `TRUNCATE`, manual reinterpretation or synthetic backfill in production.
