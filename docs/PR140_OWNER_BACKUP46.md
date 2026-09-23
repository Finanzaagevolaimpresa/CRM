# PR140: owner backup of the existing schema46 source

This package prepares the current-source backup required before a later schema47
release. It reuses the unchanged canonical N05 backup scripts. It does not deploy
the candidate, migrate the database, restore data, enable features, or repeat a
historical recovery drill.

The source is the reviewed PR139 commit `3230764a4406182e50d22236bb7e701d0f1b5656`
and its canonical 46-migration inventory. Current container and engine identities
belong in a private owner packet, never in the repository. The previous PR139
execution script was bound to PR114/schema43 and must not be rerun unchanged.

## Admission and scope

An owner packet has exactly `plan` and `approval`. Prepare it initially with
`approval: null`. The plan contains protocol `PR140_OWNER_BACKUP46_R05`, a new
32-character lowercase hexadecimal `runId`, source commit/tree, schema46, the
expected database name, SHA256 of the received owner preflight, the complete
name/checksum map `expectedLedger`, preservation policy, and the observed target
hostname/user/engine/app/PostgreSQL/network identities. See `validate_packet` for
the exact fields. No environment values or key material belong in this packet.

Only after operational review and explicit owner authorization may the separate
approval contain status `OWNER_EXPLICITLY_AUTHORIZED`, confirmation
`FAI_CRM_SCHEMA46_STOP_BACKUP_RESUME_R05`, hashes of the canonical plan, Python
program and PowerShell launcher, and the authentic review reference. These fields
record authority obtained outside the program; they do not grant that authority.
Changing any reviewed input requires renewed verification of that exact input.

The owner authorization must cover the single app's temporary stop and restart,
creation of a new private backup/configuration directory, canonical read-only
document helper and its identity-bound cleanup, and canonical cleanup of this
operation's unpublished partial set. Existing backups, F: copies and R11 software
are preserved. No general container or filesystem cleanup is permitted.

## Owner invocation

From the already configured owner PowerShell profile, validate the private packet:

```powershell
& .\scripts\pr140\Invoke-OwnerBackup46.ps1 -PacketPath '<private packet path>' -ValidateOnly
```

Validation is local and never opens SSH. The launcher invokes the same complete
Python validator used by the remote entry point, including duplicate-field and
exact-schema checks. It uses Codex's existing bundled Python by default; an
already installed interpreter may be selected explicitly with `-PythonPath`.
Nothing is installed. A packet without reviewed approval reports
`executionAdmitted=false`; malformed packets fail before the attempt marker or
any SSH lookup. No permanent execution-policy or SSH profile change is included.

Once the exact intervention is authorized, use the same command without
`-ValidateOnly`. The launcher checks the hashes before opening SSH, uses the
existing `fai-crm-prod` alias with strict host-key checks and batch authentication,
and preserves a one-shot local attempt marker. It sends only program and packet
bytes; it does not copy production data to the agent. Keep the owner window open.

On an uncertain result, preserve the marker and do not blindly rerun. The server
also refuses an existing run directory. The task must reconcile the minimized
receipt with the exact recorded identities before any new attempt.

## Runtime sequence

1. Reconfirm source checkout/tree, complete canonical migration names/checksums,
   unchanged tool hashes, minimum free space, target user/hostname/engine,
   source image labels, database, network and exact container identities.
2. Acquire the existing N05 production lock. Create only a new private operation
   directory under the existing release parent. Preserve current environment,
   Compose files and frozen source model in private files. The canonical runtime
   adapter checks the model against the actual containers. External key-file
   references cause STOP; the program never follows them or opens custody.
3. Verify closed feature modes and capture the entire ledger before quiescence.
   Stop only the bound app ID. PostgreSQL, volumes and network are never restarted,
   recreated or replaced.
4. Invoke canonical `backup-docker-prod.sh --preflight` and `--create`, explicitly
   setting `EXPECTED_MIGRATION_COUNT=46` and the bound source identities. The
   document helper has no network and mounts the existing document volume read-only.
5. Verify the canonical manifest/checksums/archive safety, read the full dump with
   `pg_restore --file=/dev/null`, and recheck the ledger/configuration/source.
6. In the recovery path, require the exact original app identity and preserved
   persistence resources before restarting that same container. Check health and
   PostgreSQL's original started time and restart count. No replacement image is
   used for this backup step.
7. Emit `BACKUP_VERIFIED_AND_APP_RESUMED` only after all data checks and source
   resumption succeed. A failed or uncertain resumption cannot produce a success
   receipt. Output contains identities, hashes and booleans, never configuration
   values, raw subprocess errors or database rows.

The original run budget is 20 minutes, plus a pre-bound 5-minute cleanup/resume
reserve. Both monotonic and wall clocks are bounded; entering recovery does not
create a new indefinite deadline. A backup/helper failure may leave a private
partial/full set or require owner attention. Preserve such evidence rather than
performing broad cleanup. An unidentifiable helper is never adopted or removed.

## Evidence and limits

The package's CI tests use synthetic identifiers and mocks to check approval,
identity drift, lost replies, interrupted backup, helper substitution, database
restart detection and failure to resume. Launcher tests verify canonical hashing
and rejection before SSH on Windows and Linux. These tests do not attest an
operation on the real target. The underlying N05 backup/recovery tools already
have separate synthetic Docker qualifications for schema43 and46.

This step produces and verifies the new source set **on the server**. Its receipt
explicitly sets `offHostEncryptedCopiesCreated=false`. Encryption/transfer through
the owner's existing method and the evidence pertinent to the new set must be
closed before using it as release admission. Existing F:/Windows/Docker and R11
recovery evidence remain valid in their original scope. This package does not
claim a new full recovery drill, original database owners/ACL restoration, an
off-host copy, an authorized schema47 migration, or production readiness.
