# AI Orchestrator Dormant Worker Process Foundation v1

## Scopo

La PR81 aggiunge un entrypoint **manuale e rigidamente dormiente** per definire il lifecycle del futuro processo worker senza autorizzare esecuzione, dispatch o accesso a dati. Il processo resta sigillato dall'activation epoch immutabile `FOUNDATION_LOCKED_V1` e dichiara sempre `operational=false`.

La presenza dello script nel pacchetto applicativo non crea un servizio. `npm start` continua ad avviare esclusivamente Next.js; Docker Compose, systemd, cron e il reconciler AI esistente non avviano questo entrypoint.

## Confine di autorità

Il processo PR81:

- non importa Prisma, `worker-runtime.ts`, queue, workflow service, job planner, result/artifact contract o mock handler registry;
- non legge `DATABASE_URL`, credenziali, hostname, PID, argomenti CLI o environment non allowlisted;
- non accede a database, job, outbox, lease, attempt, result, artifact, `AiRun`, `AiOutput` o dati CRM;
- non usa rete, filesystem, child process, worker thread, provider, OpenAI o handler mock;
- non applica transizioni e non può oltrepassare `HUMAN_APPROVAL`;
- non consuma policy `desired` del Control Plane e non modifica setting runtime.

L'unico risultato del polling è la costante interna `NO_WORK_FOUNDATION_LOCKED`; non esiste una sorgente dati da interrogare.

## Configurazione exact-match

L'entrypoint seleziona esclusivamente quattro chiavi e non conserva né serializza i valori originali.

| Chiave | Valore ammesso | Comportamento |
|---|---|---|
| `AI_ORCHESTRATOR_WORKER_ENABLED` | assente oppure `0` | shell dormiente |
| `AI_ORCHESTRATOR_WORKER_ENABLED` | `1` | rifiuto `AI_DORMANT_WORKER_FOUNDATION_LOCKED` |
| `AI_ORCHESTRATOR_WORKER_ENABLED` | qualsiasi altro valore | rifiuto `AI_DORMANT_WORKER_GATE_INVALID` |
| `AI_PROVIDER` | assente oppure `mock` | mock-only |
| `AI_EXTERNAL_PROVIDERS_ENABLED` | assente oppure `false` | provider esterni spenti |
| `AI_ALLOWED_MODELS` | assente oppure stringa vuota | nessun modello autorizzato |

Confronti, maiuscole e spazi sono letterali: `true`, `01`, ` 0`, `0 `, `MOCK` e ` false` vengono rifiutati. Nessuna variabile permette di cambiare intervalli, identità, hash, lifecycle o activation epoch.

## Identità e manifesto

Ogni invocazione genera internamente un `workerInstanceId` UUID v4. Non deriva da hostname, PID, browser, CLI o environment.

`workerBuildHash` è lo SHA-256 canonico del manifesto versionato PR81. Il manifesto fissa lifecycle, intervalli, authority tutte false, provider `mock`, dati `synthetic` e polling senza datasource. Questo hash identifica il **contratto del processo**, non il commit Git, l'immagine Docker o una prova di provenance del binario.

## Lifecycle e scheduler

Il solo percorso ammesso è:

```text
DORMANT -> DRAINING -> STOPPED
```

Non esistono stati `READY`, `RUNNING`, `CLAIMING` o `LEASED`.

Il processo usa un solo timeout abortibile alla volta e non usa `setInterval`. Il prossimo risveglio è il minimo tra polling e heartbeat. Il polling parte da 5 secondi con jitter deterministico compreso tra 0% e 20%, calcolato da build hash, instance ID e sequenza. Il polling successivo viene pianificato soltanto dopo la conclusione del precedente, quindi non può sovrapporsi.

## Heartbeat JSONL

Il primo heartbeat viene scritto immediatamente; i successivi soltanto nello stato `DORMANT`, ogni 30 secondi. Ogni riga contiene esclusivamente:

- `schemaVersion`;
- `workerProcessVersion`;
- `workerInstanceId`;
- `workerBuildHash`;
- `state`, sempre `DORMANT` per un heartbeat;
- `sequence` monotona;
- `timestamp` UTC ISO-8601.

Non vengono scritti payload, motivazioni, environment, URL, errori grezzi, stack, segreti o dati cliente. Un errore di stdout chiude il processo fail-closed con un codice stabile e minimizzato su stderr.

## Shutdown

`SIGTERM` e `SIGINT` richiamano la stessa transizione idempotente:

1. `DORMANT -> DRAINING`;
2. abort del timeout pendente;
3. nessun nuovo heartbeat o polling;
4. rilascio dei listener;
5. `DRAINING -> STOPPED`.

Il signal handler non usa `process.exit()`. Un secondo segnale non crea una nuova transizione. Gli errori di configurazione, clock, timer o output impostano soltanto `process.exitCode=1` dopo la chiusura controllata.

## Packaging e uso operativo

Il comando incluso nell'immagine è:

```bash
npm run ai:orchestrator:worker
```

È un entrypoint di fondazione per test e sviluppo futuro. **Non eseguirlo manualmente sul VPS production.** La PR81 non aggiunge un servizio Compose, unità systemd, timer, cron, scheduler o modifica del `CMD` Docker.

## Verifiche

La suite copre:

- manifesto, hash e invarianti non operative;
- matrice environment exact-match;
- UUID, jitter, heartbeat e minimizzazione;
- import del modulo senza timer, log o letture environment;
- scheduler singolo, polling no-work e assenza di overlap;
- `SIGTERM`, `SIGINT`, doppio shutdown, stdout e timer failure;
- processo figlio con `DATABASE_URL` irraggiungibile;
- scansioni statiche contro DB, runtime, handler, rete e provider;
- packaging Docker isolato con `--network none` e gate `1` rifiutato.

Prisma, schema, seed e migration restano invariati a 29 migration.

## Rollout e rollback

Un eventuale deploy della sola immagine, da autorizzare separatamente, non deve avviare alcun nuovo processo. Verificare che siano presenti soltanto i container applicazione e PostgreSQL, che `npm start` resti Next.js e che i gate rimangano:

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

Il rollback è esclusivamente applicativo all'immagine PR80. Non esistono migration PR81 da annullare. Non usare down migration, `DROP`, `TRUNCATE`, reset, cancellazioni o modifiche del ledger.
