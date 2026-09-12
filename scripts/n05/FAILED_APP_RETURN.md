# N05 failed-app return protocol

This controller is separate from the ordinary healthy-app switch. It does not weaken that switch and it does not use the key-mount configuration gate.

## Private inputs and bindings

A production run uses a private `0700` directory containing `0600`, single-link regular files. New forward runs require the strict V3 plan. It binds the measured Docker engine, project, tool/CI identity, exact source/candidate/return containers and OCI images, PostgreSQL, complete volume/network snapshots, immutable frozen Compose models, complete Prisma ledger, original phase deadlines and reserves, return policy, receipt, post-forward return request and durable journal. The immutable pre-forward plan allows states; it does not predict one. After observation, the request binds its selected reason to both the unchanged plan hash and completed, published receipt hash. A functional-failure request additionally carries separate evidence and is valid only while Docker still reports the candidate healthy. Recovery, artifact availability, reviewed plan, authorization and return-image/schema compatibility are independent, hashed evidence documents bound to the same run/tool/engine/image/ledger identities. The controller never manufactures these qualifications and never reads key material.

Candidate and return image IDs must differ. This controller rejects same-image
configuration transitions before daemon access; those belong to the separately
qualified same-image path.

Each frozen app service must name its planned content-addressed `sha256:` image ID. Tags, including the expected display tag, are rejected as executable references before mutation. This also prevents later retagging from redirecting Compose. A running app is unhealthy only when Docker explicitly reports `unhealthy`; starting, unknown, paused, restarting and dead states do not authorize the unhealthy return.

Qualification receipts include `operation_sha256`, computed from the entire operational plan after excluding only the `gates` and `compatibility` references whose files contain that binding. This avoids a hash cycle while binding candidate, frozen models, source, resources, output paths, deadline and all other operational fields. The forward receipt still hashes the complete final plan, including evidence references. Receipt, request and journal paths must be canonical, pairwise distinct, distinct from inputs, and absent before forward; all private output parents are checked before mutation.

`forward` verifies the same healthy source and project invariants at the mutation boundary, records an atomic hash chain before and after removal/create/start, and creates the selected app with `docker compose up --no-start --no-deps --no-build --pull never app` before starting its recorded ID. CI checks these flags against the installed Compose help. After a failed create command, an absent candidate is returnable only after a fresh successful snapshot proves absence and unchanged persistence; an inspect error, timeout, uncertain inventory or partially created candidate is not authority.

Both commands acquire the single canonical engine/project lock. If a migrator is registered, the supported forward path verifies its successful exit, ledger, engine and persistent resources, removes that exact container and rechecks inventory before the app transition. `return` writes `ATTEMPT_STARTED` durably before mutation and compares the last app observation with the exact app or absence admitted by the receipt, including ID, creation time, image, configuration and state. Any failure is retained and every later invocation for that journal is denied. PASS follows health plus repeated runtime, ledger, image, configuration and persistence checks. No retry, down migration, ledger rewrite, `down`, prune or unregistered cleanup is performed.

The forward preflight verifies both candidate and return images and replayable models before removing anything, and rechecks return availability at the mutation boundary. Inventory includes all containers selected by project labels plus consumers of the protected network and both volumes, including stopped volume consumers. Unlabeled users of these resources block mutation too.

## V3 deadlines, settlement and publication

`schema=FAI_CRM_N05_FAILED_APP_RETURN_V3` preserves the total `deadline_epoch`
and adds an exact `phase_deadlines` object:

| Field | Meaning |
| --- | --- |
| `forward_epoch` | Last bound for preflight, migrator removal, source removal, candidate creation/start and forward observation |
| `settlement_epoch` | Last bound for verified cessation of the forward client and exact failed candidate |
| `return_epoch` | Original bound for the separate return command, including its final verification |
| `settlement_reserve_seconds` | Positive minimum difference between settlement and forward |
| `return_reserve_seconds` | Positive minimum difference between return and settlement |
| `cleanup_reserve_seconds` | Positive minimum difference between total and return |

All numbers must be finite, non-boolean and strictly ordered. Insufficient
reserves are rejected before protocol output or engine access. Durations are
requirements on the differences, never inputs to `now + a new duration`.
Every bound and reserve is covered by evidence and receipt hashes. A plan may,
for example, propose 360/120/600/180 seconds; those are not measured durations
or a production authorization. The operational plan must derive absolute
epochs once from the admitted window and retain them. After a healthy forward,
the UI verification/cutoff must also preserve the original return reserve;
finishing forward does not grant an unlimited verification interval.

New forward commands produce `FAI_CRM_N05_FORWARD_RECEIPT_V2`. Normal observed
and attributed-absence sequences remain distinct. If a forward endpoint fails
or the candidate remains `starting` until `forward_epoch`, settlement is
possible only after `candidate-create/created-exact` has been published. The
new sequence is:

