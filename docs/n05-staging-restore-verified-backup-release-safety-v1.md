# N05 — Staging, Restore-Verified Backup & Release Safety Foundation v1

N05 introduces a repository-only, dormant release-safety foundation. It does not create remote staging, read or copy a production backup, change production configuration, deploy, migrate production, enable a feature gate, or authorize Ready/merge. The migration count remains **35**.

## Audit result

The pre-change audit found five concrete gaps:

1. staging existed only as narrative guidance and had no non-overlapping Compose identity;
2. the production backup script defaulted to the production project and produced no manifest or checksum inventory;
3. documented restore examples used `pg_restore --clean` and direct tar extraction without provenance or traversal checks;
4. release identity was not bound in one gate across Git commit/tree/parents, CI SHA, image ID, backup and rollback image;
5. the existing Docker smoke proved packaging and dormant gates, but not a complete database-and-document restore or N-1 application rollback.

## Environment contract

Every N05 operation requires an exact environment tuple before mutation:

| Environment | Sentinel | Project identity | Compose file |
| --- | --- | --- | --- |
| production | `FAI_CRM_PRODUCTION_V1` | exactly `fai-crm` | `docker-compose.prod.example.yml` |
| staging | `FAI_CRM_STAGING_ISOLATED_V1` | `fai-crm-staging-*` | `docker-compose.staging.example.yml` |
| restore source | `FAI_CRM_N05_RESTORE_SOURCE_V1` | `fai-crm-restore-*-source` | `docker-compose.restore-drill.yml` |
| restore target | `FAI_CRM_N05_RESTORE_TARGET_V1` | `fai-crm-restore-*-target` | `docker-compose.restore-drill.yml` |

Missing, unknown or mismatched values stop before Docker mutation. Compose paths must resolve to the canonical files in the checked-out repository; a different file with the same basename is rejected. Non-production guards reject `/opt/fai-crm`, `.env.production`, `desk.finanzaagevolaimpresa.it`, production volume names and `fai-crm:pr*` tags. Staging uses a distinct database, document volume, network, cookie, port and origin. No production resource is an allowed fallback.

`docker-compose.staging.example.yml` is a configuration example only. Creating a real remote staging environment, its DNS, secrets, host directories or persistent resources requires a separate authorization.

`scripts/n05/staging-preflight.sh` is read-only and must precede any separately authorized initial staging creation. It verifies the staging-only env file without printing its secrets, rejects placeholders, interpolation and secret reuse, requires the PostgreSQL service hostname and expected staging database, confirms all feature/provider/website gates are closed, validates the Compose services/volumes/image and proves the project has no pre-existing resources. Compose interpolation is overridden with the already validated staging values so inherited shell variables cannot substitute production configuration. It does not create staging.

## Backup contract

`scripts/n05/backup-compose.sh` creates one complete backup set only when:

- environment identity is valid;
- the Compose services are exactly `app` and `postgres`;
- exactly one PostgreSQL service is running;
- the application is already quiesced by an authorized release procedure;
- database name, non-production database sentinel and migration count match expectations;
- source commit/tree resolve in Git, and the selected application tag resolves to the pre-authorized image ID;
- image commit/tree labels match the source identity for N05 images.

The script never stops the application and never deletes old backups. It writes into a private `.partial-*` directory, validates the PostgreSQL custom dump with `pg_restore --list`, validates the document archive, writes `MANIFEST.txt` and `SHA256SUMS`, re-verifies the complete set and only then atomically renames the directory. A document failure invalidates the whole set; a database-only partial backup is not a release backup.

The manifest contains only technical metadata:

- schema and environment sentinel;
- Compose project;
- UTC creation time;
- `application-quiesced` consistency mode;
- source commit/tree, application image ID and provenance mode;
- applied migration count;
- fixed database/document filenames.

It never contains database URLs, passwords, tokens, personal data, document names from the CRM or environment values. Retention/deletion is deliberately outside the backup script and must be a separately scoped operation.

`scripts/backup-docker-prod.sh` is now an explicit production wrapper. It requires a fixed confirmation phrase, immutable image tag and pre-recorded image ID, source identity, backup root/set and expected database name. The normal provenance mode is `oci-labels`. The one-time `authorized-legacy-image-id` bridge is restricted to production images created before N05: it requires an exact authorized image ID, a commit-bound tag, a Git-resolved source tree and absent provenance labels. It cannot be used by staging or restore drill images. The wrapper refuses to treat a running application as a consistent release backup.

## Manifest and archive verification

`scripts/n05/verify-backup-manifest.sh` fails on:

