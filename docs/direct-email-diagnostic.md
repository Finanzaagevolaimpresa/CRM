# One approved direct email diagnostic

The admin-only Settings → Communications → Test di invio diretto page previews a
fixed technical message. It never sends on GET. The only POST action requires
`settings.manage`, the current admin role, an enforced privileged mutation with
fresh step-up, and explicit approval of the displayed content. A signed preview
expires after five minutes and binds the protected configuration, message,
mailbox qualification/revision, actor and live session.

The sender and Reply-To are `comunicazioni@finanzaagevolaimpresa.it`. The subject
is `FAI CRM — test tecnico di invio diretto`. The body is
`Messaggio tecnico di collaudo dal CRM FAI. Nessun dato cliente o contenuto promozionale.`
There is one controlled recipient, no CC/BCC, attachments, customer data or
editable message fields. The manual M4 workflow and its seven mailbox records
remain separate. Their manual qualification alone does not configure SMTP.

## Disabled by default

Missing or invalid protected server configuration keeps the diagnostic disabled.
No environment file or real credential is supplied by this patch. Configuration,
deployment, activation and a real send require the separately authorized gates.

| Setting | Meaning |
| --- | --- |
| `DIRECT_EMAIL_TEST_MODE` | Only `enforced` admits a configured diagnostic. |
| `DIRECT_EMAIL_TEST_REFERENCE` | Unique protected campaign reference, 3–80 ASCII letters/digits/underscore/hyphen, starting with a letter. |
| `DIRECT_EMAIL_TEST_RECIPIENT` | One controlled ASCII email address. Never copied to source, test artifacts or GitHub. |
| `DIRECT_EMAIL_TEST_SMTP_HOST` | The verified provider DNS hostname, without a URL or port. |
| `DIRECT_EMAIL_TEST_SMTP_PASSWORD` | Protected SMTP credential for the fixed mailbox. |
| `DIRECT_EMAIL_TEST_APPROVAL_KEY` | Independent random secret represented as 64–128 lowercase hexadecimal characters. |

Existing internal-session registry and enforced privileged access must also be
operational. Configuration values are not accepted from form fields. No generic
SMTP client, scheduler, worker, queue consumer or production mail feature is
activated. The narrow transport uses TLS on port 465 with certificate and host
validation and AUTH PLAIN, a 15-second deadline and no retry/reconnect. Provider
compatibility and real reception remain to be tested after authorized setup.

## Persistence and outcome

The campaign reference determines one unique attempt ID. A reservation in the
existing AuditLog table commits before provider contact. Two submissions, two
admins and process restarts share this reservation. A second transaction locks
and rechecks current authority and mailbox state before one transport call and
appends its result. No migration is introduced. The audit contains hashes and
outcome codes; it excludes message addresses, content and credentials.

`ACCEPTED` means the SMTP server returned 250 after DATA; it does not prove
delivery or reading. `NOT_SENT` means the transport did not accept the message.
`UNCERTAIN` covers an in-flight attempt, lost SMTP outcome, crash or failed result
commit. Every reserved attempt blocks retries, including known failures. A
protected reference must never be rotated merely to bypass an uncertain result:
first reconcile with provider evidence and the recipient, then authorize a new
test. Configuration changes cannot relabel an old receipt as a new test.

The protocol behavior follows [SMTP reply semantics, RFC 5321](https://www.rfc-editor.org/rfc/rfc5321.html#section-4.2.5)
and [implicit TLS submission, RFC 8314](https://www.rfc-editor.org/rfc/rfc8314.html#section-3.3).
The short deadline is intentional for this manual diagnostic, not a claim to
implement a general-purpose SMTP delivery agent.

## Validation and rollback

Unit tests use fake TLS sockets and assert fixed content, one recipient, TLS
validation, disabled defaults, signed approval, success, refusal and ambiguity.
The dedicated CI job uses guarded disposable PostgreSQL to verify committed
reservation before transport, concurrent submissions, replay, fresh revocation,
changed content/configuration and failed result persistence. No test contacts a
real SMTP host. Standard repository lint, typecheck, tests and build remain gates.

On Windows, `node scripts/run-direct-email-local-tests.mjs` can run the same unit
sources when the sandbox prevents tsx from reading the OS user. The scoped local
typecheck is `node node_modules/typescript/bin/tsc --noEmit -p tests/direct-email/tsconfig.local.json`;
neither replaces the full CI checks.

Rollback is an authorized application rollback or disabling the protected mode.
Retain AuditLog reservations/results and the campaign reference across rollback
and restart. Do not delete attempts or regenerate references to retry. Reverting
this dormant patch requires no schema downgrade or customer-data change.
# Scadenze durante attese e trasporto

Le scadenze dell'anteprima e della sessione vengono rivalidate dopo tutti i lock.
La sessione persistita è confrontata con `clock_timestamp()` PostgreSQL, non con
il timestamp fermo di inizio transazione. Un tentativo già prenotato rimane
consumato anche se la validità scade prima del trasporto.

Attese e SMTP condividono un limite monotono di 20 secondi, avviato prima della
transazione finale di 30 secondi. Il socket ha inoltre un massimo di 15 secondi,
ridotto dal tempo residuo e dalle scadenze di autorizzazione; ogni scrittura
controlla scadenza e annullamento. L'annullamento distrugge il socket senza retry.
Le prove PostgreSQL osservano una contesa reale, verificano tre scadenze, il
budget esaurito senza trasporto e una revoca che committa dopo l'arresto del fake.
