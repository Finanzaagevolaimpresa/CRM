# VNX-02 — WordPress Secure Lead Connector v1

## Stato e confine

VNX-02 aggiunge il primo producer installabile per il percorso N12 → N11 → VNX-01. Il componente è
un plugin WordPress autonomo in `integrations/wordpress/fai-secure-lead-connector`, versione `1.0.0`.
Il repository CRM non lo importa, il Dockerfile CRM non lo copia e nessuna route, migration Prisma,
feature gate, chiave, worker CRM o configurazione runtime viene modificata.

La consegna è **non installata, non configurata e non attivata**. L'esempio incluso usa soltanto ID e
riferimenti `SYNTHETIC_*`, dominio riservato `.invalid`, `enabled=false` e path di key inesistenti.
Installazione WordPress, provisioning, traffico sintetico, canary, traffico reale e cutover restano
azioni separate.

L'hook ufficiale WPForms `wpforms_process_complete` viene usato solo dopo il completamento riuscito
del form. Nel percorso sincrono non esiste I/O verso il CRM: validazione, cifratura ed enqueue usano
soltanto il database WordPress locale. Un errore viene assorbito dopo un log a vocabolario chiuso, per
cui un CRM indisponibile non può impedire la conferma del modulo.

## Configurazione fail-closed

L'unica superficie di configurazione è la costante array server-side
`FAI_VNX02_CONNECTOR_CONFIG`. Il contratto rifiuta chiavi sconosciute e richiede:

- versione `1` e `enabled` booleano;
- URL HTTPS senza credenziali/query/fragment e con path esatto N12;
- un `active_key_id` N12 e al massimo quattro associazioni key ID → file privato;
- una key distinta per la cifratura della coda;
- uno o più ID form consentiti, ciascuno con `form_code`, `form_version` e mapping esplicito;
- riferimenti privacy completi e valori checkbox esatti per acknowledgement, grant e denial;
- almeno un campo mappato fra email e telefono;
- conversione importo esplicita `EUR_MAJOR_DECIMAL` oppure `EUR_MINOR_UNITS` quando presente;
- riferimento catalogo N09 esatto oppure `null`, senza inferenza dal testo libero.

I codici/versioni informative e i valori mostrati all'utente non sono inventati dal plugin. I branch
privacy sono configurabili, ma devono anche rispettare la semantica vincolante N10:
`SERVICE_REQUEST_FOLLOW_UP` / `PRE_CONTRACTUAL_MEASURES` / `NOTICE_ACKNOWLEDGEMENT` e
`DIRECT_MARKETING` / `CONSENT` / `CONSENT`. Un campo privacy mancante o un valore non censito blocca
l'enqueue. Il rifiuto marketing è esplicito solo quando il campo esiste e il suo valore, incluso
l'eventuale stringa vuota, è elencato in `denied_values`.
La stringa vuota è vietata nelle configurazioni di acknowledgement e grant, anche dopo normalizzazione.

I file chiave devono risolvere fuori da `ABSPATH`, essere file regolari non symlink, avere massimo 64
byte e, su Unix, nessun permesso group/world. Il contenuto è esclusivamente il Base64 canonico di 32
byte con al più un LF finale. La configurazione rifiuta il riuso dello stesso path e il worker
confronta anche i valori caricati, bloccando l'egress se key di coda e key HMAC coincidono. La key di
coda non può essere ruotata finché esiste ciphertext pendente; quella rotazione richiede una procedura
separata. Path e contenuto non vengono mai riportati negli errori.

## Trasformazione N10

Per ogni submission consentita il plugin crea:

- `source.systemCode=WORDPRESS`;
- form code/version dalla configurazione verificata;
- `submissionId=WPFORM:<formId>:ENTRY:<entryId>` quando WPForms persiste l'entry;
- un suffisso casuale per WPForms Lite, dove `entryId=0`, conservato poi nel body di coda;
- UUID v4 distinti per evento e correlazione, generati una volta e riusati in ogni retry;
- `occurredAt` UTC con millisecondi;
- payload normalizzato NFC con gli stessi bound, contatto minimo, path e importo di N10;
- email ristrette ad ASCII prima del lowercase, per equivalenza deterministica PHP/TypeScript;
- acknowledgement service e scelta marketing distinti;
- digest domain-separated N10 per idempotenza e payload.

Il serializer ordina ricorsivamente le chiavi e riproduce il JSON canonico usato dal CRM. Il worker
ricontrolla schema, campi chiusi, normalizzazione, digest e bytes canonici dopo la decifratura e prima
della rete. Il body oltre 16.384 byte non entra in coda.

## Coda, concorrenza e replay

L'attivazione futura crea una sola tabella InnoDB WordPress, senza toccare Prisma. La coda conserva
body cifrato XChaCha20-Poly1305, digest business/content/body, key ID, stato, contatori e lease. La key
di coda è distinta dalle key HMAC N12 e viene derivata con un dominio dedicato; gli associated data
legano ciphertext, business digest, body hash e key ID.

`business_key_digest` è unique. Un secondo callback per la stessa entry e lo stesso contenuto riusa
la riga vincente; contenuto divergente con la stessa identità genera un conflitto chiuso. Il claim usa
una breve transazione `READ COMMITTED` con `SELECT ... FOR UPDATE SKIP LOCKED`, seguita da update
condizionale e commit prima della rete. Il token casuale resta in memoria, il DB conserva il digest,
la lease dura 60 secondi e completion/retry usano CAS. Dieci item al massimo vengono reclamati per run.

