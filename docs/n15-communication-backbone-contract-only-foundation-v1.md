# N15 — Communication Backbone Contract-Only Foundation v1

## Stato e perimetro

N15 Phase 1A implementa soltanto il contratto puro dello Scenario B approvato. Il modulo non è un
producer o consumer runtime, non persiste intenti e non invia comunicazioni.

| Proprietà | Valore Phase 1A |
| --- | --- |
| schema | `fai.communication-intent.v1` |
| tipo | `COMMUNICATION_INTENT` |
| versione | `1` |
| canonicalizzazione | `1` |
| direzione | `OUTBOUND` |
| classi | `TRANSACTIONAL`, `SERVICE`, `SECURITY` |
| stati | `RECORDED`, `HELD` |
| activation | `NONE` |
| persistence / adapter N11 | `NONE` / `NONE` |
| transport / provider | `NONE` / lista vuota |
| worker / dispatch / egress | vietati |
| recipient | riferimento CRM, nessun endpoint snapshot |
| body e variabili renderizzate | assenti |
| dimensione massima intent | 8 KiB JSON normalizzato UTF-8 |

`COMMUNICATION_INTENT_MANIFEST` rende queste proprietà verificabili. Non esistono variabili
ambiente N15, modalità enforced o call-site applicativi.

## Confine N11–N15

N11 resta legato all'envelope N10 `fai.lead-event.v1`, al tipo `LEAD_SUBMITTED`, al receipt inbound
e alla projection lead. Phase 1A riusa soltanto convenzioni osservate: oggetti chiusi, error code
stabili, hash domain-separated, valori congelati e test deterministici. Non importa
`business-event-backbone`, non usa `BusinessOutboxEvent` e non definisce un adapter N11.

N12 non viene esteso a webhook provider. N13 conserva ownership dell'identità/deduplica lead. N14
conserva ownership di attribution e SLA. `PracticeCommunication` resta editoriale/manuale e non
viene reinterpretata come delivery receipt.

## Contratto dell'intento

```text
CommunicationIntentV1
  schemaVersion, intentType, intentVersion
  intentId, businessCorrelationId, occurredAt
  source { producerCode }
  recipient { authorityCode: CRM, entityType, entityId }
  message {
    messageClass, reasonCode
    templateReference { templateCode, templateVersion, templateHash }
  }
  policySnapshot {
    policyReferenceCode: N15_PHASE1A_UNASSIGNED
    policyVersion: UNASSIGNED
    decision: NOT_EVALUATED
    reasonCode: N15_POLICY_UNASSIGNED
  }
  state: RECORDED
  idempotency { canonicalizationVersion, keyDigest, semanticHash, envelopeHash }
```

L'input di creazione aggiunge `source.callerIdempotencyKey`. La chiave grezza viene normalizzata,
usata per il digest e rimossa dall'output. Il contratto non ammette channel, provider, locale,
subject, body, variabili, URL o recapiti.

Gli oggetti sono plain, exact-record e accessor-safe. Own key sconosciute, simboli, proprietà non
enumerabili, prototype applicativi e proxy non leggibili vengono rifiutati. Codici e versioni sono
ASCII bounded; UUID v4 e timestamp vengono canonicalizzati. `entityId` ammette soltanto le forme
UUID v4 o CUID v1 già usate dal CRM. I tipi recipient chiusi sono `LEAD`, `CLIENT`, `PERSON`,
`COMPANY`, `USER`.

## Classificazione N04

`dataClassificationCatalog` aggiunge tre contratti:

- `communication_intent_v1`: identificatori CRM e correlation come dati personali; codici come
  operativi; riferimenti template come business; digest come privacy evidence;
- `communication_held_decision_v1`: binding, timestamp e hash della decisione;
- `communication_audit_record_v1`: soli hash e codici minimizzati.

