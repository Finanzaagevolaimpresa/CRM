# N05 failed-app return protocol

This controller is separate from the ordinary healthy-app switch. It does not weaken that switch and it does not use the key-mount configuration gate.

## Private inputs and bindings

A production run uses a private `0700` directory containing `0600`, single-link regular files. The strict V2 plan binds the measured Docker engine, project, tool/CI identity, exact source/candidate/return containers and OCI images, PostgreSQL, complete volume/network snapshots, immutable frozen Compose models, complete Prisma ledger, a global deadline, return policy, receipt, post-forward return request and durable journal. The immutable pre-forward plan allows states; it does not predict one. After observation, the request binds its selected reason to both the unchanged plan hash and completed receipt hash. A functional-failure request additionally carries separate evidence and is valid only while Docker still reports the candidate healthy. Recovery, artifact availability, reviewed plan, authorization and return-image/schema compatibility are independent, hashed evidence documents bound to the same run/tool/engine/image/ledger identities. The controller never manufactures these qualifications and never reads key material.

Candidate and return image IDs must differ. This controller rejects same-image
configuration transitions before daemon access; those belong to the separately
qualified same-image path.

Each frozen app service must name its planned content-addressed `sha256:` image ID. Tags, including the expected display tag, are rejected as executable references before mutation. This also prevents later retagging from redirecting Compose. A running app is unhealthy only when Docker explicitly reports `unhealthy`; starting, unknown, paused, restarting and dead states do not authorize the unhealthy return.

Qualification receipts include `operation_sha256`, computed from the entire operational plan after excluding only the `gates` and `compatibility` references whose files contain that binding. This avoids a hash cycle while binding candidate, frozen models, source, resources, output paths, deadline and all other operational fields. The forward receipt still hashes the complete final plan, including evidence references. Receipt, request and journal paths must be canonical, pairwise distinct, distinct from inputs, and absent before forward; all private output parents are checked before mutation.

`forward` verifies the same healthy source and project invariants at the mutation boundary, records an atomic hash chain before and after removal/create/start, and creates the selected app with `docker compose up --no-start --no-deps --no-build --pull never app` before starting its recorded ID. CI checks these flags against the installed Compose help. After a failed create command, an absent candidate is returnable only after a fresh successful snapshot proves absence and unchanged persistence; an inspect error, timeout, uncertain inventory or partially created candidate is not authority.

Both commands acquire the single canonical engine/project lock. If a migrator is registered, the supported forward path verifies its successful exit, ledger, engine and persistent resources, removes that exact container and rechecks inventory before the app transition. `return` writes `ATTEMPT_STARTED` durably before mutation and compares the last app observation with the exact app or absence admitted by the receipt, including ID, creation time, image, configuration and state. Any failure is retained and every later invocation for that journal is denied. PASS follows health plus repeated runtime, ledger, image, configuration and persistence checks. No retry, down migration, ledger rewrite, `down`, prune or unregistered cleanup is performed.

The forward preflight verifies both candidate and return images and replayable models before removing anything, and rechecks return availability at the mutation boundary. Inventory includes all containers selected by project labels plus consumers of the protected network and both volumes, including stopped volume consumers. Unlabeled users of these resources block mutation too.

## Lock preparation before the change window

The fixed lock is `/run/fai-crm-n05/n05-failed-app-return.lock`. Before admitting
an operational plan, provision its dedicated directory as `0700`, owned by the
operator that will execute both commands. Its ancestors `/run` and `/` must be
real, trusted directories with no group/other write permission. For a new
absent directory, the administrator can use `mkdir -m 0700` followed by `chown`
to the identified operator. Record and verify the actual owner and mode before
the change window. The controller neither creates this directory nor changes
permissions. If it already exists, inspect it without replacing it or changing
an active lock. `/run` is ephemeral: provision again after a reboot before use.
Do not use `/run/lock`, relax ancestor checks, or delete a lock to overcome
contention or an engine binding mismatch. New locks are created exclusively and
set to `0600` through the opened descriptor even under a restrictive umask.
The descriptor inode, owner, link count and matching path are checked before
flock. Preexisting locks with invalid modes are rejected, not repaired.

CI exclusively creates this same directory on its isolated runner. The real
entrypoint holds the real `flock` through forward/migrator removal and return
with synthetic daemon/qualification inputs, verifies contention and release,
and refuses missing or writable parents before daemon access. This proves lock
usability, not production host or qualification admission.

## Synthetic Docker drill

On an isolated GitHub runner:

```sh
docker pull alpine:3.20
docker pull postgres:16-alpine
N05_FAILED_RETURN_SYNTHETIC_CONFIRMED=1 python3 -B tests/n05/failed_app_return_drill.py
```

The drill uses image-owned commands and health checks, matching the production runtime validator. A registered container name collision makes the same production adapter's candidate creation fail; there is no synthetic absence hook. The other cases produce functional failure, an unhealthy app and an exited app. A real stopped migrator is verified and removed before the forward transition. Temporary objects are inventoried even after partial Compose failures; final PASS follows cleanup verification. Native null volume metadata is retained and compared exactly, rather than replaced with an empty object.

The synthetic PostgreSQL health check uses TCP so the socket-only temporary
initialization server cannot satisfy readiness. The 40-check deadline is enforced
before fixture SQL; command errors retain bounded synthetic diagnostics. This
does not change the production PostgreSQL configuration.

Additional Docker negatives prove that unavailable return provenance leaves source and migrator untouched, and that unlabeled volume-only or network-only consumers prevent return. The volume probes stay stopped; the network probe is actually attached. Only registered synthetic objects are removed.

Synthetic evidence proves only protocol mechanics. It does **not** qualify production recovery, real artifacts, the concrete schema compatibility proof, authorization, review, host identity or change window; those remain mandatory private inputs.
