# N05 recovery kit — explicit operations and isolated recovery

This kit prepares a **one-time recovery operation**. A successful synthetic drill
does not establish that a real backup is recoverable, create an off-host copy, or
authorize a production action. The ordinary release gate, existing N05 backup
confirmation, legacy provenance checks and restore drill remain applicable.

The initial implementation recovers PostgreSQL and document bytes, and decrypts
configuration and cryptographic material into separate private directories. It
**never starts the CRM application**, runs a consumer, sources recovered environment
files, or installs recovered keys. It creates no application service or network.
PostgreSQL and document helpers use network mode `none`, no published ports, a
read-only root filesystem, dropped capabilities and no Docker socket. Its temporary
PostgreSQL Unix socket directory is writable inside its private tmpfs; this is not
a permission change to key files or document storage.

## Operating boundary and prerequisites

- Linux x86-64, Python 3.11+, GNU tar, Git, Docker Engine with a local Unix socket,
  Docker Compose v2 for backup, OpenSSH and official **age v1.3.2**.
- The target PostgreSQL image is PostgreSQL **16**, identified by immutable image
  ID. Both that image and the application source image must already be available.
  The application image is inspected for provenance, never rebuilt or started by
  the recovery command.
- Run from the approved tool checkout. Plans bind tool commit, tree and program
  digest; the scripts and canonical Compose files must match their committed bytes.
- Operation directories and supplied coverage directories must be owned by the
  executing UID with mode 0700; files must be regular, owned by that UID, mode 0600,
  without hardlinks or symlinks (including ancestors). Paths must be absolute.
- Plans, journals, decrypted files, bundles and custody material belong outside
  tracked files. Work roots must be outside the tool checkout. A source or identity
  cannot live inside the operation directory that cleanup may remove.
- Source identifiers, recipient, SSH endpoint/host key, destination host/root,
  Docker engine ID, application image provenance and expected backup hashes must
  be established independently and included in the approved plan. A hash received
  through the same untrusted channel as a file does not authenticate that source.
- Quiescence, approved destination capacity, access controls, custodian availability
  and retention remain prerequisites. Stop competing configuration/backup edits in
  the approved window. This kit neither grants a window nor automatically stops a
  source application. Do not change the production timer to bypass confirmation.

`protect` and `transfer` may run at the source host during a separately authorized
operation. `receive` and `recover` reject the known production host; recovery also
rejects a Docker engine named as that host and demands the separately pinned engine
ID. New target names are derived exclusively from a random run ID. Existing
containers or volumes are refused, even when stopped or empty.

A native Windows directory, an SSH service, a Linux VM, WSL storage and Docker
Desktop storage are different destinations. This Linux kit does **not** qualify a
proposed directory on an operator's PC, its ACLs, encryption at rest, independent
custody, disk durability or restore capacity. Those require a concrete destination
decision and a separate verification before real data is copied.

## Three identities and three coverage components

Keep distinct:

| Binding | Meaning |
| --- | --- |
| Tool commit/tree/program hash | Exact operational code executing this plan |
| Source commit/tree/application image ID/provenance | Release represented by the original N05 set |
| Manifest hash + SHA256SUMS hash + encrypted bundle hash/size | Exact backup and copy being handled |

An older application image is not relabelled as the newer tool commit. Neither an
N05 manifest nor its source environment/sentinel is rewritten to make recovery
accept it. The existing `verify-backup-manifest.sh` validates the original set;
target isolation has its own independent identity and labels.

The encrypted bundle contains three separate age ciphertexts:

1. `database-documents.age`: the original four N05 files, unchanged.
2. `configuration.age`: an explicitly prepared private configuration snapshot.
3. `cryptographic-material.age`: an explicitly prepared private key snapshot.

A DB/document backup alone covers neither configuration nor key custody. The kit
does not discover or collect live secrets. Preparing those separate snapshots,
their consistency, storage and custody require explicit authorization for real
material. Empty placeholder directories are rejected. No private material belongs
in a PR, a CI artifact, a public issue or a command argument.

## Commands and exact private plan fields

Run `python3 -B scripts/n05/recovery_kit.py identity` to obtain the tool binding and
host identity. `inspect-component --directory /absolute/private/snapshot` returns
only a digest of the sorted relative-file/digest inventory, file count and byte
count. It reads that explicitly selected component without displaying its contents
or file names. Record separate digests for configuration and cryptographic material.

