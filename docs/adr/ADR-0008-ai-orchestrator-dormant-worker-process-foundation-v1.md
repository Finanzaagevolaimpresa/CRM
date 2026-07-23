# ADR-0008 — AI Orchestrator Dormant Worker Process Foundation v1

- Stato: Accettato; fondazione presente in `main` dalla PR #81
- Data: 2026-07-22
- Dipendenze: ADR-0003, ADR-0005, ADR-0006, ADR-0007

## Contesto

La Worker Runtime Foundation PR76 definisce primitive Prisma per admission, claim, lease, fencing, retry e recovery ma, per decisione esplicita, non installa un processo. Il Mock Handler Registry PR78 resta invocabile soltanto in modo diretto e non è collegato al runtime. Il Control Plane e la UI PR79–PR80 persistono e mostrano policy `desired`, mentre lo stato `effective` rimane chiuso da `FOUNDATION_LOCKED_V1`.

Prima di collegare admission e claim serve un confine di processo verificabile: lifecycle, timer, identità, heartbeat e shutdown. Introdurlo insieme al consumo della coda renderebbe più difficile dimostrare che il processo non possiede ancora autorità operativa.

## Decisione

Introduciamo un entrypoint TypeScript manuale con modulo import-safe e lifecycle esclusivo `DORMANT -> DRAINING -> STOPPED`.

Il modulo:

- usa un manifesto canonico `FOUNDATION_LOCKED_V1`, hashato e immutabile;
- genera internamente un UUID v4 per invocazione;
- valida quattro gate environment con confronto letterale;
- rifiuta `AI_ORCHESTRATOR_WORKER_ENABLED=1` e valori ambigui;
- usa un solo timeout abortibile, polling locale no-work 5s + jitter 0–20% e heartbeat 30s;
- scrive JSONL minimizzato soltanto mentre è `DORMANT`;
- gestisce `SIGTERM` e `SIGINT` senza `process.exit()` nei signal handler;
- non importa né chiama runtime, queue, handler, database, provider o Control Plane.

L'entrypoint viene incluso nel pacchetto, ma non viene collegato a `npm start`, Docker Compose, systemd, cron o reconciler.

## Non-authority

Questa decisione non autorizza:

- attivazione worker, state machine o dispatch;
- admission, claim, lease, heartbeat DB, retry, recovery o backpressure;
- esecuzione del registry mock;
- persistenza di result o artifact;
- provider esterni, OpenAI, rete o dati CRM reali;
- un nuovo container production;
- modifica di policy `effective`, capability o barriera PostgreSQL;
- merge, deploy o invocazione manuale sul VPS senza autorizzazione separata.

## Alternative escluse

### Loop dentro Next.js

Rifiutato: mescola lifecycle web e worker, rende ambiguo il drain e può duplicare timer tra repliche.

### Servizio Compose, systemd o cron già in PR81

Rifiutato: trasformerebbe una fondazione di processo in un'installazione operativa prima di admission e osservabilità.

### Import della Worker Runtime Foundation

Rifiutato: `worker-runtime.ts` importa Prisma e offre API operative. Anche senza chiamarle amplierebbe inutilmente il confine di dipendenza e il rischio di accesso DB.

### Polling di tabelle o heartbeat persistito

Rifiutato: appartiene ai blocchi successivi e richiede gate DB, lease/fencing e osservabilità non presenti in PR81.

### Intervalli configurabili da environment

Rifiutato: introduce override non canonici e rende meno riproducibile il comportamento della foundation.

## Conseguenze

Positive:

- lifecycle e shutdown vengono collaudati isolatamente;
- il pacchetto dimostra di poter ospitare un processo senza attivarlo;
- timer, output e configurazione hanno una superficie piccola e auditabile;
- PR82 potrà integrare admission/claim senza ridefinire la disciplina del processo.

Limiti:

- l'heartbeat stdout non rappresenta readiness DB o capacità di eseguire job;
- il build hash identifica il manifesto, non l'immagine;
- nessun lavoro viene consumato o completato;
- metriche e health operativo restano fuori perimetro.

## Rollback

Non sono presenti schema, migration, seed o backfill. Il rollback ripristina l'immagine precedente lasciando database e ledger invariati. Nessuna operazione distruttiva è ammessa.
