# ADR-0014 — N15 Communication Intent Dedicated Persistence Boundary v1

## Stato e autorità

`ACCETTATA_COME_DECISIONE_ARCHITETTURALE_NON_IMPLEMENTATA`

Questa ADR registra la decisione umana N15 Phase 1B approvata per la sola Phase 1C:

- **Opzione C** come futuro boundary fisico e semantico della persistenza N15;
- riuso dell'**Opzione B** limitato alle sole primitive pure realmente domain-neutral;
- stato operativo corrente ancora contract-only, con tutti i gate off;
- **Opzione A**, generalizzazione in-place delle tabelle N11, respinta.

La Phase 1C è esclusivamente documentale e test-guard. Questa ADR non implementa e non autorizza
schema, migration, persistenza, repository, runtime, deploy, produzione o activation. Estende
ADR-0013 senza sostituire o modificare il contratto Phase 1A.

## Manifest della decisione Phase 1C

```text
N15_PHASE1C_DECISION_STATUS=ACCEPTED_ARCHITECTURE_NOT_IMPLEMENTED
N15_PHASE1C_TARGET_STORAGE_BOUNDARY=DEDICATED_N15
N15_PHASE1C_SHARED_PRIMITIVES=PURE_ONLY
N15_PHASE1C_CURRENT_SCHEMA=UNCHANGED
N15_PHASE1C_CURRENT_MIGRATIONS=42
N15_PHASE1C_CURRENT_PERSISTENCE=NONE
N15_PHASE1C_CURRENT_RUNTIME=NONE
N15_PHASE1C_CURRENT_ACTIVATION=NONE
N15_PHASE1C_N11_STORAGE_REUSE=FORBIDDEN
N15_PHASE1C_N11_ADAPTER=NONE
N15_PHASE1C_QUEUE_LIFECYCLE=DEFERRED
N15_PHASE1C_F1_REMEDIATION=OUT_OF_SCOPE
```

## Baseline ed evidenza

Baseline ricertificata all'avvio della Phase 1C:

| Elemento | Valore |
| --- | --- |
| repository | `Finanzaagevolaimpresa/CRM` |
| branch | `main` |
| commit | `ee19c8469a14940b92adc1f6490f8b7320981e52` |
| tree | `64eb431083e0a09124e6ba1d623b6f752cc67ccc` |
| firma | `verified=true`, `reason=valid` |
| CI post-merge | run `353`, `success` |
| migration | `42` |
| PR aperte al controllo | `0`, dato dinamico e non parte dell'identità del tree |

Decision record di origine:

- `FAI_CRM_N15_PHASE1B_PERSISTENCE_DECISION_READONLY_R01_COMPLETO.md`;
- `CONTENT_SHA256=ee8ce76bcc24e5844e1c3afdbf750c029bddd7aa56a51476c7f27170eb6b9223`;
- marker `N15_PHASE1B_PERSISTENCE_DECISION_READY_FOR_HUMAN_APPROVAL`;
- approvazione umana esplicita dell'Opzione C con riuso delle sole primitive pure B.

## Contesto

ADR-0013 definisce `fai.communication-intent.v1` come contratto puro, outbound, reference-only e
fail-closed. Phase 1A non contiene persistenza, adapter N11, route, action, producer, consumer,
worker, provider o activation. L'intento resta `RECORDED`; la sola decisione concettuale ammessa è
separata e porta a `HELD`.

N11 è invece un backbone durable specifico per N10:

- contratto `fai.lead-event.v1` e tipo `LEAD_SUBMITTED` hard-bound nel parser e nei CHECK DB;
- lifecycle `AVAILABLE -> LEASED -> PROCESSED/PUBLISHED|DEAD_LETTER`;
- attempt, lease, heartbeat, fencing, retry e recovery specifici del dominio lead;
- dipendenze downstream N12, N13 e N14 su `BusinessInboxEvent`.

N11 e N15 differiscono per direzione, identity, idempotenza, lifecycle, terminalità, privacy e
retention. Inserire N15 nelle tabelle N11 esporrebbe inoltre una applicazione N−1 a righe che il
parser lead non può verificare.

