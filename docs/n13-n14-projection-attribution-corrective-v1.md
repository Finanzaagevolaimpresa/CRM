# N13→N14 Projection Attribution Corrective v1

## Stato

```text
N13_N14_ATTRIBUTION_CORRECTIVE_STATUS=SOURCE_IMPLEMENTED_DORMANT_NOT_DEPLOYED
N13_N14_ATTRIBUTION_CORRECTIVE_SCOPE=F1_F2_ONLY
N13_N14_ATTRIBUTION_CANONICAL_SCHEMA_VERSION=fai.lead-event.v1
N13_N14_ATTRIBUTION_SOURCE_LIMITS=120_120_80
N13_N14_ATTRIBUTION_CURRENT_MIGRATIONS=43
N13_N14_ATTRIBUTION_DATA_CHANGE=NONE
N13_N14_ATTRIBUTION_BACKFILL=NONE
N13_N14_ATTRIBUTION_ACTIVATION=NONE
N13_N14_ATTRIBUTION_DIRECT_SQL_PROVENANCE_BINDING=KNOWN_LIMITATION_OUT_OF_SCOPE
N13_N14_ATTRIBUTION_F3=KNOWN_LIMITATION_OUT_OF_SCOPE
```

Questo corrective allinea il boundary di attribution tra N13 e N14 senza attivarlo. Non modifica
mode, policy, seed, dati business, worker, scheduler, provider, dispatch o egress.

## F1 — schema version canonica

N10, N11 e N13 usano il contratto `fai.lead-event.v1`. La prima implementazione N14 conteneva
invece `fai.lead-submitted.v1` sia nella query applicativa sia nella funzione DB
`n14_guard_item`.

La correzione:

- riusa `LEAD_EVENT_SCHEMA_VERSION` nella query applicativa, senza duplicare un literal;
- aggiorna la definizione live di `n14_guard_item` tramite una migration forward-only;
- non accetta alias e non modifica N10, N11 o N13;
- conserva la migration 42 byte-identica, incluso il literal storico errato.

## F2 — provenance 120/120/80

Il contratto N10 pubblicato ammette:

- `source.systemCode`: 120 caratteri;
- `source.formCode`: 120 caratteri;
- `source.formVersion`: 80 caratteri.

N11 e N13 conservano questi valori integralmente. N14 era invece limitato a `80/80/40`. Il
corrective amplia soltanto le tre colonne `CommercialLeadInboxItem` e il relativo CHECK a
`120/120/80`; lo schema Prisma è allineato agli stessi limiti. Non esegue truncation,
normalizzazione aggiuntiva, DML o backfill.

## Migration 43

La migration
`20260826150000_n13_n14_projection_attribution_corrective_v1` è:

- transazionale e forward-only;
- business-empty;
- protetta da lock e timeout espliciti;
- vincolata all'identità della migration 42, dei tipi, del CHECK, del trigger e della funzione
  live attesi;
- fail-closed su drift o lock contention;
- verificata tramite postcondizioni su tipi, CHECK, funzione e trigger.

La migration 42
`20260823160000_commercial_lead_inbox_attribution_sla_v1` resta immutata con SHA-256:

`fc94e1bf2c659b68baf708d38cf7f3aa4c6b9e653a89330be5ca754bcfeab7aa`.

Non esiste down-migration. Un eventuale rollback futuro è soltanto applicativo, con tutti i gate
dormant; lo schema ampliato resta in sede e qualunque riparazione è forward-only.

Un fallimento operativo della migration per drift, lock timeout o altra precondizione è una
condizione di STOP: lo schema resta transazionalmente invariato, ma Prisma può lasciare il tentativo
43 non concluso in `_prisma_migrations`. Prima di qualunque retry futuro occorre verificare lo stato
fisico contro la baseline DB42, conservare l'evidenza dell'errore e, con autorizzazione operativa
separata, marcare il solo tentativo fallito come rolled back tramite la procedura controllata
`prisma migrate resolve --rolled-back`. Questo documento non autorizza tale operazione.

## Compatibility matrix

| Applicazione | DB42 | DB43 |
| --- | --- | --- |
| applicazione precedente | baseline storica; F1 fail-closed | health/read compatibili in dormancy; F1 ancora fail-closed lato app |
| applicazione corretta | F1 rifiutato dal trigger storico e F2 limitato dal vecchio schema | combinazione qualificata per i positivi sintetici N13→N14 |

Un eventuale rilascio futuro deve essere migration-first e mantenere N12/N13/N14 e la policy SLA
non attivi durante mixed fleet e rollback. Questo documento non autorizza deploy, migration
operativa, produzione o activation.

## Qualification

La qualification richiede:

- static binding della costante canonica in app e funzione live;
- boundary N10 `120/120/80` e rifiuto `121/121/81`;
- E2E sintetico `PROJECTED_NEW` fino a item/ciclo/activity/audit N14;
- E2E sintetico `REVIEW_REQUIRED → CREATE_NEW → RESOLVED_NEW`;
- gate disabled e assenza di policy active senza side effect N14;
- replay/stale decision senza secondo item;
- fresh43 e upgrade esatto DB42→DB43 con sentinelli preservati;
- drift precondition e lock contention con rollback totale;
- applicazione precedente su DB43 in dormancy;
- regression, lint, typecheck, build, smoke Docker e restore drill.

I test che impostano `COMMERCIAL_LEAD_INBOX_MODE=enforced` e una policy `ACTIVE` lo fanno soltanto
in database PostgreSQL effimeri, con dati sintetici e teardown. Default, seed e configurazioni di
rilascio restano disabilitati.

## Limite residuo: binding provenance per writer SQL diretti

Il servizio applicativo deriva `sourceSystem`, `formCode`, `formVersion` e `sourceOccurredAt` dalla
sorgente autorevole. Il guard DB N14 verifica il riferimento a ledger o receipt, ma non confronta
ancora ciascuno di questi quattro valori con la relativa sorgente. L'esposizione effettiva dipende
dai grant dei ruoli applicativi e non viene assunta. Il limite è preesistente, non è ampliato da
F1+F2 e resta fuori scope: prima di qualunque activation servono verifica dei grant e una decisione
separata sull'eventuale binding DB.

## Limite residuo F3

L'anno ISO `0000` accettato da N10 e conservato testualmente da N11 attraversa downstream
`Date`/`TIMESTAMPTZ`, che non offrono automaticamente la stessa semantica astronomica. F3 resta
fuori scope e richiede una qualification e una decisione di contratto separate. Il corrective
F1+F2 non dichiara compatibilità temporale completa e non autorizza activation.

N13_N14_ATTRIBUTION_CORRECTIVE_SOURCE_COMPLETE
