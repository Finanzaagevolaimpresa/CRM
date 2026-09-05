# VNX-04 A05 — Optional N05 persistent N12/N13 key mounts

This change prepares repository tooling only. It does not provision keys, install
WordPress, change authentication, migrate a database, deploy, recreate production
containers, open a gate, or authorize the public pilot. There are still exactly
43 migrations. WordPress access/qualification, mapping, privacy, backup evidence,
operator readiness and pilot authorization remain separate blockers.

## Ordinary operation and the optional path

The canonical Compose file, environment examples, ordinary N05 release gate and
legacy application switch retain their behavior. They do not load the new overlay
and do not require a key directory. Do not add the overlay to a generic
COMPOSE_FILE value.

For a future, separately authorized **configuration-only** operation, use
scripts/n05/reconfigure-production-keys.sh. Explicit opt-in
N05_KEY_MOUNTS_OPERATION=FAI_CRM_N05_SAME_IMAGE_KEYS_V1 is mandatory. The only
actions are preflight, enable and restore, each taking one private approval JSON
path. The example under deploy/n05 is intentionally invalid and cannot activate
anything.

The existing explicit legacy bridge confirmation
CONFIRM_LEGACY_RESOURCE_IDENTITY=FAI_CRM_N05_LEGACY_RESOURCE_BRIDGE_V1 and the
verified INCOMPATIBLE_PR_COUNT=0 are also mandatory; the wrapper does not supply
these operator confirmations automatically.

This entry point is fixed to the production host, operating user, repository,
local Docker daemon, canonical Compose file and certified legacy override. It
does not offer synthetic/remote/profile bypasses or an arbitrary override path.
The Docker daemon must be Linux without rootless/user-namespace remapping; those
configurations need separate qualification. Python 3.11+, Bash, Git, Docker and
Compose 2.24.4+ are prerequisites, not packages installed by this change.

The optional overlay adds exactly:

| Existing runtime setting | Host source | Read-only app destination |
| --- | --- | --- |
| SECURE_LEAD_GATEWAY_KEYRING_FILE | /etc/fai-crm/keys/n12-keyring.json | /run/secrets/n12-keyring.json |
| LEAD_IDENTITY_KEY_FILE | /etc/fai-crm/keys/n13-identity.json | /run/secrets/n13-identity.json |

No new N03 setting or key parser is introduced. The effective app UID/GID is
obtained from the healthy current application and compared with the private
approval record and the unchanged image user. Source files must be nonempty,
single-link regular files, owned by that UID/GID, with mode 0400. Directories and
all parent components must be trusted, without symlinks or group/world write.
Use an operator/root-owned private key directory (recommended mode 0700);
provisioning and ownership changes require their own future authorization.
The daemon reads file sources directly: create_host_path is false, so a missing
source is rejected rather than materialized as a directory.

Keys are never placed in an image, the documents volume or an application copy.
PostgreSQL receives neither a key mount nor a new environment reference.

## Two independent provenance contracts

The application image keeps its real immutable tag, image ID, OCI source commit
and source tree. Its labels are never rewritten to claim the tooling commit.

The private approval identifies the deployment-tooling main commit, tree, first
parent and successful CI SHA separately. The wrapper verifies local/remote main,
origin, tracked cleanliness and the Git-resolved application source tree. It
refuses a delta in application source, Prisma, migrations, dependencies, public
assets, Dockerfile or build configuration between image source and tooling.
Only N05/deployment/smoke and the already separate VNX-03 harness paths may differ
under scripts; application consumer/worker scripts may not.

Both enable and restore require the exact same image ID already running. This
is a narrow configuration gate; it does not relax scripts/n05/release-gate.sh,
which continues to require the ordinary release and rollback image identities.
A later application release is a separate operation and must explicitly account
for the active key-mount configuration.

CI evidence is supplied in the reviewed private approval record, as with the
existing N05 operator gate; the wrapper does not authenticate to GitHub or infer
approval from a successful local command. Antonio/Cabina must verify the exact CI
run and authorization before issuing that record.

## Effective configuration and the mutation boundary

Compose resolves the canonical base plus legacy resources, and then those same
files plus the fixed key overlay, in a subprocess with a controlled environment.
Ambient Docker/Compose selectors are rejected and no arbitrary file is loaded.
The verifier compares complete effective models: the only allowed difference is
the two fixed app mounts and the two existing key references. Extra services,
resources, writable mounts, privilege additions and open intake/AI gates fail.

A private JSON representation freezes the selected effective model. Compose's
literal-dollar escaping is preserved, and Compose re-reads the representation
to prove exact equivalence before use; the
private digest approved for each variant binds all resolved values. The actual
up command uses this frozen file, not a newly substituted environment file.
The frozen file is mode 0600 in a mode 0700 temporary directory and is removed on
exit. Neither it nor subprocess output is published.

Compose 2.38 serializes a false create_host_path as an empty bind object. The
normalizer restores an explicit false in the frozen file before use, and never
normalizes true away. A native daemon negative probe verifies that an absent
source is refused without creating its path or a container.

Preflight is read-only. It checks current runtime image, user, environment,
mounts, ports, network, health, legacy resource identity and key-source metadata,
and returns the two configuration digests. It does not parse keys by starting a
helper container. Content/parser validation is performed on the reconfigured app
with the gates still closed. The synthetic qualification proves both the parser
read and rejection of write/chmod attempts with the real image user.

Before enable/restore, the wrapper repeats tooling, runtime and key inode checks,
requires the approved configuration digests and explicit recreation confirmation.
The only Compose mutation is:

    up -d --no-deps --no-build --pull never --force-recreate app

