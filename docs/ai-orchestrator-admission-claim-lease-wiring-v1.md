# AI Orchestrator Admission, Claim & Lease Wiring Foundation v1

## Stato e autorizzazione

La PR82 è una **Draft PR**. Definisce e collauda un collegamento fail-closed tra
il processo PR81 e le primitive runtime PR76, ma non autorizza merge, deploy,
avvio sul VPS, esecuzione di job o attivazione di gate.

La configurazione production deve restare:

```text
AI_ORCHESTRATOR_WORKER_ENABLED=0
AI_PROVIDER=mock
AI_EXTERNAL_PROVIDERS_ENABLED=false
AI_ALLOWED_MODELS=
stateMachineEnabled=false
dispatchEnabled=false
syntheticDataOnly=true
externalProvidersEnabled=false
13 capability enabled=false
```

`canAcceptLease` è una costante `false` nella composizione production PR82. Non
esiste un lease consumer: admission e claim sono esercitati soltanto con
adapter sintetici nei test.

## Obiettivo

PR76 espone già admission idempotente, claim atomico, lease, heartbeat,
fencing, surrender, recovery e supersession. PR81 aggiunge il processo
dormiente, senza database. PR82 collega i due livelli senza duplicare schema o
algoritmi:

- un coordinatore puro, single-flight e con dipendenze iniettate;
- una facade runtime che espone solo le operazioni autorizzate;
- un'autorità Control Plane machine-safe e read-only;
- routing lazy del processo, così il gate `0` conserva integralmente il
  comportamento PR81 senza import Prisma o connessione database.

Il manifesto PR81 e il relativo hash non cambiano. PR82 ha un manifesto e un
`workerBuildHash` distinti; l'hash identifica il contratto versionato, non
l'immagine Docker.

## Routing e configurazione exact-match

| `AI_ORCHESTRATOR_WORKER_ENABLED` | Comportamento |
|---|---|
| assente oppure `0` | processo PR81 dormiente; nessun import Prisma e nessuna connessione database |
| `1` | validazione mock/synthetic, caricamento lazy della composizione PR82 e controllo dell'autorità |
| qualsiasi altro valore | arresto fail-closed con codice minimizzato |

Con gate `1`, `AI_PROVIDER` deve essere assente o `mock`,
`AI_EXTERNAL_PROVIDERS_ENABLED` assente o `false` e `AI_ALLOWED_MODELS`
assente o vuota. Maiuscole, spazi e valori equivalenti ma non letterali vengono
rifiutati. Nessuna variabile ambiente può abilitare `canAcceptLease`.

## Confine della facade

La facade PR82 importa le primitive PR76 e presenta al coordinatore soltanto:

1. lettura authority;
2. recovery di lease scadute;
3. supersession di runtime non più eleggibili;
4. admission bounded;
5. claim di al massimo una lease;
6. heartbeat fenced;
7. surrender;
8. disconnect Prisma.

Non espone `complete`, `fail`, payload, handler, result, artifact o transizioni
workflow. Il token di lease resta opaco in una `WeakMap`; non viene restituito,
serializzato, persistito in chiaro o scritto nei log. Heartbeat e surrender
sulla stessa lease sono serializzati; le chiamate surrender concorrenti
condividono una sola operazione e il coordinatore la invoca al massimo una volta.

## Autorità fail-closed

L'autorità machine-safe legge in una transazione PostgreSQL `READ ONLY`:

- l'intera catena delle 36 policy amministrative;
- setting Orchestrator e Control Plane;
- catalogo delle 13 capability;
- presenza della barriera fisica `dispatchEnabled=false`.

Le revisioni vengono ricalcolate e validate con il contratto PR79. La risposta
è sempre default-deny sotto `FOUNDATION_LOCKED_V1`: `operational=false`,
`databaseEligible=false`, `canAdmit=false`, `canClaim=false` e
`canHeartbeat=false`. L'API non richiede né simula un attore amministrativo e
non modifica ledger o setting.

## Ciclo, lease e drain

PR76 conserva recovery, supersession e surrender come primitive di riduzione
del rischio. La composizione PR82 applica tuttavia il vincolo più forte
`FOUNDATION_LOCKED_V1 = zero scritture`: authority positiva e
`canAcceptLease=true` precedono recovery, supersession, admission e claim.
Soltanto il surrender di una lease già posseduta resta disponibile durante il
drain quando l'autorità viene successivamente chiusa.

Il coordinatore esegue una sola operazione o attesa alla volta:

1. lettura authority;
2. verifica `canAcceptLease`;
3. recovery bounded;
4. supersession bounded;
5. admission bounded;
6. claim di al massimo una lease;
7. heartbeat periodico solo sulla lease corrente;
8. surrender una sola volta durante il drain;
9. disconnect una sola volta.