Every JSON plan has these exact common keys (unknown keys and duplicate JSON keys
are rejected):

| Key | Value |
| --- | --- |
| `schema` | `FAI_CRM_N05_RECOVERY_KIT_V1` |
| `phase` | `backup`, `protect`, `transfer`, `receive` or `recover` |
| `data_class` | `synthetic` or `production`; descriptive, never authorization |
| `run_id` | New lowercase 32-hex UUID, also the private journal directory name |
| `host` | Exact local hostname |
| `work_root` | Existing absolute private directory |
| `tools` | Object with exact `commit`, `tree`, `program_sha256` |

The `expected` source object has exactly `environment`, `project`,
`source_commit`, `source_tree`, `app_image_id`, `image_provenance`,
`resource_provenance`, `migration_count` (43), `manifest_sha256`, and
`checksums_sha256`. Pin the hashes of **both** MANIFEST.txt and SHA256SUMS; the
latter binds the database and document archive digests. Provenance values are
those accepted by the existing N05 verifier, not free-form claims.

Additional exact keys by phase:

| Phase | Additional fields |
| --- | --- |
| backup | `environment`, `env_file_sha256`, `app_env_file_sha256` |
| protect | `backup_set`, `expected`, `recipient`, `configuration_dir`, `cryptographic_dir`, `configuration_sha256`, `cryptographic_sha256`, `output` |
| transfer | `bundle`, `bundle_sha256`, `bundle_bytes`, `recipient_sha256`, `ssh` |
| receive | `bundle_sha256`, `bundle_bytes`, `recipient_sha256`, `sender_host`, `program_sha256` |
| recover | `bundle`, `bundle_sha256`, `bundle_bytes`, `recipient`, `identity_file`, `expected`, `engine_id`, `postgres_image_id`, `target_project` |

The backup `environment` contains only N05's existing explicit variables
(see `ENV_KEYS` in the tool). It must provide absolute ENV_FILE/APP_ENV_FILE
paths, exact source/image/resource provenance, database identity, 43 migrations
and a unique backup set name. The production route calls
`scripts/backup-docker-prod.sh` and still requires
`CONFIRM_PRODUCTION_BACKUP=FAI_CRM_PRODUCTION_BACKUP_V1`.
Nonproduction qualification permits only the existing restore-source identity.
Shell environment overrides are not inherited. The canonical Compose files and
the two supplied environment file hashes are checked; no arbitrary Compose
override is accepted.

The transfer `ssh` object has exactly: `host`, `port`, `user`,
`known_hosts`, `known_hosts_sha256`, `identity_file`, `remote_program`,
`remote_plan`, `remote_plan_sha256`, `receiver_host`, `receiver_run_id`,
`receiver_work_root`. Use a pre-existing, separately authorized SSH access path.
No agent, forwarding, user SSH configuration, password prompt or host-key
auto-acceptance is used. The remote receiver program's digest and private receive
plan must be delivered and reviewed before transfer. The receiver supports this
one pinned receive operation and does not need a copy of the Git repository.

The age recipient is an explicit X25519 public recipient. The private identity
file is separate from encrypted copies. Do not place custody keys in the bundle
they decrypt, share them in logs, or conflate the test identity with real custody.
Passphrase/interactive modes and age plugins are deliberately not selected here.

For recovery, `target_project` must equal `fai-crm-recovery-` plus `run_id`.
The kit allocates new database/document volumes and refuses occupied names.
It decrypts and checks all archives before allocating those volumes, restores the
database in a single transaction, rebuilds constraints and indexes, checks the
43 migration names/checksums against the image's source commit, and compares every
document file digest internally. It does not output customer records or filenames.

Private functional plan examples are exercised in `tests/n05/recovery_drill.py`.
They are synthetic fixtures, not preapproved production plans.

## Preflight, authorization, verified result

Pin the plan's SHA-256 separately, then run:

```sh
python3 -B scripts/n05/recovery_kit.py preflight \
  --plan /absolute/private/plan.json --plan-sha256 <approved-plan-sha256>
```

