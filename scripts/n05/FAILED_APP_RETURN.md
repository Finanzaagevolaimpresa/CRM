# N05 failed-app return protocol

This controller is separate from the ordinary healthy-app switch. It does not weaken that switch and it does not use the key-mount configuration gate.

## Private inputs and bindings

A production run uses a private `0700` directory containing `0600`, single-link regular files. The strict V2 plan binds the measured Docker engine, project, tool/CI identity, exact source/candidate/return containers and OCI images, PostgreSQL, complete volume/network snapshots, immutable frozen Compose models, complete Prisma ledger, a global deadline, return policy, receipt, post-forward return request and durable journal. The immutable pre-forward plan allows states; it does not predict one. After observation, the request binds its selected reason to both the unchanged plan hash and completed receipt hash. A functional-failure request additionally carries separate evidence and is valid only while Docker still reports the candidate healthy. Recovery, artifact availability, reviewed plan, authorization and return-image/schema compatibility are independent, hashed evidence documents bound to the same run/tool/engine/image/ledger identities. The controller never manufactures these qualifications and never reads key material.

`forward` verifies the same healthy source and project invariants at the mutation boundary, records an atomic hash chain before and after removal/create/start, and creates the selected app with `docker compose up --no-start --no-deps --no-build --pull never app` before starting its recorded ID. CI checks these flags against the installed Compose help. After a failed create command, an absent candidate is returnable only after a fresh successful snapshot proves absence and unchanged persistence; an inspect error, timeout, uncertain inventory or partially created candidate is not authority.

`return` acquires the single canonical engine/project lock and writes `ATTEMPT_STARTED` durably before mutation. Any failure is retained and every later invocation for that journal is denied. PASS follows health plus repeated runtime, ledger, image, configuration and persistence checks. No retry, down migration, ledger rewrite, `down`, prune or unregistered cleanup is performed.

## Synthetic Docker drill

On an isolated GitHub runner:

```sh
docker pull alpine:3.20
docker pull postgres:16-alpine
N05_FAILED_RETURN_SYNTHETIC_CONFIRMED=1 python3 -B tests/n05/failed_app_return_drill.py
```

The drill uses image-owned commands and health checks, matching the production runtime validator. A registered container name collision makes the same production adapter's candidate creation fail; there is no synthetic absence hook. The other cases produce functional failure, an unhealthy app and an exited app. A real stopped migrator is verified and removed before the forward transition. Temporary objects are inventoried even after partial Compose failures; final PASS follows cleanup verification. Native null volume metadata is retained and compared exactly, rather than replaced with an empty object.

Synthetic evidence proves only protocol mechanics. It does **not** qualify production recovery, real artifacts, the concrete schema compatibility proof, authorization, review, host identity or change window; those remain mandatory private inputs.