`PracticeCommunication` resta un record editoriale/manuale. Il marker manuale
`usata_inviata` non prova dispatch o delivery. `AuditLog` resta un audit applicativo generico e
non diventa lo store audit tecnico autorevole N15.

## Decisione approvata: boundary dedicato N15

Il futuro storage N15, se autorizzato da un mandato successivo, dovrà essere fisicamente e
semanticamente separato da N11. N15 possiederà il proprio aggregate e le proprie invarianti.

Sono vincolanti:

1. nessuna riga N15 in `BusinessInboxEvent`, `BusinessOutboxEvent` o
   `BusinessQueueAttempt`;
2. nessun adapter, mirror, inbox fittizia o dual-write verso N11;
3. nessun uso di `PracticeCommunication` o `AuditLog` come fonte autorevole dell'intento o del
   lifecycle N15;
4. nessuna reinterpretazione di `PUBLISHED` come `SENT` o `DELIVERED`;
5. nessun `tenantId`, workspace o isolamento organizzativo inventato;
6. nessuna registrazione futura interpretata come autorizzazione di dispatch.

Il boundary approvato non sceglie ancora nomi fisici, colonne, indici, constraint, trigger o SQL.

## Aggregate logico futuro

La forma concettuale raccomandata, ancora non implementata, contiene tre record N15 distinti:

| Record | Responsabilità | Vincolo concettuale |
| --- | --- | --- |
| intent | envelope canonico N15 | immutabile e sempre `RECORDED` |
| held decision | risultato di policy/gate | separata dall'envelope, `RECORDED -> HELD` |
| audit tecnico N15 | store/ledger tecnico autorevole con projection minimizzata | allowlist, hash-linked e legata a intent/decisione |

Su una nuova admission i tre record dovranno essere indivisibili in una sola transazione locale.
Un replay coerente dovrà restituire l'identità durable originaria senza creare una nuova decisione
o un nuovo audit.

Gli hash e i futuri record hash potranno offrire soltanto tamper-evidence applicativa entro un
threat model approvato. Non costituiranno automaticamente storage WORM, firma, timestamp
qualificato, non-ripudio, consenso, dispatch o delivery.

## Atomicità e causa business

Una futura API di admission N15 dovrà supportare un seam transaction-scoped adattato al dominio
N15:

- se causa business e N15 risiedono nella stessa banca dati/transazione, causa, intent, decisione
  e audit committano o eseguono rollback insieme;
- il seam è un pattern transazionale, non codice o ownership N11 condivisi;
- nessun dual-write best-effort è ammesso;
- se la causa è esterna o già committata, serve prima una fonte durable e un adapter separato;
- non si dichiara exactly-once distribuito.

Il tipo dell'API, il clock, il repository e la transaction boundary concreta restano
`OPEN_IMPLEMENTATION_GATE`.

## Idempotenza e collisioni

La semantica Phase 1A resta invariata:

| Caso | Requisito architetturale futuro |
| --- | --- |
| chiave assente nello storage | candidato `NEW` |
| stesso `keyDigest` e stesso `semanticHash` | `REPLAY` dell'identità originaria |
| stesso `keyDigest` e `semanticHash` diverso | `CONFLICT`, nessuna mutazione |
| chiavi diverse e stessa semantica | due `NEW` semanticamente ammissibili |
| aggregate incompleto o hash incoerente | integrity failure fail-closed, mai replay |

`semanticHash` e `businessCorrelationId` non sono candidati a unique globale. `keyDigest` include
già `producerCode`, ma il producer dovrà essere ricavato o verificato da una autorità interna
attendibile e non semplicemente accettato dal caller.

La collisione storage-level di `intentId`, lo scope organizzativo fisico delle unique e la scelta
single-org/multi-org restano `OPEN_HUMAN_DECISION`. La raccomandazione Phase 1B è fail-closed:
un `intentId` già legato a un aggregate divergente dovrebbe produrre `CONFLICT`, ma questa regola
deve essere confermata nel mandato che autorizzerà lo storage. Nessun `tenantId` viene anticipato
per rappresentarne lo scope.

