# N10 — Integration Envelope & Lead Event Contract v1

## Stato e perimetro

N10 introduce esclusivamente il contratto business versionato e dormiente per un evento di acquisizione lead. Il contratto non è collegato alla route website esistente, non legge o scrive il database, non pubblica eventi, non attiva consumer e non modifica il comportamento di produzione.

La sola tassonomia approvabile da questa implementazione è:

| Campo | Valore v1 |
| --- | --- |
| `schemaVersion` | `fai.lead-event.v1` |
| `eventType` | `LEAD_SUBMITTED` |
| `eventVersion` | `1` |
| `canonicalizationVersion` | `1` |
| dimensione massima | 16 KiB del JSON normalizzato in UTF-8 |

Il modulo è una libreria TypeScript pura. Espone creazione, parsing/verifica e confronto dell'idempotenza, ma non è un producer né un consumer operativo.

## Boundary e ownership

| Superficie | Stato in N10 | Ownership successiva |
| --- | --- | --- |
| `src/app/api/integrations/website/leads/route.ts` | producer storico censito, invariato e non collegato al nuovo contratto | N12/N16/N17 per gateway, connector e cutover |
| `src/lib/lead-event-contract.ts` | contratto business v1 puro e dormiente | N10 |
| inbox/outbox e persistenza di replay | assenti | N11 |
| autenticazione, replay protection e nuovo gateway | assenti | N12 |
| projection, normalizzazione di dominio e duplicate resolution | assenti | N13 |
| inbox commerciale e SLA | assenti | N14 |
| communication backbone | assente | N15 |
| modifica WordPress | assente | N16 |
| canary, load e recovery del nuovo ingress | assenti | N17 |

Gli eventuali producer futuri devono costruire l'envelope con `createLeadSubmittedEventV1`. Gli eventuali consumer futuri devono validarlo con `parseLeadSubmittedEventV1` prima di interpretarne il contenuto. N10 non assegna queste responsabilità a componenti runtime esistenti.

## Contratto business e telemetria N06

L'envelope N10 contiene dati business e personali necessari alla richiesta di servizio, riferimenti privacy e digest di idempotenza. Non è un payload di telemetria.

`src/lib/operational-telemetry.ts` e il contratto N06 restano distinti e invariati. In particolare:

- l'envelope, i contatti, il testo libero e i riferimenti privacy non devono essere inviati alla telemetria;
- i codici di errore N10 sono identificatori stabili e non includono valori ricevuti;
- eventuali metriche future possono rappresentare soltanto esito e codice sicuro, applicando il contratto N06;
- `eventId`, `businessCorrelationId`, digest e payload non sono automaticamente metadati tecnici pubblicabili.

## Envelope v1

```text
LeadSubmittedEventV1
  schemaVersion, eventType, eventVersion
  eventId, businessCorrelationId, occurredAt
  source { systemCode, formCode, formVersion, submissionId }
  privacy {
    service { noticeCode, noticeVersion, purposeCode, legalBasisCode, evidenceKind, decision }
    marketing { noticeCode, noticeVersion, purposeCode, legalBasisCode, evidenceKind, decision }
  }
  catalogReference { catalogVersion, serviceCode, serviceVersion } | null
  payload { contact, interest, message, sourcePagePath, requestedAmount }
  idempotency { canonicalizationVersion, keyDigest, payloadHash }
```

Tutti gli oggetti sono chiusi: un campo sconosciuto causa rifiuto. Sono accettati soltanto oggetti dati semplici, senza array, prototype applicativi o accessor. Il valore restituito è normalizzato e congelato ricorsivamente.

## Classificazione e limiti dei campi

La classificazione usa il catalogo N04 `n04-v1`. Il gruppo indica la stessa regola applicata a ogni percorso elencato.