- missing, duplicate or unknown manifest keys;
- unexpected environment, sentinel, project, source commit/tree, application image ID/provenance or migration count;
- symlinked directories/files;
- extra or missing checksum entries;
- checksum mismatch;
- empty archives, absolute paths, `..`, backslashes, duplicate separators, special files, symlinks or hard links.

Archive validation runs before extraction. Restore uses `--no-same-owner` and `--no-same-permissions` into an empty, newly created document volume.

## Synthetic restore drill

`scripts/n05/restore-drill.sh` is the CI qualification entrypoint. It uses synthetic values only and performs this sequence:

1. validate current and authorized N-1 Git commit/tree;
2. resolve unique source/target project names and refuse pre-existing resources or image tags;
3. prove that a production project identity is rejected;
4. build the current application image with a unique commit-bound tag and record its image ID;
5. create a source PostgreSQL service and apply exactly 35 migrations without any seed;
6. add a synthetic database sentinel row and two synthetic document files;
7. create a quiesced, manifested database-and-document backup;
8. corrupt a copy and prove checksum verification rejects it;
9. validate the intact set and `pg_restore` catalog;
10. create a distinct target project with new database/document volumes;
11. restore without `--clean`, apply migrations as a no-op and verify database sentinel, migration count, dormant N01–N04 rows and document hashes;
12. start the restored application, validate health and container image ID;
13. build the authorized N-1 tree as a second immutable image, switch only the synthetic target app, and require healthy rollback without down-migration;
14. remove only containers, networks, volumes and image tags created by the drill and selected by exact project labels.

The drill never uses `docker compose down -v`, global prune, unresolved globs or production names. A failure leaves a `N05_FAILED|code=*` marker and the scoped cleanup trap runs only for validated restore project identities.

## Release gate

`scripts/n05/release-gate.sh` is read-only. A production release can pass only when all of these identities agree:

- local branch is `main`, worktree is clean and remote `main` is the authorized commit;
- commit, tree and exact parent set match the release authorization;
- CI conclusion is `success` for that same commit;
- incompatible open-PR count is explicitly zero;
- repository migration count is exact;
- immutable application tag contains the authorized commit prefix and resolves to the expected image ID;
- rollback tag resolves to the first-parent N-1 commit and a different, pre-recorded image ID;
- release and N-1 images expose the expected commit/tree labels; the explicitly declared legacy-ID bridge is accepted only when those old labels are absent;
- the quiesced production backup manifest/checksums match its deployed source commit/tree.

The gate does not build, tag, start, stop, migrate, switch or roll back anything. Passing it does not authorize deploy. GitHub PR state and CI evidence must be acquired immediately before the gate; supplied evidence is fail-closed and cannot be omitted.

## Failure matrix

| Failure | Stop point | Permitted recovery |
| --- | --- | --- |
| wrong/missing environment identity | before Compose/Docker mutation | correct explicit inputs; do not retry blindly |
| project/image already exists | before creation | inspect ownership read-only; choose a new authorized run ID |
| app not quiesced | before backup | stop and obtain an approved release window |
| dump/archive creation fails | partial set only | diagnose; partial directory is removed, no PASS |
| manifest/checksum/archive invalid | before restore | reject set; create a new complete backup |
| restore fails | isolated target only | inspect target logs/resources; never touch source/production |
| health or document/database sentinel fails | before rollback qualification | preserve evidence, diagnose, no PASS |
| N-1 rollback health fails | synthetic target only | diagnose image/schema compatibility; no production use |
| CI SHA differs from release SHA | release gate | obtain CI on the authorized SHA |
| image ID/tag differs | release gate | rebuild/tag under an authorized immutable process |

## Acceptance evidence

N05 is merge-ready only after:

- shell syntax, unit tests, lint, Prisma validate/generate, DB tests, typecheck and build pass;
- the existing production packaging smoke passes unchanged with 35 migrations and all dormant gates;
- the full N05 synthetic restore and N-1 rollback drill passes in Docker CI;
- dependency audits pass;
- complete diff review finds no unresolved P1, P2 or pertinent P3;
- the Draft PR is green on its exact remote SHA.

Skipped Docker or PostgreSQL tests are not positive evidence. Local environments without Docker can only provide non-Docker evidence; the GitHub Actions drill is mandatory.

## Permanent exclusions

N05 does not authorize a remote staging environment, production backup access, real restore, deployment, migration 36, down-migration, production secret change, WordPress work, provider/AI activation, worker/dispatch/state-machine activation, telemetry N06 or use of real/customer data in tests.