## Riuso delle sole primitive pure B

Una primitiva può essere condivisa tra N11 e N15 soltanto se è contemporaneamente:

- deterministica;
- priva di I/O, ambiente, clock, random e database;
- domain-neutral;
- compatibile con i golden byte/hash già approvati;
- priva di ownership N10/N11 o lifecycle business.

`canonicalJson` e `sha256` esistenti soddisfano oggi questi criteri. Non li modifica questa ADR.

Non sono primitive pure condivisibili nel perimetro corrente:

- parser e identity N10;
- API, verifier, record hash e query N11;
- tabelle inbox/outbox/attempt;
- claim, lease, heartbeat, fencing, CAS, retry, recovery e dead-letter;
- lifecycle e retention lead;
- il seam transaction-scoped, che resta un pattern da adattare per dominio.

L'eventuale estrazione futura di primitive queue richiede prima un contratto N15 post-HELD
dispatchable, characterization N11, parity completa e una PR separata. Se la parity non è
dimostrabile, i domini restano dedicati.

## Lifecycle e terminalità

Per il contratto v1:

- l'envelope dell'intento resta immutabilmente `RECORDED`;
- `HELD` è una decisione separata e terminale per il lifecycle autorizzato;
- lo stato effettivo deriva dalla decisione, non da una mutazione dell'envelope;
- non esistono `AVAILABLE`, `READY`, `QUEUED`, `LEASED`, `ATTEMPTED`, `SENT`, `DELIVERED` o
  redrive;
- non esistono queue, attempt, lease, retry, DLQ, worker o scheduler N15;
- terminalità non significa conservazione perpetua: retention, legal hold e purge restano aperti.

Qualunque stato post-HELD richiede un nuovo contratto versionato e una nuova autorizzazione.

## Privacy, audit, retention e isolamento

Lo stato acquisito resta:

- purpose placeholder `N15_PHASE1A_UNASSIGNED`;
- legal-basis marker `DPO_VALIDATION_REQUIRED`, che non è una base giuridica;
- recipient reference-only `{authorityCode, entityType, entityId}`, senza endpoint snapshot;
- hash deterministici e linkabili, non anonimizzazione;
- audit allowlist privo di body, recapito, endpoint e secret;
- tenant gate off, senza modello tenant/workspace approvato.

Restano `OPEN_HUMAN_DECISION` prima di dati business o call-site:

1. purpose e base giuridica per classe/causa;
2. retention, start event, legal hold, DSAR, purge/anonymization e propagazione a backup,
   repliche, export, log e restore;
3. recipient resolver, tipi ammessi, soft-delete e autorizzazione;
4. isolamento organizzativo e scope fisico delle unique;
5. authority del `producerCode`;
6. clock authority;
7. template registry e versioning;
8. eventuale projection accessoria minimizzata in `AuditLog`.
9. owner e mappa delle cause business e dei primi eventuali producer;
10. permessi N15 e segregazione dei ruoli.

Legal e DPO sono gate della governance interna; questa ADR non attribuisce al DPO una decisione
gestionale né formula un obbligo giuridico universale.

## Compatibilità N−1, migration, rollback e forward repair

I seguenti punti sono requisiti per una futura fase, non autorizzazione a implementarli:

- migration soltanto additiva, transazionale e vuota;
- nessun DML, backfill, seed business, gate o modifica N11;
- applicazione N−1 capace di ignorare i nuovi oggetti in dormancy;
- nuova applicazione su schema vecchio fail-closed, senza fallback su N11,
  `PracticeCommunication` o `AuditLog`;
- mixed fleet senza producer attivi;
- rollback applicativo che lascia schema e righe intatti;
- nessun down migration ordinario con righe presenti;
- riparazioni soltanto tramite forward repair versionato;
- qualification fresh, upgrade dalla baseline autorizzata, N−1, mixed-fleet, fault injection e
  multiprocess sotto un mandato successivo.

Phase 1C non crea alcuna migration e lascia il catalogo a 42.

## Alternative

### A — generalizzazione N11

