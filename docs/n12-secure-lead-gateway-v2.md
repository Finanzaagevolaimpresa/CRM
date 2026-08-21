# N12 — Secure Lead Gateway v2

## Stato e confine dello slot

N12 introduce un ingresso autenticato e versionato per il contratto business N10 e lo collega
all'inbox autorevole N11. La feature è **dormant**, `OFF` per default e non sostituisce la route
legacy N01.

Questa foundation non configura chiavi, non abilita gate, non genera traffico, non crea Lead e non
introduce worker, scheduler, dispatcher, consumer o egress. La projection e la risoluzione duplicati
commerciale restano N13; inbox commerciale, attribution e SLA restano N14; communication backbone
resta N15; connector WordPress e cutover restano N16; canary/load/recovery restano N17; retention
enforcement e cancellazione restano N21.

Baseline sorgente dello slot: merge PR105 `0868b8fdd94ffc2a020a68d607a79a9adde50f87`,
tree `091f0e85201c23c74165a680224938619e483781`, schema a 38 migration. N12 aggiunge soltanto la
migration 39 `20260821120000_secure_lead_gateway_v2`.

## Trust boundary HTTP

| Proprietà | Contratto N12 |
|---|---|
| Metodo | `POST` |
| Path | `/api/integrations/website/leads/v2` |
| Query string | vietata |
| Content-Type | esattamente `application/vnd.fai.lead-event.v1+json` |
| Content-Encoding | vietato |
| Body | envelope N10 completo, canonicale, massimo 16.384 byte |
| Timeout complessivo | 5.000 ms, condiviso da gate, body, autenticazione, rate e admission |
| Runtime | Node.js, route dinamica |

Il boundary non considera IP, `User-Agent` o header forwarded come identità di sicurezza. L'identità
di rate e replay deriva esclusivamente dal `producerCode` persistito della versione chiave.

### Header obbligatori

| Header | Formato |
|---|---|
| `X-FAI-Key-Id` | 3–80 caratteri ASCII, case-sensitive, `[A-Za-z0-9][A-Za-z0-9._:-]*` |
| `X-FAI-Timestamp` | esattamente 10 cifre, Unix seconds |
| `X-FAI-Nonce` | esattamente 32 caratteri esadecimali lowercase, 128 bit |
| `X-FAI-Signature` | `v1=` seguito da 64 caratteri esadecimali lowercase |
| `Content-Length` | opzionale; intero decimale canonico tra 0 e 16.384, coerente con i byte letti |

Valori duplicati/aggregati con virgola e valori oltre i bound sono negati. Gli header di
autenticazione malformed ma bounded percorrono una verifica HMAC dummy prima della risposta 401;
questo evita un percorso rapido per `keyId` sconosciuti. Il confronto finale usa buffer di 32 byte e
`timingSafeEqual`.

## Firma raw-body

Algoritmo: HMAC-SHA-256 con segreto binario di esattamente 32 byte.

I byte firmati sono, senza canonicalizzazione o reinterpretazione intermedia:

```text
ASCII("fai.secure-lead-gateway.request.v1\n")
|| ASCII("POST\n")
|| ASCII("/api/integrations/website/leads/v2\n")
|| ASCII("application/vnd.fai.lead-event.v1+json\n")
|| ASCII(keyId + "\n")
|| ASCII(timestamp + "\n")
|| ASCII(nonce + "\n")
|| ASCII(rawBodyLengthDecimal + "\n")
|| RAW_BODY_BYTES
```

La signature trasmessa è `v1=` più il digest HMAC lowercase. La firma viene verificata sui byte raw
prima della decodifica UTF-8 e del parsing JSON. Dopo una decodifica UTF-8 fatal, N12 usa il parser
strict N10 e richiede che `canonicalJson(normalizedEvent)` coincida byte-per-byte col body ricevuto.
Whitespace alternativo, ordine diverso, chiavi duplicate, BOM e valori che richiederebbero
normalizzazione sono quindi respinti; N12 non reinterpreta il contratto N10.

## Key identity, storage e rotazione

N12 usa `SecureLeadGatewayKeyVersion`, separata da `ApplicationKeyVersion`. Non riusa
`WebsiteLeadReceipt`, `WebsiteLeadRateLimitBucket` o la key ownership N03.

Il DB conserva soltanto:

```text
SHA-256(ASCII("fai.secure-lead-gateway.key.v1\n") || RAW_SECRET_32_BYTES)
```

Il materiale raw è ammesso soltanto in un file runtime direttamente sotto `/run/secrets`:

- file regolare, non symlink;
- nessun permesso group/world;
- massimo 4 KiB;
- JSON strict versione 1;
- nomi proprietà duplicati vietati dopo la decodifica degli escape JSON;
- massimo quattro entry univoche;
- ogni `secretBase64` deve decodificare in esattamente 32 byte e avere codifica base64 canonica.

Schema del file, senza valori reali:

```json
{
  "version": 1,
  "keys": [
    {
      "keyId": "<bounded-key-id>",
      "secretBase64": "<canonical-base64-of-32-random-bytes>"
    }
  ]
}
```