| Percorsi | Classificazione N04 | Limite o vincolo v1 |
| --- | --- | --- |
| `schemaVersion`, `eventType`, `eventVersion` | `OPERATIONAL` | costanti v1 |
| `eventId`, `businessCorrelationId` | `PERSONAL/CONTACT` | UUID v4, 36 caratteri, normalizzato lowercase |
| `occurredAt` | `PERSONAL/CONTACT` | profilo N10 v1 RFC 3339: frazione opzionale di 1–3 cifre, massimo 29 caratteri, input e risultato UTC negli anni `0000`–`9999`, normalizzato ISO millisecondi |
| `source.systemCode`, `source.formCode` | `OPERATIONAL` | 1–120, codice maiuscolo `[A-Z0-9_.:-]` |
| `source.formVersion` | `OPERATIONAL` | 1–80, `[A-Za-z0-9_.:-]` |
| `source.submissionId` | `PERSONAL/CONTACT` | 1–128, `[A-Za-z0-9_.:-]` |
| `privacy.*.noticeCode`, `purposeCode`, `legalBasisCode`, `evidenceKind` | `OPERATIONAL` | 1–120, codice maiuscolo |
| `privacy.*.noticeVersion` | `OPERATIONAL` | 1–80, versione contrattuale |
| `privacy.service.decision` | `PERSONAL/PRIVACY_ACKNOWLEDGEMENT` | solo `ACKNOWLEDGED` |
| `privacy.marketing.decision` | `PERSONAL/MARKETING_CHOICE` | solo `GRANTED` o `DENIED` |
| `catalogReference.catalogVersion`, `serviceCode`, `serviceVersion` | `BUSINESS` | riferimento opzionale/null; catalogo `2026-07-12-v1`, codice N09 esistente, versione servizio `1` |
| `payload.firstName`, `lastName`, `city`, `region` | `PERSONAL/CONTACT` | opzionale, massimo 1.000 caratteri |
| `payload.companyName`, `interestText`, `serviceInterestText` | `BUSINESS` | opzionale, massimo 1.000 caratteri |
| `payload.email` | `PERSONAL/CONTACT` | opzionale, massimo 254 prima e dopo lowercase, trim e forma email minima |
| `payload.phone` | `PERSONAL/CONTACT` | opzionale, input massimo 100; spazi rimossi; risultato 1–50 |
| `payload.message` | `PERSONAL/CONTACT` | opzionale, massimo 4.000 caratteri |
| `payload.sourcePagePath` | `OPERATIONAL` | opzionale, massimo 500; path relativo all'origin con un solo slash iniziale, senza query, fragment, backslash, tab/CR/LF o dot-segment letterali/percent-encoded |
| `payload.requestedAmount.currency` | `FINANCIAL` | solo `EUR` |
| `payload.requestedAmount.minorUnits` | `FINANCIAL` | intero safe JavaScript, maggiore o uguale a zero |
| `idempotency.canonicalizationVersion` | `OPERATIONAL` | costante `1` |
| `idempotency.keyDigest`, `payloadHash` | `PERSONAL/PRIVACY_EVIDENCE` | SHA-256 lowercase, 64 cifre esadecimali |

Almeno uno tra `payload.email` e `payload.phone` è obbligatorio. Le stringhe applicative sono normalizzate NFC e sottoposte a trim; stringhe opzionali vuote vengono omesse. Caratteri di controllo e marcatori bidirezionali pericolosi sono rifiutati.

I riferimenti privacy sono vincolati semanticamente:

| Ramo | `purposeCode` | `legalBasisCode` | `evidenceKind` | `decision` |
| --- | --- | --- | --- | --- |
| `service` | `SERVICE_REQUEST_FOLLOW_UP` | `PRE_CONTRACTUAL_MEASURES` | `NOTICE_ACKNOWLEDGEMENT` | `ACKNOWLEDGED` |
| `marketing` | `DIRECT_MARKETING` | `CONSENT` | `CONSENT` | `GRANTED` o `DENIED` |

Questi valori sono riferimenti dichiarati nel messaggio: non provano da soli l'esistenza di `PrivacyNoticeVersion` o `PrivacyEvidenceReceipt` e non creano evidenza legale persistita.

## Canonicalizzazione, hash e idempotenza

La rappresentazione canonica usa `canonicalJson` dopo la normalizzazione completa.

```text
keyDigest  = SHA-256("fai.lead-event.idempotency.v1\n" + canonicalJson(source))
payloadHash = SHA-256("fai.lead-event.payload.v1\n" + canonicalJson(envelope senza idempotency))
```

I domini crittografici sono separati. `source.systemCode + formCode + formVersion + submissionId` costituisce la chiave tecnica dichiarata dal producer. Email, telefono e somiglianza anagrafica non sono chiavi di idempotenza.

| Stato persistito futuro | Candidate | Esito N10 |
| --- | --- | --- |
| assente | envelope valido | `NEW` |
| `keyDigest` diverso | envelope valido | `NEW` |
| stesso `keyDigest`, stesso `payloadHash` | envelope valido | `REPLAY` |
| stesso `keyDigest`, `payloadHash` diverso | envelope valido | `CONFLICT` |

N10 calcola e confronta soltanto la semantica. Persistenza, vincoli concorrenti e replay protection appartengono a N11/N12. La deduplicazione commerciale o di dominio, inclusi casi con email/telefono uguali, appartiene a N13.

## Compatibility matrix