Ogni output viene verificato con `assertClassifiedFields`. Un nuovo campo non classificato fallisce
chiuso. Tutte le regole N15 usano purpose `N15_PHASE1A_UNASSIGNED` e legal-basis marker
`DPO_VALIDATION_REQUIRED`: non ereditano basi giuridiche dai contratti CRM preesistenti. Phase 1A
non sceglie base giuridica, consenso, opt-out o retention; lo snapshot fisso `NOT_EVALUATED`
impedisce inferenze legali.

## Canonicalizzazione e idempotenza

Tutti gli hash usano SHA-256 lowercase sul `canonicalJson` già normalizzato.

```text
keyDigest = SHA-256(
  "fai.communication-intent.idempotency-key.v1\n" +
  canonicalJson({ producerCode, callerIdempotencyKey })
)

semanticHash = SHA-256(
  "fai.communication-intent.semantic.v1\n" +
  canonicalJson({
    businessCorrelationId, source, recipient, message, policySnapshot
  })
)

envelopeHash = SHA-256(
  "fai.communication-intent.envelope.v1\n" +
  canonicalJson(intent completo senza envelopeHash)
)
```

`semanticHash` esclude `intentId`, `occurredAt` e lo stato tecnico: un retry con la stessa chiave e
la stessa semantica resta `REPLAY` anche se ricostruisce un envelope. `envelopeHash` vincola invece
l'envelope esatto.

| Stato futuro | Candidate | Esito puro |
| --- | --- | --- |
| assente | valido | `NEW` |
| `keyDigest` diverso | valido | `NEW` |
| stesso `keyDigest`, stesso `semanticHash` | valido | `REPLAY` |
| stesso `keyDigest`, `semanticHash` diverso | valido | `CONFLICT` |

Il modulo calcola e confronta soltanto la semantica. Non assegna ordering, TTL, unicità concorrente
o persistenza.

Golden vector sintetico Phase 1A:

| Hash | Valore |
| --- | --- |
| `keyDigest` | `eb0d0f57c07c0c5e40e100ff32ef57efa29839288b219a15093247bd122402e5` |
| `semanticHash` | `18545c3aaa0ff2bef397278ac6a0ed09ec795abb6ea4ec69b4b5eeac97ff4b2a` |
| `envelopeHash` | `2bca3a73d3855551c3e014260fbeddc17da82ce28a7bc22c77afb7a1597a47ba` |

## Gate e lifecycle

La gerarchia chiusa contiene, in ordine, `CAPABILITY`, `WORKER`, `DISPATCH`, `EGRESS`, `CHANNEL`,
`PROVIDER`, `TENANT`. Uno snapshot osserva per ogni gate `ENABLED`, `DISABLED`, `MISSING` o
`ERROR`.

La regola astratta all-of è soddisfatta soltanto quando tutti e sette sono esattamente `ENABLED`.
Input assente, incompleto, extra, ereditato, con accessor, non plain o non canonico viene tradotto
in `MISSING`/`ERROR` e nega. Il default Phase 1A è profondamente congelato e ha tutti i gate
`DISABLED`.

La regola astratta non abilita il runtime: ogni snapshot Phase 1A ha `decision: HELD`. Anche il
vettore tutto-enabled produce `N15_PHASE1A_DORMANT`. L'unica transizione prevista è:

```text
RECORDED --(policy non valutata + gate fail-closed)--> HELD
```

Non esistono stati ready, queued, attempted, sent o delivered. La decisione `HELD` lega intent,
correlation, `semanticHash`, `envelopeHash`, policy, gate e timestamp esplicito nel proprio
`decisionHash`; non legge un clock implicito e rifiuta valutazioni antecedenti all'intento.

## Audit minimizzato

`createCommunicationAuditRecordV1` valida che intento e decisione siano legati e costruisce il
record campo per campo. Non esegue spread dell'intento.

Il record contiene:

- hash separati di intent, correlation, source, recipient, template e gate snapshot;
- class code e hash domain-separated del reason reference dichiarato dal caller;
- riferimenti/reason code dello snapshot policy;
- `RECORDED -> HELD`;
- digest/hash di idempotenza e `decisionHash`.

Non contiene UUID, entity ID, caller key, template code/version, body, recapito, endpoint, secret o
errore libero. Il record passa invariato attraverso `redactAuditPayload`, ma Phase 1A non lo scrive
in `AuditLog` e non emette telemetria N06.

## Mock unit-test-only

Il mock deterministico risiede in `tests/fixtures/n15-communication-mock.ts`, non in `src`. Usa lo
snapshot tutto-disabilitato e restituisce sempre:

- `outcome: HELD`;
- `dispatch: NOT_ATTEMPTED`;
- persistence, network, dispatch, egress e delivery tutti `false`;
- soli hash e reason code, con `resultHash` domain-separated.

Non usa random, clock implicito, env, filesystem, rete, callback o provider fallback. Il
Dockerfile runtime copia `src` ma non `tests`, quindi il mock non entra nell'immagine production.

## Failure e compatibility matrix

Gli errori espongono soltanto codici `COMMUNICATION_INTENT_*` e non fanno echo dell'input.

| Caso | Esito v1 |
| --- | --- |
| schema/tipo/versione sconosciuti | rifiuto esplicito |
| classe diversa dalle tre approvate | `COMMUNICATION_INTENT_CLASS_UNSUPPORTED` |
| recipient non CRM, tipo/ID invalido | `COMMUNICATION_INTENT_RECIPIENT_INVALID` |
| template non referenziale o hash invalido | `COMMUNICATION_INTENT_TEMPLATE_INVALID` |
| policy diversa dallo snapshot fisso | `COMMUNICATION_INTENT_POLICY_INVALID` |
| campo sconosciuto o non classificato | fail-closed |
| digest/hash manomesso | `COMMUNICATION_INTENT_HASH_INVALID` |
| snapshot gate non canonico | rifiuto o valutazione `HELD` fail-closed |
| transizione diversa da `RECORDED -> HELD` | rifiuto |
| binding audit divergente | `COMMUNICATION_INTENT_AUDIT_INVALID` |

Nuove classi, recipient type, campi, stati o decisioni di policy richiedono una nuova versione o
una revisione esplicita della compatibility matrix; non sono previsti downgrade o coercizioni.

## Qualification

I test coprono:

- manifest, create/parse, deep freeze, bound e golden hash;
- classi approvate e rifiuto marketing/commercial/promotional;
- recipient CRM UUID/CUID senza endpoint e rifiuto di body/recapiti;
- input ostili, accessor, symbol, prototype, proxy, timestamp e tampering;
- idempotenza `NEW/REPLAY/CONFLICT` e separazione dei domini hash;
- tutte le 128 combinazioni enabled/disabled dei sette gate, più missing/error/invalid;
- unica transizione `RECORDED -> HELD` e decision hash;
- allowlist audit, redazione e classificazione esatta N04;
- 100 esecuzioni identiche del mock e side effect tutti falsi;
- import closure senza Prisma, N11, env, I/O, rete, timer o random;
- assenza di call-site runtime e di mock sotto `src`;
- schema Prisma senza modelli N15 e conteggio invariato di 42 migration.

## Migration, release e rollback

Phase 1A non modifica Prisma o migration e lascia il catalogo a 42. Non modifica package/lockfile,
CI, environment, Docker, deploy o script. Non introduce route, action, worker, scheduler, cron,
provider, webhook, secret, dispatch, egress o destinatari reali.

Il rollback è il revert applicativo dei file Phase 1A e delle tre classificazioni N04. Non esistono
righe, receipt, attempt o backlog da riparare. Draft PR, review e CI non costituiscono deploy o
activation; qualunque passo successivo richiede un nuovo mandato umano.