Respinta. Parser, CHECK, identity, idempotenza, lifecycle, retention e query di claim sono
lead-specific; il blast radius comprende N12–N14 e la compatibilità N−1 non è preservata da una
semplice colonna discriminator.

### B — primitive comuni, domini separati

Accettata soltanto per le primitive pure definite sopra. L'estrazione di queue/lease/attempt è
differita perché N15 non possiede un lifecycle dispatchable.

### C — persistenza N15 dedicata

Accettata come boundary futuro, non implementata.

### D — contract-only

Resta lo stato operativo corrente fino alle autorizzazioni successive.

La migliore obiezione a C è il rischio di duplicare in futuro un secondo motore queue. La
mitigazione vincolante è non introdurre alcuna queue ora e rivalutare B soltanto dopo un contratto
post-HELD approvato.

## Finding F1 N13→N14 indipendente

Il tree contiene un mismatch preesistente: il percorso N14 `BUSINESS_PROJECTION_N13` cerca
`fai.lead-submitted.v1`, mentre N10/N11/N13 usano `fai.lead-event.v1`. Il finding resta un blocker
del percorso quando coesistono N14 `enforced`, policy SLA `ACTIVE` ed enrollment automatico dalla
projection N13.

Phase 1C non corregge F1. La remediation richiede codice, nuova migration correttiva e test
end-to-end sintetici in un change indipendente e non autorizzato da questa ADR.

## Perimetro escluso

Questa ADR e la relativa guard non autorizzano:

- modifiche sotto `src`;
- Prisma, SQL, schema, migration, seed o accesso DB;
- repository/service, transaction adapter o record hash N15;
- route, action, producer, consumer, worker, scheduler o cron;
- N11 adapter, queue, attempt, lease, retry, DLQ o redrive;
- channel, provider, endpoint, body, webhook, secret, egress o receipt;
- destinatari o dati business reali;
- modifica dei gate Phase 1A;
- correzione F1 nello stesso change;
- deploy, produzione o activation;
- integrazione dei 16 agenti FAI;
- merge senza autorizzazione umana separata e vincolata all'head qualificato.

## Qualification e guard Phase 1C

La PR Phase 1C deve dimostrare:

- ADR-0013 e i golden Phase 1A invariati;
- manifest ancora `CONTRACT_ONLY`, `persistence=NONE`, `n11Adapter=NONE`,
  `activation=NONE`;
- nessun import o call-site N15 sotto il runtime;
- nessun riferimento persistente N15 in Prisma e migration ancora 42;
- nessuna modifica a N11–N14 o al finding F1;
- diff limitato a questa ADR e a una characterization/static guard test-only;
- test, lint, typecheck, build e CI verdi;
- review indipendente sul head esatto;
- Draft PR senza merge.

## Conseguenze

Positive:

- ownership N11/N15 non ambigua;
- compatibilità N−1 futura plausibile e qualificabile;
- lifecycle Phase 1A preservato senza capability premature;
- privacy, audit e retention separabili per dominio;
- possibile riuso futuro senza accoppiare oggi i motori.

Negative:

- il requisito durable resta non implementato;
- molte decisioni umane impediscono ancora dati business e call-site;
- una futura foundation richiederà nuovi oggetti, constraint e test sotto un mandato separato;
- il rischio di duplicazione queue deve essere rivalutato prima di qualunque stato post-HELD.

## Rollback Phase 1C

Il rollback della sola Phase 1C è il revert dell'ADR e della guard test-only. Non esistono schema,
righe, backlog, runtime, configurazioni o sistemi esterni da riparare. Nessun down migration è
applicabile.

## Riferimenti

- `docs/adr/ADR-0013-n15-communication-intent-contract-only-foundation-v1.md`;
- `docs/n15-communication-backbone-contract-only-foundation-v1.md`;
- `docs/n11-durable-business-inbox-outbox-backbone-v1.md`;
- `src/lib/communication-backbone-contract.ts`;
- `src/lib/canonical-json.ts`;
- `src/lib/business-event-backbone.ts`;
- `tests/communication-backbone-contract.test.ts`;
- migration N11 `20260820120000_durable_business_inbox_outbox_backbone_v1`.
