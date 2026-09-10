# N15 — Addendum R02: collegamento sintetico del self-claim

## Stato e perimetro

N15 resta **parziale e non attivato**. Questo addendum implementa il composition boundary
sintetico tra la presa in carico CRM e la persistenza dormiente introdotta da R01; la qualifica
PostgreSQL effimera resta pendente fino all'esito della CI sul candidato esatto. Non qualifica
purpose, base giuridica, retention, template reali, persone o dati reali e non abilita invio,
dispatch, egress, canali, provider, worker o cron.

L'unica causa ammessa è l'activity N14 `CLAIMED` con reason `SELF_CLAIM`, creata dall'entrypoint
`claimCommercialLeadInboxItem` dopo le rivalidazioni autoritative. Assign, unassign, enrollment,
first response, close, convert e reopen non sono producer N15.

## Autorità e dati minimizzati

Il producer interno è `CRM_N15_SYNTHETIC_SELF_CLAIM_V1`. Il destinatario è esclusivamente il
riferimento `CRM/USER` dell'attore già autorizzato; non esiste risoluzione di recapiti. Il template
è il riferimento sintetico versionato `CRM_SELF_CLAIM_SYNTHETIC_REFERENCE` / `n15-r02-v1` e il
reason è `CRM_LEAD_SELF_CLAIM_SYNTHETIC`. Il relativo hash deriva soltanto da codice e versione.
Non sono persistiti testo, body o contatti cliente.

L'UUID dell'activity è sia `intentId` sia parte della chiave di idempotenza; l'item UUID è la
correlazione business. Il timestamp dell'activity, assegnato da PostgreSQL nella transazione, è
l'autorità temporale dell'aggregate.

## Ammissione e dormienza

Il default è off. Il percorso è ammesso solo quando `APP_ENV` e `NODE_ENV` sono esplicitamente
`test` o `development`, l'opt-in vale esattamente `N15_SYNTHETIC_SELF_CLAIM_V1` e sono presenti
tutte le attestazioni dell'harness DB effimero (`RUN_DB_TESTS`, conferma distruttiva e sentinel).
La configurazione deve inoltre identificare PostgreSQL loopback e il database `fai_crm_test`.
Prima di qualsiasi mutazione N14, la medesima transazione verifica `CURRENT_DATABASE()` e il
commento reale del database; il solo nome/prefisso dello schema non costituisce attestazione.
Production, staging, valori assenti/sconosciuti e opt-in errati restano spenti. Nessun input HTTP
può fornire o modificare questi valori. Con il percorso spento il modulo di persistenza N15 non
viene caricato né interrogato e N14 conserva il comportamento precedente, incluso `N14_DISABLED`.

## Transazione, errori e secondo claim

Il wrapper N15 possiede la stessa transazione `Serializable` e conserva max-wait, timeout,
lock-timeout, statement-timeout e retry N14. Owner Lead, versione item, activity, audit N14 e trio
N15 `RECORDED`/`HELD`/audit vengono quindi committati o annullati insieme. Il latch N15 e la
verifica della constraint deferred restano nel callback prima del commit. Se lo schema N15 non è
presente, l'opt-in fallisce esplicitamente con `N15_SCHEMA_UNAVAILABLE` e annulla la causa; non
esiste fallback. Con il percorso spento lo schema N15 non è richiesto.

Un secondo claim conserva il conflitto di versione/ownership N14: non crea una seconda activity
né un aggregate. Un retry Serializable che segue un rollback può generare un nuovo UUID activity
nel tentativo successivo; al commit restano soltanto l'activity committata e l'aggregate la cui
chiave deriva da quella causa durable. `HELD` è terminale per questo perimetro e non rappresenta una coda
destinata a invio futuro.