1. Original five forward events, through the exact created candidate.
2. `forward-interrupted/observed-failure`, retaining the bounded failure code.
3. `settlement-intent/stop-exact-only`, bound to that ID, Created, image and the
   unchanged settlement deadline, published before stop.
4. `candidate-settled/stopped-exact`, only after fresh engine, configuration,
   instance, ledger and persistence checks, native stop and repeated checks.
5. `forward-result/candidate-stopped-after-failure`, with the actually observed
   `exited` state. It supports a subsequent `reason=exited` return request.

No `candidate-start` success is fabricated in this sequence. Stop requires the
same instance, no paused/restarting state, no active exec, `Status=exited`,
`Running=false` and `Pid=0`. A `created`, dead, unknown, missing or replaced
instance is not relabeled exited. An uncertain create response is never
adopted from later labels, names, image similarity or inventory. Engine errors,
unverified stop, missing receipt or exhausted settlement budget leave an
incomplete result, with no return authority or repeated create. Settlement
does not restart or remove a container. Its command grace period and all
observations share the original bound.

`run_deadline` bounds local command termination too. Forward client kill/reap
uses at most the original settlement bound; return client termination uses at
most the original total, preserving the distinction from application mutation.
Commands without a later admitted stop bound reserve two seconds inside their
given bound. After timeout/interruption, the leader must be reaped and its
attributed process group absent. A blocked/failed kill or reap, surviving group
or second interruption yields `LOCAL_COMMAND_STOP_UNVERIFIED`; it cannot enter
positive settlement. A stopped Docker CLI alone does not prove the container
stopped; the subsequent Docker observations provide that separate proof.

V3 derives two additional private paths, `receipt_path + '.pending'` and
`journal_path + '.pending'`, checked for aliases and preexistence. Each is an
exclusive publication interlock bound to run, complete plan hash and output.
The marker survives interrupted writes, including a complete JSON renamed
before a failed fsync. Completion requires successful publication, exact
readback, marker inode/content checks and remaining phase budget, then removal
of that owned marker. A `.pending` file, including a dangling symlink at that
path, blocks consumption. **A syntactically valid receipt or a `PASS` field in
a journal accompanied by `.pending` is not a completed publication.** Retain
the marker and all evidence on failure; never remove it to retry or admit
return. Failed return journals also remain single-attempt evidence.

The publication commit point is the final atomic unlink of the identified
marker. All fallible readback, descriptor closes and deadline checks precede
it; there is no fsync after that unlink. The JSON and its directory were
already fsynced. Following a crash, an unflushed marker deletion can reappear
and deny consumption. This deliberately chooses fail-closed restart behavior
over claiming a durable acknowledgement after a fallible final operation.
The deadline check governs initiation of that final syscall, not a hard
real-time guarantee for a blocked kernel filesystem operation. No receipt
attests the completion latency of the future storage device. Application
mutations and later commands remain subject to their unchanged phase bounds.
Operational admission must measure publication/stop latency and durability on
the admitted synthetic bench; code tests alone do not qualify that device.

The CLI prints `N05_FAILED_APP_FORWARD_SETTLED_FOR_RETURN` for completed
settlement, distinct from forward `PASS`; neither message alone attests a
successful deployment. The separate return command consumes `return_epoch`
even after `forward_epoch` has expired. No hash, receipt or deadline is edited
to reopen a window.

V2 plans and their V1 forward receipts remain supported **only for historical
return within that unchanged plan's original total bound**. This does not add
V3 reserve or publication proof retroactively. A new V2 forward is rejected
with `NEW_FORWARD_REQUIRES_V3`; a V3 receipt cannot be reinterpreted as V1 by
only changing a version field.

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

The drill uses image-owned commands and health checks, matching the production runtime validator. A registered container name collision makes the same production adapter's candidate creation fail; there is no synthetic absence hook. The other cases produce functional failure, an unhealthy app, an exited app and a candidate whose health remains starting past the original forward bound. That fifth case exercises the actual timed observation, stop, receipt and return adapter paths. A real stopped migrator is verified and removed before the forward transition. Temporary objects are inventoried even after partial Compose failures; final PASS follows cleanup verification. Native null volume metadata is retained and compared exactly, rather than replaced with an empty object.

The synthetic PostgreSQL health check uses TCP so the socket-only temporary
initialization server cannot satisfy readiness. The 40-check deadline is enforced
before fixture SQL; command errors retain bounded synthetic diagnostics. This
does not change the production PostgreSQL configuration.

Additional Docker negatives prove that unavailable return provenance leaves source and migrator untouched, and that unlabeled volume-only or network-only consumers prevent return. The volume probes stay stopped; the network probe is actually attached. Only registered synthetic objects are removed.

Synthetic evidence proves only protocol mechanics. It does **not** qualify production recovery, real artifacts, the concrete schema compatibility proof, authorization, review, host identity or change window; those remain mandatory private inputs.
