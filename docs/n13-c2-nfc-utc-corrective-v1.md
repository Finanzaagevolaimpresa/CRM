# N13-C2 — NFC Identity and UTC Evidence Corrective v1

## Scope

N13-C2 corrects two dormant N13 defects without enabling projection, duplicate resolution or
business traffic:

1. raw `Lead` prefilters now apply the same NFC normalization already declared by `n13-v1`;
2. `PrivacyEvidenceReceipt.sourceSubmittedAt` is explicitly stored as `TIMESTAMPTZ(3)` and the
   privacy-evidence trigger derives one UTC wall timestamp independently of the PostgreSQL session
   `TimeZone`.

Migration 40 remains byte-identical with SHA-256
`234f574703ec81f7ab0b43c0854a1dab3264c8462e6ccb1f0d0b92f288415c78`.

## Migration 41

`20260822150000_n13_c2_nfc_utc_corrective_v1` is one fail-closed, business-empty transaction. It:

- verifies that `sourceSubmittedAt` is exactly `timestamp(3) without time zone`, `NOT NULL`;
- aborts with `N13_C2_SOURCE_TIMESTAMP_ROWS_PRESENT` if any evidence receipt exists;
- changes the empty column to `TIMESTAMPTZ(3)` and verifies the catalog postcondition;
- adds `Lead_active_email_n13_nfc_idx`;
- adds `Lead_active_person_name_n13_nfc_idx`;
- adds `Lead_active_company_name_n13_nfc_idx`;
- replaces `privacy_evidence_receipt_validate_v1()` with the same contract and one canonical
  `AT TIME ZONE 'UTC'` conversion.

The `USING` clause is reached only when the table is empty; existing rows are never reinterpreted
or backfilled. Type drift, nullability drift or any receipt stops the whole transaction before
index/function changes can persist. The migration does not insert, update or delete business data.
It creates no key, gate, worker, consumer, schedule or activation. The three legacy expression
indexes remain present for PR107 N-1 compatibility. `NORMALIZE(..., NFC)` requires PostgreSQL
server encoding `UTF8`, which is asserted by database qualification.

Expected catalog after migration 41:

| Object | Expected |
| --- | ---: |
| finished migrations | 41 |
| N13 tables | 6 |
| N13-qualified indexes | 39 |
| N13 triggers | 12 |
| `fai_lead_*n13_v1` guard functions | 5 |
| N13 business rows after deploy | 0 |

## NFC contract

The following raw predicates use `LOWER(NORMALIZE(..., NFC))`:

- candidate email;
- candidate first and last name after trim/whitespace collapse;
- candidate company name after trim/whitespace collapse;
- manual-create strong email precheck.

Phone normalization, identity digest input, key version, ranking and `LEAD_NORMALIZATION_VERSION`
remain unchanged. Canonically equivalent precomposed and decomposed strings must enter the same
candidate set. Distinct strings must remain distinct.

## UTC contract

Prisma declares the native type explicitly:

```prisma
sourceSubmittedAt DateTime @db.Timestamptz(3)
```

The trigger derives the UTC wall timestamp once:

```sql
source_submitted_at_utc := NEW."sourceSubmittedAt" AT TIME ZONE 'UTC';
```

All three renderings and both active-notice comparisons use the resulting `TIMESTAMP(3)` value.
There is no mixed comparison between notice timestamps without timezone and the source instant.
The same valid evidence must be accepted under `UTC`, `Europe/Rome` and `America/New_York`,
across spring-forward and fall-back DST boundaries. A genuinely altered `occurredAt` by one
millisecond or an invalid `evidenceHash` remains rejected. The existing trigger stays bound to the
replaced function.

## Qualification and rollback

Required qualification includes fresh 41, exact empty 40→41 upgrade, existing-receipt atomic
failure, migration-40 checksum pin, catalog type/expressions, Unicode candidate/manual-create
races, isolated session-timezone/DST invariance, full unit and PostgreSQL suites, typecheck, lint,
build, Docker smoke, restore drill and PR107-on-DB41 N-1.

The application rollback target is PR107 on DB41 in dormant/health-only mode. It must not receive
N13 business traffic because PR107 does not contain the NFC application correction. There is no
automatic down-migration or restore. Key provisioning, consumers, traffic and activation require
separate mandates.
