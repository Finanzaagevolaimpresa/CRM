# N03 — Privileged Access, Feature-Gate & Application Security Baseline v1

N03 introduces an additive, dormant security foundation. Deploying this change does not enable privileged step-up, login throttling, integrations, portal, payments, AI workers, AI dispatch, or AI egress.

## Dormant deployment contract

- `PRIVILEGED_ACCESS_MODE=disabled`
- `LOGIN_THROTTLE_MODE=disabled`
- `SECURITY_HEADERS_MODE=report-only`
- every `FEATURE_*_ENABLED=false`
- no `ApplicationKeyVersion` row
- all six `ApplicationFeatureGate` rows present and `enabled=false`
- zero `LoginThrottleBucket` rows before and immediately after deployment

Migration 34 creates only the feature-gate registry, the key-version registry, and keyed login-throttle state. It never creates an active key and never opens a feature gate. The previous PR89 application remains compatible because the new tables are additive and unused by its runtime.

## Security invariants

Privileged user, role, permission, AI configuration, external-execution decision, and Orchestrator policy mutations continue to require their authoritative server-side permission checks. User privilege mutations also retain the existing real-admin database check. When step-up is separately enforced, these operations additionally require an exact same-origin request and a five-minute, HttpOnly, session-bound token signed by the single ACTIVE registered key version. Cancellation by the original AI requester and the fail-safe Orchestrator emergency stop remain outside step-up so a defensive stop cannot be delayed by key or cookie availability; their existing authorization and transactional controls remain authoritative.

Feature access is effective only when both controls are true: the exact environment variable is `true` and the corresponding PostgreSQL row is enabled. A missing row, missing variable, unknown value, or database failure results in OFF. The existing website-lead integration is wired to the `INTEGRATIONS` gate in addition to its N01 mode and authentication controls. The remaining codes reserve the same server-only contract for customer-portal, external-payment, AI-worker, AI-dispatch, and AI-egress surfaces; none is activated or made executable by N03.

Login throttling stores only an HMAC digest derived from the normalized account identifier. It uses PostgreSQL current time and an atomic UPSERT so concurrent failures cannot bypass the threshold. Invalid enforced configuration fails closed.

The CSP is report-only by default so violations can be assessed before enforcement. HSTS, MIME sniffing protection, framing protection, referrer policy, permissions policy, COOP, CORP, and cross-domain policy headers are emitted globally. Next.js materializes these headers during the image build: `SECURITY_HEADERS_MODE` is therefore a non-secret build argument as well as an explicit runtime record. Switching to enforced requires a newly built immutable image; changing only the running container environment is insufficient.

## Separate activation sequence

Activation is not part of N03 and requires a separately authorized change window:

1. confirm backups, health, migration count 34, and zero unfinished migrations;
2. set `APP_ORIGIN` to the exact production origin;
3. generate a new secret of at least 32 characters outside the repository and logs;
4. register only its SHA-256 digest with a monotonically increasing ACTIVE version;
5. configure the same version and secret in the protected runtime environment;
6. exercise step-up with a non-critical administrator test account;
7. set `PRIVILEGED_ACCESS_MODE=enforced` and verify positive and negative mutation paths;
8. enable login throttling separately after threshold validation;
9. after reviewing violations, build a new immutable image with `SECURITY_HEADERS_MODE=enforced` and verify its headers before deployment;
10. open any feature gate only through a separate authorization that changes both ENV and DB controls.

Never rotate `AUTH_SECRET` as part of N03 activation. Never place key material in PostgreSQL, source control, command output, or audit metadata.

## Rollback

Application rollback may restore the PR89 image and dormant environment values. Migration 34 remains applied: no down-migration is required or permitted. Before rollback, confirm all feature gates are OFF, privileged enforcement and login throttling are disabled, no key is ACTIVE, and no unexpected throttle state exists.
