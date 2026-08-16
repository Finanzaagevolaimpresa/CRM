# N02 — Internal Session Registry & Revocation Foundation v1

N02 adds an additive PostgreSQL `InternalSession` registry without activating it. `INTERNAL_SESSION_MODE` accepts exactly `legacy` or `registry`; missing or unknown values fail closed. Deployment examples explicitly select `legacy`, preserving PR88 and leaving the new table inert.

Registry cookies contain `v1.` plus 32 CSPRNG bytes encoded as unpadded Base64URL. PostgreSQL stores only the SHA-256 digest. PostgreSQL `CURRENT_TIMESTAMP` is authoritative for issuance, eight-hour absolute expiry, validation, and revocation. There is no sliding expiry, rotation, device data, IP, user agent, role, or permission snapshot.

Login and user disable share a `User` row lock. Login/session/audit and disable/global-revocation/audits are transactional. The middleware is only a syntactic pre-filter; protected server surfaces use the authoritative registry. Historical `login`, `logout`, and `user_deactivate` remain attached to `User`; token, digest, secrets, credentials, email, name, IP, user agent, and raw payloads are forbidden in audit metadata.

## Deploy, activation, and rollback

1. Apply migration 33 only after PR88 compatibility proof.
2. Deploy N02 with `INTERNAL_SESSION_MODE=legacy`; verify health and zero `InternalSession` rows. Deployment does not activate registry.
3. Before every activation or reactivation, count rows with `revokedAt IS NULL AND expiresAt > CURRENT_TIMESTAMP`. The Next.js Node startup hook enforces the same check before the server can accept a registry token. A non-zero count is a hard stop until expiry is verified or a separately authorized global revocation commits.
4. Separately rotate `AUTH_SECRET` to invalidate legacy cookies. This does not revoke registry tokens; the zero-live-session gate independently prevents registry-token resurrection.
5. On rollback retain migration 33. Rotate `AUTH_SECRET` before PR88 starts, and require the zero-live-session gate before any later registry reactivation.