Nessuna transazione resta aperta durante polling, timer o callback. Se un claim
termina dopo la richiesta di drain, l'handle viene prima registrato e poi
surrenderato una sola volta. Una lease stale viene abbandonata definitivamente;
il tempo autorevole e il fencing restano quelli PostgreSQL di PR76.

## Esclusioni vincolanti

PR82 non:

- invoca il mock handler registry;
- legge payload o dati CRM reali;
- persiste result, artifact, `AiRun` o `AiOutput`;
- completa o fallisce job;
- applica transizioni della state machine;
- effettua HTTP, DNS, socket, OpenAI o altre chiamate provider;
- aggiunge route, UI, cron, systemd, timer o servizio Compose;
- modifica `npm start`, il `CMD` Docker o i servizi `app` e `postgres`;
- modifica schema Prisma, seed o migration.

Il repository resta a **29 migration**. La suite positiva usa esclusivamente
fixture sintetiche e PostgreSQL effimero.

## Logging e gestione errori

I log possono contenere soltanto codici chiusi, versione processo, sequenze e
identificatori tecnici minimizzati. Sono vietati payload, dati CRM, token o hash
di lease, connection string, environment, query/errori PostgreSQL grezzi,
stack trace, URL, prompt, secret e metadata provider.

Errori di configurazione, authority negata, lease stale, database non
disponibile e violazioni di invarianti vengono convertiti in codici stabili.
Gli errori PostgreSQL transienti classificati sono ritentati nell'adapter per
un massimo di tre tentativi complessivi con backoff breve e jitter
deterministico; l'esaurimento produce
`AI_WORKER_WIRING_DB_TRANSIENT_EXHAUSTED`. Un database indisponibile arresta il
processo con `AI_WORKER_WIRING_DB_UNAVAILABLE`. Un errore sconosciuto è sempre
fatal e fail-closed; non esiste un retry infinito.

## Verifiche CI e Docker

La CI esegue lint, Prisma validate/generate, unit test, test PostgreSQL,
typecheck, build, 29 migration, seed ripetuto, `git diff --check`, sintassi
shell e smoke Docker. Un gate `npm audit --omit=dev` rifiuta package o advisory
oltre le sole eccezioni transitive e temporanee registrate sotto.

Lo smoke Docker usa soltanto risorse `fai-crm-smoke-*` effimere e verifica:

- servizi Compose esattamente `app` e `postgres`, senza worker automatico;
- migration e seed prima dell'avvio applicativo;
- `/api/health` con database raggiungibile;
- `/_next/image` chiuso con HTTP 404;
- gate `0` con `--network none` e database irraggiungibile;
- gate `1` collegato al solo PostgreSQL effimero, vivo oltre un ciclo bounded,
  arrestato con `SIGTERM` ed exit `0`, con snapshot invariato di setting,
  ledger, queue, runtime, result, artifact, `AiRun` e `AiOutput`;
- cleanup esclusivo delle risorse create dallo smoke.

## Eccezioni dipendenze con scadenza

Next.js è fissato alla patch `15.5.21`, che rimuove le advisory dirette presenti
nella precedente `15.5.19`. `npm audit --omit=dev` continua a riportare due
dipendenze transitive senza upgrade compatibile disponibile nel ramo Next 15:

| Dipendenza | Advisory | Rischio e mitigazione | Owner | Riesame |
|---|---|---|---|---|
| `sharp@0.34.5` | `GHSA-f88m-g3jw-g9cj` (high) | il repository non usa `next/image`; `images.unoptimized=true` chiude `/_next/image` prima dell'optimizer e lo smoke richiede HTTP 404 | FAI Engineering | 2026-08-31 |
| `postcss@8.4.31` annidato in Next | `GHSA-qx2v-qp2m-jg93` (moderate) | viene usato soltanto in build su CSS versionato e trusted; nessun CSS utente viene serializzato | FAI Engineering | 2026-08-31 |

Queste eccezioni sono temporanee, non autorizzano un deploy e devono essere
rimosse appena esiste un aggiornamento compatibile. Non usare
`npm audit fix --force`; al riesame aggiornare lockfile in modo mirato,
rieseguire l'audit completo e rivalutare la reachability.

## Rollout e rollback

La Draft PR non autorizza rollout. Un eventuale deploy futuro richiede
approvazione separata e deve lasciare gate `0`, due soli servizi Compose e
nessun processo worker.

Poiché PR82 non introduce migration, il rollback ordinario è esclusivamente
applicativo all'immagine PR81:

```text
fai-crm:pr81-39ed9040ba83
```

Non eseguire down migration, `DROP`, `TRUNCATE`, reset, restore o cancellazioni.
Lasciare database, 29 migration, ledger, job, outbox, runtime e artifact
intatti, quindi verificare `/api/health`, login, flussi CRM e processo PR81
dormiente con gate `0`.