| Input | Comportamento v1 | Evoluzione compatibile |
| --- | --- | --- |
| schema `fai.lead-event.v1`, tipo `LEAD_SUBMITTED`, versione `1` | accettato se integralmente valido | correzioni interne che non cambiano l'output canonico |
| schema sconosciuto | rifiuto stabile | nuovo parser/schema esplicito |
| tipo evento sconosciuto | rifiuto stabile | nuova tassonomia esplicita |
| versione evento diversa | rifiuto stabile | nuova versione e matrice di upcast separata |
| campo addizionale a qualsiasi livello | rifiuto | nuova versione del contratto |
| campo opzionale assente | accettato; stringa vuota normalizzata come assente | nuovi opzionali richiedono comunque una nuova versione per non rompere i parser strict |
| `catalogReference: null` | accettato, senza inferenza dal testo | risoluzione/projection futura N13 |
| digest non corrispondenti | rifiuto | nessun fallback permissivo |

Non sono previsti downgrade silenziosi, coercizioni tra versioni o interpretazioni parziali.

## Failure matrix

Gli errori espongono solo un codice stabile e non fanno eco dei dati ricevuti.

| Codice | Condizione | Trattamento futuro atteso |
| --- | --- | --- |
| `LEAD_EVENT_ENVELOPE_INVALID` | struttura radice non valida o non serializzabile | rifiuto permanente |
| `LEAD_EVENT_SCHEMA_UNSUPPORTED` | schema diverso | rifiuto/version negotiation fuori N10 |
| `LEAD_EVENT_TYPE_UNSUPPORTED` | tipo diverso | rifiuto permanente |
| `LEAD_EVENT_VERSION_UNSUPPORTED` | versione diversa | rifiuto/version negotiation fuori N10 |
| `LEAD_EVENT_FIELD_UNKNOWN` | campo non classificato o sconosciuto | rifiuto permanente |
| `LEAD_EVENT_FIELD_INVALID` | formato, bound o dato obbligatorio invalido | rifiuto permanente |
| `LEAD_EVENT_TOO_LARGE` | JSON normalizzato oltre 16 KiB | rifiuto permanente |
| `LEAD_EVENT_PRIVACY_INVALID` | ramo privacy incompleto o semanticamente incoerente | rifiuto permanente |
| `LEAD_EVENT_CATALOG_REFERENCE_INVALID` | riferimento N09 sconosciuto o incompatibile | rifiuto permanente |
| `LEAD_EVENT_HASH_INVALID` | formato digest, tampering o stato persistito invalido | rifiuto e segnalazione tecnica priva di PII |
| `LEAD_EVENT_IDEMPOTENCY_CONFLICT` | codice riservato al mapping operativo futuro di `CONFLICT` | nessuna persistenza in N10 |
| `LEAD_EVENT_INTERNAL_FAILURE` | codice riservato al boundary operativo futuro | nessun wrapping runtime in N10 |

Retry, dead letter, quarantena e risposta HTTP non sono definiti dal modulo puro e devono essere stabiliti nelle fasi che introducono trasporto e persistenza.

## Verifica e fixture

La fixture N10 usa esclusivamente identità sintetiche e il dominio riservato `.invalid`. La matrice automatizzata copre:

- happy path, congelamento, dimensione e round-trip create/parse;
- marketing esplicito e catalogo assente senza inferenze;
- NFC, trim, lowercase email con bound post-folding, spazi telefono, offset temporali, profilo millisecondi, confini anno UTC e timestamp impossibili;
- stabilità e separazione dei digest; `NEW`, `REPLAY` e `CONFLICT`;
- esclusione di email e telefono dalla dedupe tecnica;
- campi sconosciuti, own-key non enumerabili o simboliche, accessor, oggetti non plain e assenza di echo dei valori;
- schema, tipo e versione non supportati;
- semantica privacy e validità del riferimento catalogo N09;
- contatto minimo, importo, path con controllo whitespace/dot-segment, controlli Unicode e limite 16 KiB;
- tampering dei digest e stato persistito invalido;
- copertura esatta di tutti i 42 percorsi nel catalogo di classificazione;
- assenza di dipendenze runtime, trasporto, telemetria N06 e migration.

## Decisione migration e rollback

N10 non richiede migration: il contratto è puro, non introduce modelli Prisma e lascia invariate le 37 migration esistenti. Inbox/outbox e relativi vincoli devono essere progettati e autorizzati separatamente in N11.

Il rollback applicativo locale consiste nel revert dei commit N10 o nella rimozione dei quattro file nuovi e delle sole aggiunte N10 ai due file modificati. Poiché nessun call site importa il modulo, il rollback non richiede data repair, rollback DB, cambio di configurazione, rotazione chiavi o intervento su produzione.

N10 non autorizza né realizza push, PR, merge, migration, deploy, activation, pubblicazioni di catalogo, chiavi, Stripe, WordPress o integrazioni esterne.
