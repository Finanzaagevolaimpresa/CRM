# VAE campaign attribution — R01

The form 4 connector reads the sanitized WPForms `entry_meta.page_url` at `wpforms_process_complete`. Previously only mapped form fields entered the signed event; UTM parameters retained in the entry URL did not. The Admin lead page now shows verified attribution from each acquired request without rewriting the lead's WordPress source or historical receipts.

## Mapping and validation

| URL input | Signed payload | Validation |
| --- | --- | --- |
| utm_source | campaignPlatform | case-insensitive meta/chatgpt, normalized META/CHATGPT |
| utm_campaign | campaignCode | ASCII alphanumeric first character, then alphanumerics or _.:-, at most 80 characters |
| utm_content | adCode | same code contract |

Only form ID 4 and the HTTPS /valutazione or /valutazione/ path at the configured WordPress home origin are admitted. The whole URL is bounded to 4096 bytes. Credentials, fragments, controls, different origins/ports, duplicate or array-shaped UTM parameters are ignored for attribution. Individual unknown/invalid values are omitted. Other query data is never copied to the event. Invalid optional attribution does not prevent an otherwise valid organic lead from being acquired. Conflicts with an existing mapped campaign/ad code are rejected rather than silently replacing either value.

Missing attribution remains absent. No inference from user agent, referrer or source email. Platform and codes are declared by the incoming URL, **not independently verified advertising-platform claims**. The query never changes the form's privacy decisions or service catalogue.

## Persistence and authorization

The optional platform participates in the existing canonical event, payload hash, HMAC and immutable receipt verification. Source system remains WORDPRESS. Unattributed historical events retain their canonical bytes; no backfill or schema migration is required. The existing business idempotency key is unchanged. Exact delivery replay returns the existing receipt; conflicting payload under the same key remains a conflict.

The embedded Admin panel reads the last bounded page of verified receipts linked to that lead, with distinct platform/campaign/ad labels. Full request history remains available through “Richieste e provenienza”. Empty fields say “Non disponibile”. Corrupt or mismatched receipt/projection hashes suppress attribution. A fresh registered Admin session and existing lead visibility are required on the server. The existing operator request-history scope and technical guards are unchanged.

## Rollout and recovery

1. Qualify and deploy the CRM receiver/consumer/UI accepting the optional platform before updating WordPress.
2. Reconcile the existing producer/consumer trigger binding to the exact healthy application container, image and creation time. Preserve its producer identity, lease owner, authority, queue/cursor and schedule. No parallel acquisition service.
3. Upgrade only the existing connector code to 1.3.0 after a coherent backup and rollback review; retain configuration, credentials, queue and entry IDs.
4. Observe the natural acquisition cycle. Do not replay earlier submissions.
5. Run only the separately authorized live synthetic acceptance cases and observe both the signed receipt and Admin lead.

After attributed receipts exist, the pre-change CRM cannot parse their new field. Recovery must retain an application image that understands the extended contract; do not roll back to an incompatible parser or erase receipts. The producer worker also parses queued envelopes. Therefore the whole 1.2.1 connector must not be restored after attributed events enter its queue: that parser would reject them. Recovery retains the verified 1.3.0 connector and the compatible CRM parser, with no queue/receipt deletion. A producer fault requires scoped quiescence and reconciliation; restoring its verified 1.3.0 code must preserve pending work. A pre-change code backup is only a valid rollback before new-format events exist.

## Tests

PHP parser edge cases, organic byte identity, original mapping conflict, signed PHP/TypeScript interoperability, hash tampering and replay; guarded ephemeral PostgreSQL persistence and scope denial; synthetic browser Admin panel after reload and operator exclusion. Existing connector queue/retry/privacy tests, full unit, lint, typecheck and required CI remain gates. Live form submissions and real Admin inspection are separate acceptance evidence, not substituted by synthetic tests.

## Dependency security prerequisite

The existing CI scanner identified [GHSA-mfr8-8qww-v76h](https://github.com/vercel/next.js/security/advisories/GHSA-mfr8-8qww-v76h) in the previous Next.js 16.4.2 dependency. This candidate uses the patched 16.4.5 release and aligns eslint-config-next and the scoped lint-plugin override. The installed get-root-dirs consumer retains SHA256 886677432990a735e5ebdfb345ff1cbd40e264f9947a8432eeeb254b3a926bde. Its default-root contract, modified-consumer rejection, custom-root counterproofs and genuine lint rule are requalified. Scanner versions, inventory checks and failure thresholds remain unchanged.

The Admin records restore qualification uses Ubuntu 24.04 and explicitly selects PostgreSQL 16 clients for its PostgreSQL 16 service. The moving ubuntu-latest image had changed to Ubuntu 26.04; its newer restore client emitted transaction_timeout, which PostgreSQL 16 does not support. The complete migration/restore checks remain enabled, with client versions checked before any fixture setup.

## Browser regression found during qualification

The native inbound attachment test reproduced a successful octet-stream response with no Content-Length in the browser. The old UI rejected that response before checking its body. The download reader now treats an absent transport length as optional while retaining any present length check, signed byte count and SHA256 checks. It bounds the streamed body to the signed length and the existing 1 MiB MIME maximum; altered, truncated, oversized, denied and non-binary responses cannot produce a download. The server's authorization, origin, scope, revocation and hash checks are unchanged. The native browser download remains a required assertion; direct HTTP tests do not substitute for it. This correction neither resumes the expired production email stream nor sends email.

The required N05 Docker drill also exposed a synthetic-image metadata mismatch with the current Alpine base: image User was null, while container User was an empty string. A reproduction with the exact failing base digest confirmed that Cmd and Entrypoint matched. The drill now declares its existing synthetic root identity as USER 0:0; image and container then match exactly. Runtime guards and production application users are unchanged. All five real Docker return scenarios remain required in CI.
