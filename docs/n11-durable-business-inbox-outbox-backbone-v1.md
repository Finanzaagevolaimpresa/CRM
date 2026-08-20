# N11 — Durable Business Inbox/Outbox Backbone v1

## Stato e boundary

N11 aggiunge una fondazione persistente business, dormiente e separata per l'envelope N10 `fai.lead-event.v1` / `LEAD_SUBMITTED`. Le tre tabelle sono inizialmente vuote e nessuna funzione N11 ha call site in route, worker, scheduler, timer, script, UI o telemetria.

N11 non collega la route website N01, non crea o aggiorna `Lead`, non esegue projection o duplicate resolution, non autentica producer, non introduce replay window o rate limit v2, non invia comunicazioni e non effettua network egress. Restano fuori scope N12–N17, N21, provider esterni, catalog publication, Stripe, checkout, deploy e activation.

Il modello è distinto sia da `WebsiteLeadReceipt`, che appartiene al contenimento legacy N01, sia da `AiWorkflowJobOutboxEvent`, che appartiene all'orchestrazione AI. Non esistono FK o lock verso `Lead`, N01, privacy evidence o tabelle AI.

## Contratto persistito

### `BusinessInboxEvent`

La inbox conserva l'envelope N10 normalizzato come JSON canonico, con un massimo di 16 KiB UTF-8. I discriminatori sono fissi a schema `fai.lead-event.v1`, tipo `LEAD_SUBMITTED`, versione evento `1` e canonicalizzazione `1`.

L'identità comprende UUID v4 `eventId`, UUID v4 `businessCorrelationId`, `keyDigest`, `payloadHash` e `recordHash`. `occurredAt` è una stringa `char(24)` nel formato canonico UTC `YYYY-MM-DDTHH:mm:ss.sssZ`, così l'anno `0000` accettato da N10 non viene perso da un tipo timestamp PostgreSQL.

La classificazione è fissa a catalogo `n04-v1` e contratto `lead_business_event_v1`. I metadati retention sono `LEAD_BUSINESS_EVENT` / `N21_UNASSIGNED`; `retentionEligibleAt` resta nullo e immutabile in N11. Non esiste cancellazione automatica.

### `BusinessOutboxEvent`

La outbox deriva esclusivamente da una `BusinessInboxEvent` valida, acquisita `FOR KEY SHARE`. L'API accetta soltanto `sourceInboxEventId`, `producerCode` e `destinationCode`: envelope, digest e identità business sono copiati dalla inbox e riverificati byte-per-byte.

La dedupe è `(producerCode, destinationCode, keyDigest)`. Lo stesso evento può quindi avere destinazioni distinte; `eventId` è indicizzato ma non unique nella outbox. La FK sorgente usa `RESTRICT`.

### `BusinessQueueAttempt`

Ogni claim crea un tentativo append-only con una sola FK, inbox o outbox, coerente con `queueKind`. `attemptSequence` e `fencingToken` sono unique parzialmente per la rispettiva coda. Claim identity, token hash, tempi e `attemptHash` sono immutabili; la chiusura è completa, write-once e protetta da `completionHash`.

Il token lease raw è materiale random a 256 bit, restituito una sola volta al caller interno. Solo il suo hash domain-separated è persistito. Errori e codici non contengono token, envelope, ID, digest o valori ricevuti.

## Hash e verifica fail-closed

I domini v1 sono:

| Segmento | Dominio |
| --- | --- |
| inbox record | `fai.business-inbox.record.v1` |
| outbox record | `fai.business-outbox.record.v1` |
| lease token | `fai.business-queue.lease-token.v1` |
| attempt | `fai.business-queue.attempt.v1` |
| completion | `fai.business-queue.attempt-completion.v1` |

Admission, replay, enqueue e claim richiamano `parseLeadSubmittedEventV1`, ricostruiscono il JSON canonico N10 e verificano i campi duplicati e gli hash N11. Una riga incoerente produce `BUSINESS_QUEUE_INTEGRITY_FAILURE`: non viene mai restituita come replay o lease.

Gli hash forniscono tamper evidence applicativa. L'owner o un superuser PostgreSQL può tecnicamente sostituire o disabilitare trigger e non è quindi coperto da una pretesa di immutabilità crittografica.

## Idempotenza e concorrenza

L'admission usa `READ COMMITTED` e un unico `INSERT ... ON CONFLICT DO NOTHING RETURNING`. I unique DB su `keyDigest` ed `eventId` scelgono il vincitore senza advisory lock.

| Stato | Candidate | Esito |
| --- | --- | --- |
| nessuna identità esistente | N10 valido | `NEW` |
| key, eventId, payload hash e bytes identici | N10 valido | `REPLAY` |
| stessa key con qualsiasi differenza immutabile | N10 valido | `CONFLICT` |
| stesso eventId con key o payload diverso | N10 valido | `CONFLICT` |
| key ed eventId diversi | N10 valido | `NEW` |
| riga esistente incoerente | qualsiasi | fail-closed |

Claim e recovery usano `FOR UPDATE SKIP LOCKED`, ordinamento stabile e clock PostgreSQL. Il claim restituisce al massimo una riga; la recovery processa al massimo 100 righe per invocazione e non contiene loop, scheduler o timer.