Un crash può causare un secondo invio dopo la scadenza della lease, non un secondo evento business:
il raw body N10 resta identico, mentre timestamp e nonce N12 sono nuovi. N12/N11 convergono quindi a
`REPLAY` e restituiscono la stessa receipt come 202. Receipt, nonce, event ID e digest non sono loggati.

Alla riattivazione e su ogni hook WordPress `init`, il connettore abilitato con configurazione valida
recupera un evento cron mancante se esistono righe `PENDING` o `LEASED`. Il risveglio rispetta il
backoff o la scadenza della lease; un evento esistente viene preservato. Il controllo non reclama
righe, non azzera tentativi, non cambia il body e non esegue rete. Funziona anche dopo un'uscita del
worker prima del `finally`, senza nuove submission. Configurazione assente, disabilitata o invalida
e coda vuota/solo terminale non producono nuovi eventi.
La ripresa richiede un successivo bootstrap WordPress e l'esecuzione degli eventi dovuti: senza
richieste al sito e senza un trigger wp-cron autorizzato non si garantisce una scadenza wall-clock.
Non vengono creati scheduler esterni o cron ricorrenti.

## Matrice deterministica

| Esito | Azione connector |
| --- | --- |
| `202` + `{ok:true, receipt:slg2_<32hex>}` | `DELIVERED`, ciphertext cancellato |
| `400` o `413` | terminale `INVALID_REQUEST`, nessun retry |
| `401` | retry bounded `UNAUTHORIZED` |
| `409` | terminale `CONFLICT`, nessun retry |
| `429` | retry bounded `RATE_LIMITED`; `Retry-After` accettato solo tra 1 e 60 |
| `503`, altro `5xx`, `408`, timeout o errore trasporto | retry bounded `TEMPORARILY_UNAVAILABLE` |
| altro status | terminale `UNEXPECTED_RESPONSE` |
| `202` con body incoerente | retry bounded `TEMPORARILY_UNAVAILABLE` |

Il budget è cinque tentativi, con backoff 60, 300, 1.800 e 7.200 secondi. L'ultimo fallimento diventa
`EXHAUSTED`. Stati terminali cancellano il ciphertext e mantengono soltanto tombstone pseudonimi;
l'eventuale retention appartiene a N21 e non viene introdotta qui.
Anche le key mancanti consumano il budget finito. La rotazione N12 deve considerare l'overlap massimo
di 900 secondi del gateway, inferiore al backoff complessivo: drenare/risolvere la coda prima di ritirare
una key; il connector non prolunga la validità delle versioni N12.

## Trasporto e logging

Il trasporto usa cURL server-side con TLS e hostname verification, solo HTTPS, redirect vietati,
timeout totale 4 secondi e risposta limitata a 512 byte. Invia media type e `Content-Length` esatti e
calcola HMAC-SHA-256 sui raw bytes con dominio, metodo, path, media type, key ID, timestamp, nonce e
lunghezza nel preciso ordine N12.

Il codice non usa WordPress HTTP debug hooks, non abilita verbose cURL e non serializza dettagli di
eccezione. I log applicativi ammettono solo event/status/error code chiusi e cinque contatori bounded;
payload, PII, body, ricevute, ID, digest, nonce, firma, URL, path e secret sono esclusi.

## Installazione futura, disabilitazione e rollback

Il file `readme.txt` nel pacchetto contiene la procedura verificabile. In sintesi: qualificare ZIP e
runtime in isolamento; approvare con Legal/DPO form, wording, notice/versioni e basi; provisionare
key distinte fuori web root; attivare con `enabled=false`; verificare tabella e cron; abilitare solo
con un mandato di cutover.

La disabilitazione immediata imposta `enabled=false`; la disattivazione WordPress rimuove l'unico hook
cron. Nessuna delle due operazioni elimina coda, tombstone, key o dati CRM. Non esiste `uninstall.php`
né un drop automatico. Il rollback ripristina il pacchetto precedente dopo disable/deactivate e non
richiede rollback CRM o database CRM.

## Qualifica

La suite usa soltanto fixture sintetiche e verifica:

- equivalenza byte-per-byte con parser, canonicalizzazione, digest e golden HMAC N10/N12;
- mapping, privacy, contact minimum, importi, Unicode, limiti e config fail-closed;
- cifratura, tamper detection e assenza di PII nel record SQL;
- matrice HTTP, timeout, bounded retry ed esaurimento;
- idempotenza, CAS, lease recovery e claim concorrente su MySQL effimero;
- PHP syntax, moduli richiesti, packaging ZIP e assenza di JS/admin/public endpoint;
- conteggio invariato di 43 migration e nessun delta Prisma.

La qualifica locale offline su WordPress 7.0.2/PHP 8.4.24 e MariaDB 11.4.12 include installazione del
ZIP, default-off, callback sintetico, claim mediante wpdb, disattivazione e disinstallazione. WPForms
non è incluso nell'immagine: il test emette il suo hook con campi sintetici, senza simulare una prova
end-to-end della UI WPForms. Il trasporto HTTP è verificato con un adapter finto e confronto della
firma; non viene contattato alcun endpoint. Evidenze in
[`vnx02-local-docker-synthetic-test-evidence-r01.md`](vnx02-local-docker-synthetic-test-evidence-r01.md).
