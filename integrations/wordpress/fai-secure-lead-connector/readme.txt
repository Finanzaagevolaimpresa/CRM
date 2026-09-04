=== FAI Secure Lead Connector ===
Contributors: fai
Tags: wpforms, crm, webhook
Requires at least: 6.5
Requires PHP: 8.1
Stable tag: 1.0.0

Server-side, fail-closed WPForms producer for fai.lead-event.v1 and the FAI N12 gateway.

== Status ==

This source package is dormant. It contains no live endpoint, form identifier, privacy reference,
or secret. Activating the plugin creates only its local WordPress queue table. No cron event or
network request is created until the complete server-side configuration exists and enabled is the
boolean true.

Installation, configuration, key provisioning, activation, synthetic traffic, live traffic, and
cutover all require their own authorization. The repository delivery does none of them.

== Runtime requirements ==

* WordPress 6.5 or later and WPForms.
* 64-bit PHP 8.1 or later with curl, intl, mbstring, mysqli, sodium, and JSON.
* InnoDB with UTC_TIMESTAMP(6) and SELECT FOR UPDATE SKIP LOCKED (MySQL 8 or MariaDB 10.6+).
* HTTPS access to the exact N12 path.
* WordPress cron able to run due events, or a separately managed system trigger for wp-cron.php.

Missing requirements fail closed before an event is sent.

== Configuration contract ==

Define FAI_VNX02_CONNECTOR_CONFIG server-side in wp-config.php. Start from
config.synthetic.example.php. Never place the configuration or key material in a theme, browser
JavaScript, HTML, hidden diagnostics, analytics, or a public directory.

The configuration is strict and closed. Unknown keys, duplicate field IDs, unknown forms, malformed
URLs, missing mappings, unapproved privacy semantics, or a missing contact mapping prevent enqueue
and delivery. Notice codes, notice versions, accepted checkbox values, form IDs, field IDs, and any
catalog reference must be supplied from approved real configuration; the included values are
synthetic and deliberately unusable.

gateway_key_files maps at most four bounded N12 key IDs to private files. active_key_id selects the
key for new submissions. Keep a retiring key mapped until every queue item bound to it has reached a
terminal state. queue_key_file is an independent 32-byte queue-encryption key and must not reuse an
N12 HMAC key.
The plugin also compares the two loaded 32-byte values before every delivery and refuses egress if
they are equal. Do not rotate queue_key_file while ciphertext remains queued; first drain or resolve
the queue under a separately reviewed rotation procedure.

Every key file contains exactly the canonical Base64 encoding of 32 bytes, optionally followed by one
LF. On Unix it must be a regular non-symlink file with no group/world permission and must resolve
outside ABSPATH. The plugin never prints its path or contents.

The service checkbox is accepted only when its normalized value is in accepted_values. The marketing
field must exist and its normalized value must be in exactly one of granted_values or denied_values;
an unchecked field may be represented by the explicitly configured empty string. No decision is
inferred from a missing field.

Email input is deliberately limited to ASCII before lowercase normalization so the emitted bytes are
identical to the TypeScript N10 consumer across PHP runtimes. Internationalized addresses must be
converted and approved upstream rather than guessed by this plugin.

== Queue and delivery ==

The successful wpforms_process_complete hook performs local validation, builds the canonical N10
body, encrypts it, inserts it idempotently, and schedules a WordPress single event. It performs no
remote I/O, so CRM timeout or outage cannot block form completion.

The queue stores only pseudonymous digests, a key ID, bounded state, and an XChaCha20-Poly1305 ciphertext.
It never stores a plaintext payload or N12 secret. Short READ COMMITTED transactions using SKIP LOCKED
claim one row and commit the lease before any HTTP request. Leases prevent normal concurrent duplicate
sends. If a lease expires after an uncertain send, N10/N11 idempotency makes the repeated body a safe
replay; every HTTP attempt uses a new timestamp and nonce.

Automatic delivery is limited to five attempts. Backoff is 60, 300, 1800, and 7200 seconds. A 202
with the exact bounded receipt shape succeeds. 400/413 and 409 are terminal. Timeout, transport
failure, 401, 429, 503, and other 5xx responses retry within the same budget; a valid Retry-After from
1 to 60 seconds is honored without shortening the configured backoff. Unexpected non-5xx responses
are terminal. Terminal records retain only pseudonymous digests and closed technical state;
ciphertext is erased. Retention/deletion of tombstones is intentionally deferred.

Missing private key files consume the same finite attempt budget. Queue-key rotation must wait for
the queue to drain. Plan N12 signing-key rotation around its 900-second retiring-key overlap; this
connector does not extend the gateway acceptance window for old queued items.

Logs contain only closed event/status/error codes and counters. Payloads, field values, event IDs,
submission IDs, receipts, nonces, signatures, key IDs, file paths, URLs, exception messages, and SQL
details are never logged by this plugin.

== Future installation and rollback ==

1. Verify the ZIP and source revision in an isolated environment.
2. Confirm Legal/DPO-approved privacy identities and exact WPForms field/choice values.
3. Provision distinct private queue and N12 key files outside ABSPATH; do not put raw keys in config.
4. Install and activate with enabled still false. Activation creates the local queue table only.
5. Verify cron readiness and configuration without real submissions.
6. Set enabled to true only under a separate cutover authorization.

Emergency disable is fail-closed: set enabled to false first. Then deactivate the plugin to clear its
single scheduled hook. Deactivation does not drop the queue table, erase keys, or alter CRM data.
Rollback is the same disable/deactivate sequence followed by restoring the previously approved plugin
artifact. This package intentionally has no uninstall deletion path; destructive cleanup requires a
separate reviewed action.