Il lock order è parent inbox, coda, attempt. Le transazioni hanno `lock_timeout=1000ms`, `statement_timeout=4000ms`, timeout 5000ms e max wait 2000ms. Sono ammessi al massimo tre tentativi per `40001`, `40P01`, `55P03` o Prisma `P2034`, con ritardi deterministici 10 ms e 25 ms.

## State machine

### Inbox

| Da | Operazione | A |
| --- | --- | --- |
| assente | admission | `AVAILABLE` |
| `AVAILABLE` | claim | `LEASED` |
| `LEASED` | heartbeat | `LEASED` |
| `LEASED` | completion | `PROCESSED` |
| `LEASED` | failure retryable con budget | `AVAILABLE` |
| `LEASED` | failure permanente o budget esaurito | `DEAD_LETTER` |
| `LEASED` scaduta | recovery | `AVAILABLE` o `DEAD_LETTER` |

`PROCESSED` e `DEAD_LETTER` sono terminali.

### Outbox

La matrice è identica, con `PUBLISHED` al posto di `PROCESSED`. `PUBLISHED` e `DEAD_LETTER` sono terminali. Ogni transizione non elencata è rifiutata sia dal servizio sia dai trigger DB.

Ogni claim incrementa `attemptCount` e `fencingToken`. La lease iniziale è 60 secondi, estendibile entro il massimo assoluto di 300 secondi dal claim. Completion, failure e heartbeat applicano CAS su stato, owner, fencing e token hash e rifiutano lease scadute.

Il budget è di cinque claim. I primi quattro fallimenti retryable usano backoff 5, 30, 300 e 1800 secondi. Il quinto fallimento/expiry o un fallimento permanente termina in `DEAD_LETTER`. La quarantena non duplica il payload.

## Vincoli e trigger

La migration `20260820120000_durable_business_inbox_outbox_backbone_v1` crea solo i tre oggetti N11, PK/FK `RESTRICT`, check, unique, indici e guard v1. Non contiene business DML, backfill, seed, copia N01, aggiornamenti di feature gate, capability, worker o timer.

I check coprono discriminatori N10, UUID v4, digest SHA-256 lowercase, envelope 1–16384 byte, codici bounded, contatori, lease, stati terminali, target attempt e chiusura completa. Gli indici coprono claim, recovery, correlation, retention, source, dedupe e attempt uniqueness.

I trigger `fai_business_inbox_event_guard_v1`, `fai_business_outbox_event_guard_v1` e `fai_business_queue_attempt_guard_v1` rendono immutabili identità/payload/hash/classificazione/sorgente/retention/createdAt, applicano la state machine e impediscono delete, truncate e riapertura dei tentativi.

## Privacy e telemetria

Envelope, payload, PII, `eventId`, `businessCorrelationId`, digest, record/attempt hash e token hash non sono telemetria N06 e non vengono inviati a `operational-telemetry.ts`. Un futuro call site potrà emettere soltanto outcome enumerati, failure code sicuri, durata e contatori aggregati, con autorizzazione separata.

I test usano solo dati sintetici e domini riservati `.invalid`. N11 non accede a dati reali e non muta database persistenti.

## Errori stabili

- `BUSINESS_INBOX_EVENT_INVALID`
- `BUSINESS_INBOX_HASH_INVALID`
- `BUSINESS_INBOX_IDEMPOTENCY_CONFLICT`
- `BUSINESS_OUTBOX_SOURCE_INVALID`
- `BUSINESS_OUTBOX_IDEMPOTENCY_CONFLICT`
- `BUSINESS_QUEUE_STATE_CONFLICT`
- `BUSINESS_QUEUE_LEASE_STALE`
- `BUSINESS_QUEUE_RETRY_EXHAUSTED`
- `BUSINESS_QUEUE_DATABASE_CONFLICT`
- `BUSINESS_QUEUE_INTEGRITY_FAILURE`
- `BUSINESS_QUEUE_INTERNAL_FAILURE`

## Qualification e rollback

La qualification applica tutte le 38 migration soltanto su PostgreSQL effimero loopback con database `fai_crm_test`, schema `public` e comment sentinel `FAI_CRM_EPHEMERAL_TEST_ONLY_V1`. Copre chain fresh e 37→38, tabelle vuote, idempotenza, race con almeno 32 caller, outbox atomica, claim, heartbeat, stale lease, retry/dead-letter, recovery bounded, trigger negativi e almeno otto processi separati. Il seed production viene eseguito due volte e deve lasciare le tabelle N11 vuote.

Prima di qualsiasi deploy persistente, il rollback è il revert dei commit o la chiusura della Draft PR: non esiste data rollback perché soltanto il DB effimero è autorizzato.

Dopo un futuro deploy dormant separatamente autorizzato, lo schema resta expand-only e l'applicazione precedente ignora le nuove tabelle. Lo schema può essere rimosso soltanto se le tre tabelle sono vuote e non esistono dipendenze: trigger, funzioni, FK, indici e tabelle vanno rimossi in ordine inverso. Se esiste anche una sola riga, il down distruttivo è vietato e serve un forward fix o restore autorizzato.