L'accettazione richiede consenso tra file runtime e riga DB: stesso `keyId`, digest, versione,
producer, stato e finestra temporale. Stati ammessi: `STAGED`, `ACTIVE`, `RETIRING`, `REVOKED`,
`RETIRED`. Per producer esistono al massimo una chiave `ACTIVE` e una `RETIRING`; l'overlap di
rotazione è massimo 900 secondi. Ogni inserimento è ammesso soltanto in stato `STAGED`; le altre
condizioni sono raggiungibili esclusivamente tramite le transizioni DB protette. La revoca è
immediata. La transazione finale rilegge la riga
`FOR SHARE`, così una revoca già linearizzata prima dell'admission produce 401 e rollback.

Una chiave DB eleggibile ma assente dal keyring produce 401. Un digest discordante produce 503
soltanto dopo che la firma è risultata valida rispetto al materiale locale; una firma invalida resta
401. In questo modo il drift di configurazione non rende enumerabili i `keyId` registrati.

La migration non inserisce chiavi e gli env example lasciano il keyring non configurato.

## Clock, nonce e replay

Il clock autorevole è PostgreSQL `clock_timestamp()`, troncato al secondo per la verifica del
timestamp. Lo skew è inclusivo a ±300 secondi. Un errore di clock è indistinguibile dagli altri errori
di autenticazione.

Il nonce raw non viene persistito. N12 salva:

```text
nonceDigest = SHA-256(
  ASCII("fai.secure-lead-gateway.nonce.v1\n")
  || ASCII(producerCode + "\n" + nonce)
)

requestFingerprint = SHA-256(
  ASCII("fai.secure-lead-gateway.replay.v1\n")
  || signedBytes
)
```

La unique key è `(producerCode, nonceDigest)`. Receipt e request diventano eleggibili per retention
dopo 24 ore con policy `N21_UNASSIGNED`; fino a N21 nessun job le cancella e il vincolo unique resta
più forte della sola finestra dichiarata.

## Rate limit v2

Il rate limit è un GCRA persistente PostgreSQL:

- identità: `producerCode`, stabile attraverso la rotazione;
- emission interval: 1 secondo;
- burst: 10;
- sustained rate: 60 richieste/minuto;
- stato: `theoreticalArrivalAt` in `SecureLeadGatewayRateLimitBucket`;
- serializzazione: advisory transaction lock per producer più row lock;
- clock: PostgreSQL;
- `Retry-After`: intero tra 1 e 60 secondi.

Una richiesta autenticata consuma quota anche se il successivo parsing N10 termina 400, il replay
termina 409, N11 fallisce o scade il budget. La transazione rate è separata e committa prima della
transazione business. Una richiesta già 429 non avanza ulteriormente il TAT. In `shadow` non viene
eseguita alcuna mutazione rate/replay/inbox.

## Gate e modalità

`SECURE_LEAD_GATEWAY_MODE` accetta soltanto:

- `disabled`: risposta 503 prima di body, keyring e DB;
- `shadow`: richiede consenso `FEATURE_INTEGRATIONS_ENABLED=true` più gate DB `INTEGRATIONS`,
  keyring valido, firma valida e N10 canonico; non scrive nulla e risponde sempre 503;
- `enforced`: richiede lo stesso consenso e abilita rate più admission.

Valore mancante, sconosciuto o con casing diverso equivale a `disabled`. Tutti gli env example e il
CI impostano `disabled`; la migration non aggiorna `ApplicationFeatureGate`. Nessuna modalità è stata
attivata da N12.

## Transaction boundary N11

N11 espone `admitBusinessInboxEventInTransaction(tx, envelope)` mantenendo invariato il wrapper
pubblico esistente. La transazione finale N12 esegue, in ordine:

1. rilettura `FOR SHARE` della key version e verifica completa dello stato;
2. advisory transaction lock sul digest nonce del producer;
3. lookup replay;
4. per un nonce nuovo, admission N11 nella stessa transazione;
5. creazione o riuso della receipt unica per `inboxEventId`;
6. inserimento della request replay;
7. commit;
8. risposta 202 soltanto dopo il commit.

| Caso | Mutazioni | Risposta |
|---|---|---|
| nonce nuovo, N11 `NEW` | inbox + receipt + request | 202 |
| nonce nuovo, N11 `REPLAY` | receipt unica + request, inbox esistente | 202 |
| stesso nonce, stesso fingerprint | nessuna nuova admission; receipt stabile | 202 |
| stesso nonce, fingerprint diverso | nessuna mutazione business | 409 |
| conflitto N11 | rollback receipt/request candidate | 409 |
| revoca che precede la revalidation finale | rollback completo | 401 |
| fault, deadline o integrità | rollback completo | 503 |

Il rate già consumato resta persistito nei casi successivi all'autenticazione.

Ogni transazione Prisma riserva il budget residuo tra attesa di acquisizione ed esecuzione:

```text
maxWait + transactionTimeout = remainingRequestBudget
```

I timeout PostgreSQL di lock e statement vengono poi ricalcolati dentro il callback, dopo
l'acquisizione. L'attesa del pool non può quindi estendere il budget HTTP condiviso di 5.000 ms.