This is a recreation, not a restart. The container ID must change, its image ID
must not. The PostgreSQL container ID/image/creation/mounts, volume identities and
network identity/configuration must remain equal. The app must become healthy.
No PostgreSQL up/restart, consumer, worker, scheduler or migration is invoked.

Run only in an exclusive approved maintenance window with concurrent
configuration, key-rotation and deployment actions suspended. Host administrators
are trusted; this does not defend against a concurrent root process replacing
files between filesystem checks and a Docker mount.

## Backup and recovery before a future application

Coverage is intentionally separate:

1. **Database and documents:** create a fresh, complete backup through the
   existing N05 production wrapper under its application-quiesced contract and
   certified legacy-resource bridge. Keep the real image provenance and exactly
   43 expected migrations. Verify the canonical manifest, both checksums and
   document archive safety. No historical manifest is rewritten. The new gate
   accepts only a verified set created within the preceding hour. Any necessary
   stop/resume and backup creation require a future production mandate; this
   wrapper does not create a backup or quiesce an application.
2. **Configuration:** recover the actual environment file, approved deployment
   files and private approval record, with their exact digests and access modes.
   Preserve the original empty key references in the ordinary environment file.
3. **Cryptographic material:** recover the N12/N13 files and any historical
   material still required by queues/receipts or other persisted evidence.
   Encryption keys for backups must be recoverable independently.

Items 2–3 must have separately encrypted, access-controlled recovery artifacts
and a demonstrated recovery procedure. The private recovery directory must be
0700 and contain configuration.encrypted, cryptographic-material.encrypted and
SHA256SUMS, each mode 0600. The inventory has exactly the two standard SHA-256
rows and its digest is bound to the private approval. The wrapper checks presence
and integrity; N05_RECOVERY_RESTORE_VERIFIED=CONFIGURATION_AND_KEYS_RESTORE_VERIFIED
is the operator's explicit attestation of actual recovery qualification, not
proof that a checksum can establish decryption/restoration.

Neither current backups nor future recovery sets are created by repository
merge. New sets remain **to create and verify**. The R01 historical backup is not
automatically promoted to the pilot backup.

## Future controlled sequence (not authorized by this PR)

1. Obtain a single scoped production mandate identifying both provenances,
   expected current resources, key provisioning, private recovery destinations,
   maintenance window and rollback. Resolve prerequisites and obtain the
   successful post-merge tooling CI evidence. Close all excluded gates.
2. Provision the two sources privately with the required identity/modes; retain
   all historical material. Prepare a private approval from the invalid example,
   using verified values. Leave both ordinary key references empty.
3. Run the explicitly opted-in preflight. Record the ordinary/mounted digests in
   the approval and recheck the approved image/tooling identities.
4. Under the separately approved N05 quiescence procedure, create and verify the
   fresh DB/documents backup and the separately covered configuration/key
   recovery sets. Restore normal app availability only according to that
   procedure. The new wrapper expects the current app healthy for identity
   inspection; the backup itself must have been taken while quiesced.
5. With CONFIRM_N05_SAME_IMAGE_RECREATE=FAI_CRM_N05_RECREATE_APP_ONLY_V1 and the
   recovery attestation, run enable. Inspect the PASS marker, new app ID, unchanged
   image/resources and parser checks. Keep all integration/intake/AI gates closed.
6. Capture sanitized evidence privately. No public pilot follows automatically.

## Configuration rollback

With the same reviewed tools, original ordinary environment and same image,
restore selects the approved ordinary Compose model and recreates only the app.
It verifies the same resources and health. A fresh valid backup and the recovery
gates remain mandatory; rollback is not an exception to N05.

Keep source key files and protected recovery artifacts after removing the app
mounts. Preserve all inbox/outbox events, receipts, leases, Lead records and
evidence. Do not delete a ledger, empty a queue, restore an older database over
newly acquired data or down-migrate as routine rollback. Closing gates stops new
work; it does not undo persisted data.

If recreation fails or health does not recover, retain the current evidence and
resources. There is no automatic fallback. Explicit restore can handle a running
unhealthy or stopped mounted app, still requiring its exact image, Config.User,
approved configuration and recovery gates. For a stopped app it uses the UID/GID
already bound to the approval and verifies them again on the restored app. It
does not require the removed key sources to remain readable: they are not part
of the target model. It never deletes them. Unidentified or partially created
resources remain a stop requiring a scoped recovery decision.

## Qualification and evidence

- tests/n05/test_key_mounts.py exercises configuration, path/type/permission,
  provenance and the production entry-point boundary.
- tests/n05/key_mounts_drill.py renders the real production overlay with
  synthetic values, then uses a clearly distinct synthetic identity for a real
  Docker app/PostgreSQL stack. It calls the same freeze, identity, snapshot and
  app-recreation primitives as production, without invoking or weakening the
  production guard.
- The drill verifies ordinary startup without keys, existing N12/N13 parsers,
  read-only behavior, negative cases before mutation, both app recreations,
  retained image ID/resources and synthetic DB/document content. Cleanup is
  confined to its collision-checked random project.
- The Docker job builds its synthetic app from the unchanged, tracked image
  source baseline, separately from the current tooling checkout. OCI labels
  identify that source honestly; its newly built synthetic image ID is not
  represented as the production image ID.
- CI adds the N05 mount job alongside all existing jobs, including authentic
  VNX-03 HTTPS qualification. Existing lint, typecheck, unit/DB tests, build,
  connector packaging, production smoke and complete N05 restore/rollback stay.

Compose behavior references: [effective config](https://docs.docker.com/reference/cli/docker/compose/config/),
[long mount syntax](https://docs.docker.com/reference/compose-file/services/#volumes),
and [literal-dollar interpolation](https://docs.docker.com/reference/compose-file/interpolation/).