Preflight creates no operation journal or backup set. Backup preflight requires
the same identity and current quiescence checks as creation. It neither quiesces
the application nor grants authorization.

After actual authorization for that exact phase, supply its technical interlock,
for example `--authorize FAI_CRM_N05_RECOVERY_PROTECT_V1`, with command
`protect` and the same pinned plan. Other phases use their own uppercase phase
name. These strings are **not** evidence that a human approved production work.
There are no permanent confirmations, timer changes or examples with lead gates enabled.

The kit emits only structured status, phase codes, counts and non-secret
identifiers. Journals record intent before resource allocation and retain
verified Docker identities. The receipt binds receiver host/root/run/program,
plan hash, ciphertext byte count/hash and recipient hash. Receipt of ciphertext
does not prove decryption or a successful database restore.

## Failure, resume, stop and cleanup

| Observation | Required action |
| --- | --- |
| Preflight rejected | Correct the cause within authorization; changed plan requires a new hash/approval. No target operation started. |
| Backup failure | Inspect N05 outcome and the journal. N05 removes its own unpublished partial set. Preserve any published set; use a new set/run identity if retry is needed. Never overwrite a set or invent a successful receipt. |
| Protection failed | No success is claimed. Keep source snapshots and journal. The authorized cleanup command can remove only this operation's incomplete plaintext. A published output is retained; use a new run/output for a fresh attempt. |
| Transfer interrupted or acknowledgement lost | Inspect status at both ends. Use `transfer --resume` with the identical plans and hashes. The complete stream is retransmitted, not appended to an uncertain partial. Receiver retains old partials and never replaces changed or foreign content. |
| Recovery interrupted/failed | Do not reuse a partial database. Inspect the journal, authorize cleanup of that attempt, then use a new run ID and new empty destinations. Source set, ciphertext and custody material remain unchanged. |
| Recovery verified | Record receipt and checks. Confirm application was never started. Preserve ciphertext and custody; explicitly authorize cleanup of recovered resources. |
| Identity or ownership changed | Stop the affected cleanup or resume. Do not override labels, force a destination or delete another resource to make the run pass. |

`status` with the same plan/hash reports the last journal phase, not a freshly
repeated recovery test. Ctrl-C/SIGTERM records failure when possible; abrupt
host/process loss may leave the last intent as the final record. Such an intent
is not success. Receive operations have a bounded wait and hold an exclusive
operation lock.

`cleanup --authorize FAI_CRM_N05_RECOVERY_CLEANUP_V1` with a recovery plan removes
only its recorded/labelled containers and volumes after identity checks, plus
decrypted material under its private operation root. It preserves the original
set, encrypted source, custody identity and append-only journal. Protection,
transfer and receive cleanup remove only their incomplete local files, preserving
published ciphertext and receipts. Backup cleanup is intentionally not exposed:
N05 owns its partial-set lifecycle.

No down-migration, ledger deletion, destructive restore onto a pre-existing
volume or ordinary data rollback is provided. Closing a gate does not undo
persisted records. No source application is stopped or resumed by this kit.

## Qualification and limits

The test runner prepares official, digest-pinned dependencies before entering an
internal test network. The orchestrator requires Docker API authority to exercise
the actual primitives. Its Docker socket is never mounted into source application,
receiver, recovered PostgreSQL or document helper containers. A minimized test
context retains the original commit/tree objects and only needed blobs; it copies
neither local Git configuration/history nor protected files. It is not a complete
repository archive or a substitute release artifact.

Run guard tests with `python3 -B tests/n05/test_recovery_kit.py`. The separate
`n05-recovery-kit` CI job builds a real baseline application image, runs actual
Prisma migrations and N05 backup, uses age and pinned SSH, tests tampering and
occupied destinations, checks recovered relational/document contents and cleans
its resources. A newly generated production-format **synthetic** manifest tests
preservation of source production identity; it is never presented as a real
production backup or as an execution of the production backup wrapper.

Ordinary N05 restore/rollback and all existing CI suites remain unchanged and
mandatory, including A05 and VNX-03. Passing this kit validates only its tested
procedure. A separately authorized real-set drill must establish data-specific
recovery, the exact target/custody/window and the fresh backup needed before any
future intervention. No application-level login, document download, key-parser
activation, integration delivery or production recovery is implied by this
database/document drill.