## Receipt e status HTTP

La receipt esterna è `slg2_` più 32 caratteri esadecimali lowercase derivati da un UUID v4 dedicato.
Non è un Lead ID, event ID, inbox ID, correlation ID o business digest. Lo stesso evento inbox usa una
sola receipt.

| Status | Codice pubblico | Semantica |
|---|---|---|
| 202 | success body `{ "ok": true, "receipt": "slg2_…" }` | NEW e REPLAY indistinguibili |
| 400 | `INVALID_REQUEST` | media, JSON, canonicalità o N10 invalidi |
| 413 | `INVALID_REQUEST` | body oltre 16 KiB |
| 401 | `UNAUTHORIZED` | header, key, timestamp o HMAC invalidi |
| 409 | `CONFLICT` | nonce o idempotenza business in conflitto |
| 429 | `RATE_LIMITED` | quota GCRA, con `Retry-After` |
| 503 | `TEMPORARILY_UNAVAILABLE` | disabled/shadow/gate/DB/deadline/integrità |
| 405 | framework | metodi diversi da POST |

Ogni risposta imposta `Cache-Control: no-store` e `Pragma: no-cache`. Gli errori non includono
receipt, header, digest, dettaglio di validazione o valore ricevuto.

## Migration 39

La migration è racchiusa in `BEGIN`/`COMMIT`, è expand-only e lascia quattro tabelle vuote:

1. `SecureLeadGatewayKeyVersion`
   - `id`, `producerCode`, `keyId`, `version`, `secretDigest`, `status`;
   - `acceptFrom`, `acceptUntil`, `revokedAt`, `retiredAt`, `createdAt`, `updatedAt`.
2. `SecureLeadGatewayRateLimitBucket`
   - `producerCode`, `theoreticalArrivalAt`, `createdAt`, `updatedAt`.
3. `SecureLeadGatewayReceipt`
   - `id`, `inboxEventId`, `receiptVersion`, retention fields, `createdAt`.
4. `SecureLeadGatewayRequest`
   - `id`, `producerCode`, `keyVersionId`, `nonceDigest`, `requestFingerprint`, `receiptId`,
     retention fields, `createdAt`.

Sono presenti unique key, indici di lookup/retention, FK `RESTRICT`, constraint su digest/lifecycle e
trigger. Receipt e request sono immutabili e non cancellabili; il bucket rate non può regredire; la
key version ha transizioni chiuse e identità immutabile. La migration non contiene backfill, seed,
copie N01, chiavi, eventi, gate update o activation.

## Privacy e telemetria

N12 estende il catalogo di classificazione con `secure_lead_gateway_security_state_v2`.

- secret e signature: `AUTHENTICATION_SECRET`, solo memoria/file runtime;
- raw body e envelope N10: PII/business data, persistiti soltanto nell'inbox N11 canonica;
- key digest, nonce digest e request fingerprint: security state DB-only;
- receipt e inbox binding: dato personale pseudonimo DB-only, receipt esposta solo al client in 202;
- IP, `User-Agent` e forwarded headers: non letti né persistiti.

N12 non importa `operational-telemetry.ts`, non scrive `AuditLog`, non usa `console`, exporter o
transport. Secret, signature, raw nonce, raw body, envelope, PII, eventId, correlationId, business
digest, request fingerprint e receipt non entrano nella telemetria N06.

## Compatibilità e rollback

La route N01 e `src/lib/website-lead-security.ts` restano invariate. N12 non esegue cutover, non
modifica WordPress e non riusa le tabelle N01 o `ApplicationKeyVersion`.

Prima del merge il rollback è la chiusura/revert della PR N12. Un futuro deploy dormant richiederà:

1. nuovo backup pre-N12 verificato;
2. immagine applicativa PR105 come rollback;
3. verifica che PR105 resti healthy sullo schema additivo 39;
4. nessun riuso automatico del backup pre-N11.

La migration 39 può restare applicata durante il rollback applicativo perché è expand-only. Un down
schema è consentibile soltanto con tutte e quattro le tabelle N12 vuote e senza dipendenze; in ogni
altro caso servono forward fix o restore autorizzato. Provisioning chiavi, `shadow`, traffico sintetico,
canary, traffico reale, cutover e activation richiedono mandati separati.

## Qualifica

La suite N12 copre:

- golden vector HMAC, tamper, header/bounds, UTF-8 fatal e canonicalità N10;
- keyring protetto, digest consensus, skew e revoca;
- migration fresh 39 e upgrade 38→39;
- GCRA concorrente, burst/refill e identità stabile in rotazione;
- matrice NEW/REPLAY/CONFLICT e convergenza di receipt/inbox;
- almeno otto processi isolati;
- fault injection dopo admission e persistenza separata della quota;
- guardie DB, corruzione fail-closed e assenza di effetti N01/Lead/outbox/attempt;
- full unit, PostgreSQL, lint, typecheck, build, Docker smoke, staging preflight e restore/N−1 in CI.

La qualifica non configura secret reali, non accede alla produzione e non abilita il gateway.
